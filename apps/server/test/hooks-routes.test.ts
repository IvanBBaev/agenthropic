/**
 * WP-IN3 - the authed loopback hook receiver. Registered on the REAL
 * buildServer instance so the global /api/* auth gate is proven to cover it
 * (401 without a token), then: 202 shape, idempotent duplicate delivery,
 * accept-any-event storage, and redaction before persistence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryEventStore } from '@agenthropic/shared';
import { SqliteEventStore } from '../src/db/event-store';
import { HOOK_EVENT_PATH, registerHookRoutes } from '../src/hooks/routes';
import { REDACTED } from '../src/hooks/redact';
import { buildServer } from '../src/server';
import { TEST_TOKEN, createMigratedTempDb, type TempDb } from './helpers';

const FIXED_NOW = new Date('2026-07-18T10:00:00.000Z');
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

const HOOK_BODY = {
  hook_event_name: 'SubagentStop',
  session_id: 'session-1',
  transcript_path: '/tmp/session-1.jsonl',
};

describe('POST /api/hooks/event (WP-IN3)', () => {
  let app: FastifyInstance;
  let store: InMemoryEventStore;
  let clock: Date;

  beforeEach(async () => {
    store = new InMemoryEventStore();
    clock = FIXED_NOW;
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, { eventStore: store, now: () => clock });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('is covered by the global auth gate: 401 without a token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: HOOK_BODY,
    });
    expect(response.statusCode).toBe(401);
    expect(store.readAll()).toHaveLength(0);
  });

  it('401 with a wrong token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: HOOK_BODY,
      headers: { authorization: 'Bearer wrong-token-000000000000' },
    });
    expect(response.statusCode).toBe(401);
    expect(store.readAll()).toHaveLength(0);
  });

  it('202 { stored: true } and one events_raw row on first delivery', async () => {
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: HOOK_BODY,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ stored: true });

    const rows = store.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'hook',
      eventType: 'SubagentStop',
      receivedAt: FIXED_NOW.toISOString(),
      payload: HOOK_BODY,
    });
    expect(rows[0]?.idempotencyKey).toMatch(/^hook:sha256:[0-9a-f]{64}$/);
  });

  it('duplicate delivery -> 202 { stored: false } and zero new rows, even later', async () => {
    const first = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: HOOK_BODY,
      headers: AUTH,
    });
    expect(first.json()).toEqual({ stored: true });

    // Same event redelivered 5 seconds later: receivedAt differs, key does not.
    clock = new Date('2026-07-18T10:00:05.000Z');
    const second = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: HOOK_BODY,
      headers: AUTH,
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ stored: false });
    expect(store.readAll()).toHaveLength(1);
  });

  it('accept-any-event: unknown hook names and extra fields are stored, not crashed on', async () => {
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: { hook_event_name: 'TotallyNewHook', brand_new_field: { deep: [1, 2] } },
      headers: AUTH,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ stored: true });
    expect(store.readAll()[0]).toMatchObject({
      eventType: 'TotallyNewHook',
      payload: { hook_event_name: 'TotallyNewHook', brand_new_field: { deep: [1, 2] } },
    });
  });

  it('accept-any-event: a non-object body is stored under "unknown"', async () => {
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: [1, 2, 3],
      headers: AUTH,
    });
    expect(response.statusCode).toBe(202);
    expect(store.readAll()[0]).toMatchObject({ eventType: 'unknown', payload: [1, 2, 3] });
  });

  it('redacts before persistence: no secret survives into the store', async () => {
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-1',
        api_key: 'sk-ant-api03-supersecretvalue',
        prompt: 'my key is sk-ant-api03-supersecretvalue',
        nested: { authorization: 'Bearer abc.def.ghi' },
      },
      headers: AUTH,
    });
    expect(response.statusCode).toBe(202);

    const serialized = JSON.stringify(store.readAll());
    expect(serialized).not.toContain('supersecretvalue');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(store.readAll()[0]?.payload).toMatchObject({
      api_key: REDACTED,
      prompt: `my key is ${REDACTED}`,
      nested: { authorization: REDACTED },
    });
  });

  it('malformed JSON gets a 4xx error, and the server keeps serving', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: '{not json',
      headers: { ...AUTH, 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(bad.statusCode).toBeLessThan(500);
    expect(store.readAll()).toHaveLength(0);

    const good = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: HOOK_BODY,
      headers: AUTH,
    });
    expect(good.statusCode).toBe(202);
    expect(store.readAll()).toHaveLength(1);
  });
});

describe('POST /api/hooks/event against the real SQLite store (WP-IN3/WP-IN2)', () => {
  let temp: TempDb;
  let app: FastifyInstance;

  beforeEach(async () => {
    temp = createMigratedTempDb();
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, { eventStore: new SqliteEventStore(temp.db) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    temp.cleanup();
  });

  it('duplicate POST inserts exactly one events_raw row', async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: HOOK_EVENT_PATH,
        payload: HOOK_BODY,
        headers: AUTH,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ stored: i === 0 });
    }
    const count = temp.db.prepare('SELECT COUNT(*) AS n FROM events_raw').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
