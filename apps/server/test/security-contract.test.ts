/**
 * WP-F7 - the security-invariant contract tests. These boot the REAL server
 * (composition root: config -> WAL SQLite -> migrations -> Fastify listen)
 * and assert the non-negotiables:
 *
 *   loopback-only bind - mandatory token - timing-safe 401s -
 *   same-origin-only SSE - no token, no start.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { start, type RunningServer } from '../src/index';
import { TEST_TOKEN } from './helpers';

describe('security contract (WP-F7)', () => {
  let dir: string;
  let server: RunningServer;
  let baseUrl: string;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-contract-'));
    server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'data', 'agenthropic.db'),
    });
    const address = server.app.addresses()[0];
    if (address === undefined) {
      throw new Error('server reported no bound addresses');
    }
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('(1) binds 127.0.0.1 and nothing else', () => {
    const addresses = server.app.addresses();
    expect(addresses.length).toBeGreaterThan(0);
    for (const entry of addresses) {
      expect(entry.address).toBe('127.0.0.1');
    }
  });

  it('(2) /api/health without a token is 401', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(401);
  });

  it('(3) /api/health with a wrong token is 401', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: 'Bearer definitely-not-the-token-1234' },
    });
    expect(response.status).toBe(401);

    // A wrong token of a DIFFERENT length must behave identically (the
    // timing-safe compare hashes to fixed length first).
    const shortToken = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: 'Bearer x' },
    });
    expect(shortToken.status).toBe(401);
  });

  it('(4) /api/health with the correct Bearer token is 200', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; schemaVersion: number };
    expect(body.status).toBe('ok');
    expect(body.schemaVersion).toBeGreaterThan(0);
  });

  it('(5) /api/stream with a foreign Origin is 403, token or not', async () => {
    const withToken = await fetch(`${baseUrl}/api/stream?token=${TEST_TOKEN}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(withToken.status).toBe(403);

    const withoutToken = await fetch(`${baseUrl}/api/stream`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(withoutToken.status).toBe(403);
  });

  it('(6) /api/stream same-origin with ?token= streams text/event-stream', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream?token=${TEST_TOKEN}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const { value } = await reader!.read();
    const firstBytes = new TextDecoder().decode(value);
    expect(firstBytes).toContain('retry:');
    controller.abort();
  });

  it('(6b) /api/stream also accepts http://localhost origins', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream?token=${TEST_TOKEN}`, {
      headers: { origin: `http://localhost:${port}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();
  });

  it('(6c) /api/stream with a same-origin header but no/wrong token is 401', async () => {
    const noToken = await fetch(`${baseUrl}/api/stream`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(noToken.status).toBe(401);

    const wrongToken = await fetch(`${baseUrl}/api/stream?token=wrong-token-000000`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(wrongToken.status).toBe(401);
  });

  it('(6d) a percent-encoded /api path cannot bypass the auth gate', async () => {
    // find-my-way percent-decodes the path before route matching; the auth
    // hook must gate on the routed path, not the raw URL. `/%61pi/health`
    // decodes to `/api/health`, so it must still be 401 without a token.
    const health = await fetch(`${baseUrl}/%61pi/health`);
    expect(health.status).toBe(401);

    // ...and the encoded stream path must still enforce same-origin (403),
    // not fall through unauthenticated.
    const stream = await fetch(`${baseUrl}/%61pi/stream`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(stream.status).toBe(403);

    const encodedStream = await fetch(`${baseUrl}/api/%73tream?token=${TEST_TOKEN}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(encodedStream.status).toBe(403);
  });

  it('(7) constructing config without DASHBOARD_TOKEN throws - the server cannot start', () => {
    expect(() => loadConfig({})).toThrow(/DASHBOARD_TOKEN/);
    expect(() => loadConfig({ DASHBOARD_TOKEN: undefined })).toThrow(/DASHBOARD_TOKEN/);
  });

  it('non-stream /api routes never accept the query token', async () => {
    const response = await fetch(`${baseUrl}/api/health?token=${TEST_TOKEN}`);
    expect(response.status).toBe(401);
  });

  it('the 401 body never echoes the token', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: 'Bearer nope-nope-nope-nope' },
    });
    const text = await response.text();
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain('nope-nope-nope-nope');
  });
});
