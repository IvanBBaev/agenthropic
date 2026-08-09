/**
 * WP-IN3 - the authed loopback hook receiver. Registered on the REAL
 * buildServer instance so the global /api/* auth gate is proven to cover it
 * (401 without a token), then: 202 shape, idempotent duplicate delivery,
 * accept-any-event storage, and redaction before persistence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryEventStore, type EventStorePort } from '@agenthropic/shared';
import { SqliteEventStore } from '../src/db/event-store';
import {
  HOOK_DELIVERY_ID_HEADER,
  HOOK_EVENT_PATH,
  MAX_DELIVERY_ID_LENGTH,
  readDeliveryId,
  registerHookRoutes,
} from '../src/hooks/routes';
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

/**
 * WP-IN3 delivery identity. A `Stop` hook body is byte-identical on every turn
 * of a session, so content hashing alone silently merges turn 2 into turn 1.
 * The sender therefore stamps each firing with `X-Agenthropic-Delivery-Id` and
 * reuses that id across its own retries; the header is key material only and is
 * never persisted or echoed.
 */
describe('POST /api/hooks/event delivery identity (WP-IN3)', () => {
  let app: FastifyInstance;
  let store: InMemoryEventStore;
  let clock: Date;

  /** Verbatim Claude Code `Stop` stdin - identical on every turn. */
  const STOP_BODY = {
    session_id: 'session-1',
    transcript_path: '/tmp/session-1.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };

  const post = async (deliveryId?: string) =>
    app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: STOP_BODY,
      headers: deliveryId === undefined ? AUTH : { ...AUTH, [HOOK_DELIVERY_ID_HEADER]: deliveryId },
    });

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

  it('two turns of an identical Stop body with distinct delivery ids both store', async () => {
    const turnOne = await post('delivery-1');
    expect(turnOne.json()).toEqual({ stored: true });

    clock = new Date('2026-07-18T10:05:00.000Z');
    const turnTwo = await post('delivery-2');
    expect(turnTwo.statusCode).toBe(202);
    expect(turnTwo.json()).toEqual({ stored: true });
    expect(store.readAll()).toHaveLength(2);
  });

  it('a retry that reuses the same delivery id still dedupes', async () => {
    expect((await post('delivery-1')).json()).toEqual({ stored: true });
    clock = new Date('2026-07-18T10:00:02.000Z');
    expect((await post('delivery-1')).json()).toEqual({ stored: false });
    expect(store.readAll()).toHaveLength(1);
  });

  it('the delivery id is key material only: never persisted or echoed', async () => {
    const response = await post('delivery-secret-marker');
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ stored: true });
    expect(JSON.stringify(store.readAll())).not.toContain('delivery-secret-marker');
    expect(response.headers[HOOK_DELIVERY_ID_HEADER]).toBeUndefined();
  });

  it('an empty delivery id is treated as absent (conservative collapse)', async () => {
    expect((await post('')).json()).toEqual({ stored: true });
    clock = new Date('2026-07-18T10:05:00.000Z');
    expect((await post('')).json()).toEqual({ stored: false });
    expect(store.readAll()).toHaveLength(1);
  });

  it('an over-long delivery id is a 400 that stores nothing and does not echo it', async () => {
    const oversized = 'z'.repeat(MAX_DELIVERY_ID_LENGTH + 1);
    const response = await post(oversized);
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(oversized);
    expect(store.readAll()).toHaveLength(0);
  });

  it('a delivery id exactly at the limit is accepted', async () => {
    const atLimit = 'z'.repeat(MAX_DELIVERY_ID_LENGTH);
    expect((await post(atLimit)).statusCode).toBe(202);
    expect(store.readAll()).toHaveLength(1);
  });
});

/**
 * WP-IN12 crash-retry recovery. The sender retries exactly when it cannot know
 * whether the first attempt finished. If a crash fell between the committed
 * append and the status write, the retry's append dedupes to zero rows - and
 * the liveness seam must STILL fire, or the terminal status is lost forever.
 * (That the seam is a guarded no-op on a true duplicate is pinned separately
 * in status-lifecycle.test.ts.)
 */
describe('POST /api/hooks/event applyStatus seam (WP-IN12)', () => {
  it('fires even for a redelivery whose append deduped to zero rows', async () => {
    const calls: Array<{ hookName: string; payload: unknown }> = [];
    // A store that reports every append as already-present: exactly the state
    // a crash between the committed append and the status write leaves behind.
    const dedupingStore: EventStorePort = {
      append: () => ({ inserted: false }),
      readAll: () => [],
    };
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, {
      eventStore: dedupingStore,
      now: () => FIXED_NOW,
      applyStatus: (hookName, payload) => {
        calls.push({ hookName, payload });
      },
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOOK_EVENT_PATH,
        payload: HOOK_BODY,
        headers: AUTH,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ stored: false });
      expect(calls).toEqual([{ hookName: 'SubagentStop', payload: HOOK_BODY }]);
    } finally {
      await app.close();
    }
  });

  it('a thrown append skips the seam: nothing landed, nothing to say', async () => {
    const calls: unknown[] = [];
    const failingStore: EventStorePort = {
      append: () => {
        throw new Error('disk full');
      },
      readAll: () => [],
    };
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, {
      eventStore: failingStore,
      now: () => FIXED_NOW,
      applyStatus: (hookName) => {
        calls.push(hookName);
      },
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOOK_EVENT_PATH,
        payload: HOOK_BODY,
        headers: AUTH,
      });
      expect(response.statusCode).toBe(500);
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('readDeliveryId', () => {
  it('takes a non-empty string and rejects everything ambiguous', () => {
    expect(readDeliveryId('delivery-1')).toBe('delivery-1');
    expect(readDeliveryId('')).toBeUndefined();
    expect(readDeliveryId(undefined)).toBeUndefined();
    // A header sent twice arrives as an array: ambiguous means ABSENT, never a
    // guess about which firing it names.
    expect(readDeliveryId(['a', 'b'])).toBeUndefined();
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

  it('two turns of a byte-identical Stop body land two rows in BOTH tables', async () => {
    // The WP-D5 liveness timeline must show both turns; before delivery ids the
    // second turn hashed to the first key and wrote zero rows in both tables.
    const stopBody = {
      session_id: 'session-1',
      transcript_path: '/tmp/session-1.jsonl',
      cwd: '/tmp/project',
      hook_event_name: 'Stop',
      stop_hook_active: false,
    };
    for (const deliveryId of ['turn-1', 'turn-2']) {
      const response = await app.inject({
        method: 'POST',
        url: HOOK_EVENT_PATH,
        payload: stopBody,
        headers: { ...AUTH, [HOOK_DELIVERY_ID_HEADER]: deliveryId },
      });
      expect(response.json()).toEqual({ stored: true });
    }
    const raw = temp.db.prepare('SELECT COUNT(*) AS n FROM events_raw').get() as { n: number };
    const projected = temp.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(raw.n).toBe(2);
    expect(projected.n).toBe(2);
    // CD-1: liveness only - the delivery id never becomes structure.
    const payloads = temp.db.prepare('SELECT payload FROM events_raw').all() as {
      payload: string;
    }[];
    expect(payloads.every((row) => !row.payload.includes('turn-'))).toBe(true);
  });
});
