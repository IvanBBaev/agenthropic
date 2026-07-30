/**
 * WP-D5 reader - GET /api/sessions/:id/events against a real migrated
 * temp-file database whose `events` rows were written through the PRODUCTION
 * projection path (SqliteEventStore.append), never seeded directly.
 *
 * The facts under test: auth gating, the 404-vs-empty-200 distinction (an
 * unknown session is not the same fact as a session with zero hook events),
 * deterministic oldest-first ordering with the id tiebreaker, the capped
 * pagination idiom, the 'receipt' time-source honesty flag, and that no
 * payload content beyond the identifiers ever reaches the response.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { SqliteEventStore } from '../src/db/event-store';
import { createMigratedTempDb, insertSession, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

const SECRET_TEXT = 'super-secret-prompt-text-never-served';

describe('GET /api/sessions/:id/events (WP-D5)', () => {
  let temp: TempDb;
  let app: FastifyInstance;

  beforeEach(async () => {
    temp = createMigratedTempDb();
    insertSession(temp.db, 'session-a');
    insertSession(temp.db, 'session-empty');

    const store = new SqliteEventStore(temp.db);
    // Two events sharing one receipt timestamp (id must break the tie), one
    // later event, one event carrying free text that must never be served,
    // and one event whose shape yields no session id (no timeline at all).
    const appends = [
      {
        idempotencyKey: 'hook:e1',
        eventType: 'PreToolUse',
        payload: { hook_event_name: 'PreToolUse', session_id: 'session-a', agent_id: 'agent-1' },
        receivedAt: '2026-07-11T10:00:00Z',
      },
      {
        idempotencyKey: 'hook:e2',
        eventType: 'PostToolUse',
        payload: { hook_event_name: 'PostToolUse', session_id: 'session-a', prompt: SECRET_TEXT },
        receivedAt: '2026-07-11T10:00:00Z',
      },
      {
        idempotencyKey: 'hook:e3',
        eventType: 'Stop',
        payload: { hook_event_name: 'Stop', session_id: 'session-a' },
        receivedAt: '2026-07-11T11:00:00Z',
      },
      {
        idempotencyKey: 'hook:no-session',
        eventType: 'unknown',
        payload: ['not', 'an', 'object'],
        receivedAt: '2026-07-11T09:00:00Z',
      },
    ] as const;
    for (const event of appends) {
      expect(store.append({ ...event, source: 'hook' })).toEqual({ inserted: true });
    }

    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    temp.cleanup();
  });

  it('is auth-gated like every /api route (401 without a token)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions/session-a/events' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized.' });
  });

  it('404s (uniform error shape) for an unknown session id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/nope/events',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Session not found.' });
  });

  it('a known session with zero hook events is a 200 with an empty list, NOT a 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-empty/events',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionId: 'session-empty',
      events: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it('serves the timeline oldest-first, id as tiebreaker, occurredAtSource=receipt', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-a/events',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sessionId).toBe('session-a');
    expect(body.total).toBe(3);

    const [first, second, third] = body.events;
    // Equal timestamps: insert order (id) keeps the order stable.
    expect(first.eventType).toBe('PreToolUse');
    expect(second.eventType).toBe('PostToolUse');
    expect(third.eventType).toBe('Stop');
    expect(first.id).toBeLessThan(second.id);

    expect(first).toEqual({
      id: first.id,
      rawEventId: first.rawEventId,
      agentId: 'agent-1',
      eventType: 'PreToolUse',
      occurredAt: '2026-07-11T10:00:00Z',
      occurredAtSource: 'receipt',
    });
    expect(second.agentId).toBeNull(); // no agent id in that payload
    // Every occurredAt is receipt time and says so.
    for (const event of body.events) {
      expect(event.occurredAtSource).toBe('receipt');
    }
  });

  it('never serves payload content - only the projected identifiers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-a/events',
      headers: AUTH,
    });
    expect(response.body).not.toContain(SECRET_TEXT);
    expect(response.body).not.toContain('prompt');
    // The DTO is closed: exactly these keys, nothing else leaks through.
    for (const event of response.json().events) {
      expect(Object.keys(event).sort()).toEqual([
        'agentId',
        'eventType',
        'id',
        'occurredAt',
        'occurredAtSource',
        'rawEventId',
      ]);
    }
  });

  it('paginates with the shared capped idiom and keeps total honest', async () => {
    const page = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-a/events?limit=1&offset=1',
      headers: AUTH,
    });
    expect(page.statusCode).toBe(200);
    const body = page.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('PostToolUse');
    expect(body).toMatchObject({ total: 3, limit: 1, offset: 1 });

    const overCap = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-a/events?limit=1000',
      headers: AUTH,
    });
    expect(overCap.statusCode).toBe(400);
    expect(overCap.json().error).toContain('limit');
  });

  it('an event without an extractable session id belongs to NO session timeline', async () => {
    const rows = temp.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id IS NULL')
      .get() as { n: number };
    expect(rows.n).toBe(1); // projected, honest NULL - but never served here
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-a/events',
      headers: AUTH,
    });
    expect(response.json().total).toBe(3);
  });
});
