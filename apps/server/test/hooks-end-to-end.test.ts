/**
 * WP-X8 end-to-end smoke (added 2026-09-26): "Install → working end-to-end hook →
 * loopback ingest → `events_raw`". Until now the installer was unit-tested
 * (`hooks-installer.test.ts`: command string, settings merge, file workflow) and
 * the receiver was tested with hand-written requests (`hooks-routes.test.ts`), but
 * nothing proved that the request the INSTALLED command sends is one the receiver
 * accepts and persists - the two could drift apart (path, header name, auth
 * scheme, content type) with both suites green.
 *
 * The generated command is not executed: running curl would need a subprocess,
 * which the no-spawner gate forbids in tests without an audited exemption.
 * Instead the command STRING is the source of the request - method, URL, the
 * content-type and delivery-id header names and the token variable are all read
 * out of it - and that request is replayed with `fetch` against the real server
 * listening on loopback, backed by the real SQLite event store. So a change to
 * the installer's endpoint, headers or auth wiring fails here even though no
 * hand-written constant in this file changed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildHookCommand, buildHooksConfig } from '../../../hooks/install.mjs';
import { SqliteEventStore } from '../src/db/event-store';
import { registerHookRoutes } from '../src/hooks/routes';
import { buildServer } from '../src/server';
import { TEST_TOKEN, createMigratedTempDb, type TempDb } from './helpers';

interface ParsedHookRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly tokenEnv: string;
}

/** Read the HTTP request out of a generated hook command, failing loudly on drift. */
function parseHookCommand(command: string, tokenValue: string): ParsedHookRequest {
  const method = /--request\s+(\w+)/.exec(command)?.[1];
  const url = /'(http:\/\/[^']+)'/.exec(command)?.[1];
  const tokenEnv = /--variable\s+'%(\w+)'/.exec(command)?.[1];
  const auth = /--expand-header\s+'Authorization: Bearer \{\{(\w+)\}\}'/.exec(command)?.[1];
  const contentType = /--header\s+'Content-Type: ([^']+)'/.exec(command)?.[1];
  const deliveryHeader = /--header\s+"([\w-]+): [^"]+"/.exec(command)?.[1];
  expect({ method, url, tokenEnv, auth, contentType, deliveryHeader }).toEqual({
    method: expect.any(String),
    url: expect.any(String),
    tokenEnv: expect.any(String),
    auth: tokenEnv,
    contentType: expect.any(String),
    deliveryHeader: expect.any(String),
  });
  // The body arrives on stdin (`--data-binary @-`): what Claude Code pipes in.
  expect(command).toContain('--data-binary @-');
  return {
    method: method!,
    url: url!,
    tokenEnv: tokenEnv!,
    headers: {
      'content-type': contentType!,
      authorization: `Bearer ${tokenValue}`,
      [deliveryHeader!.toLowerCase()]: '4242-1790000000-7',
    },
  };
}

describe('hook end-to-end: installed command -> loopback receiver -> events_raw (WP-X8)', () => {
  let temp: TempDb | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    temp?.cleanup();
    app = undefined;
    temp = undefined;
  });

  async function listen(): Promise<number> {
    temp = createMigratedTempDb();
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, { eventStore: new SqliteEventStore(temp.db) });
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  it('the request every installed hook sends is accepted and lands in events_raw', async () => {
    const port = await listen();
    const config = buildHooksConfig({ port }) as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    const events = Object.keys(config);
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      const command = config[event]![0]!.hooks[0]!.command;
      // Every registered event is wired with the same generated command.
      expect(command).toBe(buildHookCommand({ port }));
      const request = parseHookCommand(command, TEST_TOKEN);
      expect(new URL(request.url).hostname).toBe('127.0.0.1');

      const stdin = JSON.stringify({ hook_event_name: event, session_id: `e2e-${event}` });
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: stdin,
      });
      expect(response.status, `${event}: ${await response.clone().text()}`).toBe(202);
      expect(await response.json()).toEqual({ stored: true });
    }

    const rows = temp!.db
      .prepare('SELECT source, event_type, payload FROM events_raw ORDER BY id')
      .all() as Array<{ source: string; event_type: string; payload: string }>;
    expect(rows.map((row) => row.event_type)).toEqual(events);
    for (const row of rows) {
      expect(row.source).toBe('hook');
      expect(JSON.parse(row.payload)).toEqual({
        hook_event_name: row.event_type,
        session_id: `e2e-${row.event_type}`,
      });
    }
  });

  it('the delivery id the command sends reaches the receiver: two firings, two rows', async () => {
    // Two hook firings with byte-identical stdin (a repeated Stop, say) are two
    // events only because the command stamps each with its own delivery id. If
    // the header the installer writes and the header the receiver reads ever
    // drift apart, both would dedupe into one row and an event would be lost -
    // with every other request in this file still accepted.
    const port = await listen();
    const request = parseHookCommand(buildHookCommand({ port }), TEST_TOKEN);
    const deliveryHeader = Object.keys(request.headers).find(
      (name) => name !== 'content-type' && name !== 'authorization',
    )!;
    const body = JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e-twice' });
    for (const id of ['101-1790000000-1', '102-1790000000-2']) {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers, [deliveryHeader]: id },
        body,
      });
      expect(await response.json()).toEqual({ stored: true });
    }
    expect(temp!.db.prepare('SELECT COUNT(*) AS n FROM events_raw').get()).toEqual({ n: 2 });
  });

  it('the same request without the token is refused and stores nothing', async () => {
    const port = await listen();
    const request = parseHookCommand(buildHookCommand({ port }), TEST_TOKEN);
    const headers = { ...request.headers };
    delete headers.authorization;
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e-noauth' }),
    });
    expect(response.status).toBe(401);
    expect(temp!.db.prepare('SELECT COUNT(*) AS n FROM events_raw').get()).toEqual({ n: 0 });
  });
});
