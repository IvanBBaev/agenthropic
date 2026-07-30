/**
 * WP-X4 negative-test catalogue — hook-receiver scenarios over the real
 * Fastify server (in-process inject) and a real migrated SQLite db.
 *
 * Catalogue of record: docs/site/contributing/testing.md section 5 / 5.1:
 *
 *   #1 duplicate hook event      -> zero new rows, no double count
 *   #2 SubagentStop before Start -> raw stored; watchdog 'unknown' is honest
 *   #4 malformed JSON (HTTP)     -> 400, no DB mutation
 *   #5 unauthenticated POST      -> 401, no raw event stored
 *   #6 invalid-token timing      -> timing-safe compare, no leaky errors
 *   #9 huge payload (HTTP)       -> 413, no DB mutation
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timingSafeTokenEqual } from '@agenthropic/shared';
import {
  buildServer,
  HOOK_EVENT_PATH,
  isTerminalAgentStatus,
  registerHookRoutes,
  runWatchdogSweep,
  SqliteEventStore,
} from '../../src/index';
import {
  createMigratedTempDb,
  insertAgent,
  insertSession,
  TEST_TOKEN,
  type TempDb,
} from '../helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

describe('WP-X4 hook-receiver negative catalogue', () => {
  let tmp: TempDb;
  let app: FastifyInstance;
  /** Mutable receipt clock: proves dedup is INDEPENDENT of receivedAt. */
  let nowIso = '2026-07-11T10:00:00.000Z';

  beforeAll(async () => {
    tmp = createMigratedTempDb();
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, {
      eventStore: new SqliteEventStore(tmp.db),
      now: () => new Date(nowIso),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  function countEvents(): number {
    return (tmp.db.prepare('SELECT COUNT(*) AS n FROM events_raw').get() as { n: number }).n;
  }

  // --- Scenario #1 — duplicate hook event -----------------------------------
  // Catalogue: "no duplicate normalized event or double token total" — CD-2
  // (idempotency-keyed events_raw), NFR-DATA-02, P0 double-replay proof. The
  // no-double-token-total facet lives in ingest-restart.negative.test.ts.
  it('Scenario #1 — a redelivered hook event inserts ZERO new rows (CD-2, NFR-DATA-02)', async () => {
    const body = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-negative-dup',
      tool_name: 'Bash',
    };
    const before = countEvents();

    nowIso = '2026-07-11T10:00:00.000Z';
    const first = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      headers: AUTH,
      payload: body,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ stored: true });

    // A LATER receipt time must not defeat the dedup: the idempotency key is
    // computed over the canonicalized envelope MINUS receivedAt.
    nowIso = '2026-07-11T10:05:00.000Z';
    const replayed = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      headers: AUTH,
      payload: body,
    });
    expect(replayed.statusCode).toBe(202);
    expect(replayed.json()).toEqual({ stored: false });

    expect(countEvents()).toBe(before + 1);
  });

  // --- Scenario #2 — SubagentStop before SubagentStart ----------------------
  // Catalogue: "raw event stored; anomaly flagged; edge uncertain" — CD-2,
  // CD-3, WP-IN12, OPEN-2. Current honest posture: the raw event is stored
  // verbatim (hooks are a secondary signal; there is no hook normalizer yet),
  // and the anomaly surfaces through the WP-IN12 watchdog as the visible
  // 'unknown' status. Edge uncertainty (inferred vs observed `source`) is
  // proved in packages/core/test/negative (scenario #11).
  it('Scenario #2 — SubagentStop with no prior Start is STORED, never crashed on (CD-2, WP-IN12)', async () => {
    const before = countEvents();
    const stopFirst = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      headers: AUTH,
      payload: {
        hook_event_name: 'SubagentStop',
        session_id: 'sess-negative-stop-first',
        agent_id: 'feedbeef',
      },
    });
    expect(stopFirst.statusCode).toBe(202);
    expect(stopFirst.json()).toEqual({ stored: true });

    // An event type the server has never heard of is stored too (the Phase-2
    // exit gate: accept-and-store, never crash).
    const unknownType = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      headers: AUTH,
      payload: { hook_event_name: 'SomeFutureHook', novel_field: { deeply: ['nested'] } },
    });
    expect(unknownType.statusCode).toBe(202);
    expect(unknownType.json()).toEqual({ stored: true });

    expect(countEvents()).toBe(before + 2);
    const types = tmp.db
      .prepare('SELECT event_type FROM events_raw ORDER BY id')
      .all()
      .map((row) => (row as { event_type: string }).event_type);
    expect(types).toContain('SubagentStop');
    expect(types).toContain('SomeFutureHook');
  });

  it("Scenario #2 — an agent whose Stop never arrived becomes the HONEST 'unknown' (WP-IN12, OPEN-2)", () => {
    insertSession(tmp.db, 'sess-negative-watchdog');
    insertAgent(tmp.db, 'agent-neg-stale-01', 'sess-negative-watchdog'); // 'working', 2026-07-11 stamps

    const transitions = runWatchdogSweep(tmp.db, Date.now(), 10 * 60_000);
    expect(transitions).toContainEqual({
      type: 'agent-status-changed',
      agentId: 'agent-neg-stale-01',
      sessionId: 'sess-negative-watchdog',
      oldStatus: 'working',
      newStatus: 'unknown',
    });

    // OPEN-2 resolved: the schema CHECK accepts 'unknown' as a first-class,
    // visible state — not a crash, not a fake 'completed'.
    const row = tmp.db
      .prepare('SELECT status FROM agents WHERE id = ?')
      .get('agent-neg-stale-01') as { status: string };
    expect(row.status).toBe('unknown');
    expect(isTerminalAgentStatus('unknown')).toBe(true);
  });

  // --- Scenario #4 — malformed JSON (HTTP facet) ----------------------------
  // Catalogue: "400; no DB mutation" — CD-2, FR-01. Distinct from the
  // accept-and-store posture above: a syntactically broken BODY is rejected;
  // an unknown but well-formed EVENT TYPE is stored.
  it('Scenario #4 — malformed JSON body is 400 with ZERO db mutation (CD-2, FR-01)', async () => {
    const before = countEvents();
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '{"hook_event_name": "PostToolUse", "broken": ',
    });
    expect(response.statusCode).toBe(400);
    expect(countEvents()).toBe(before);
  });

  // --- Scenario #5 — unauthenticated POST -----------------------------------
  // Catalogue: "401/403; no raw event stored" — CD-7, NFR-SEC-02. (The
  // companion "server fails startup without DASHBOARD_TOKEN" assertion lives
  // in security-stream.negative.test.ts — one CD-7 control, three assertions.)
  it('Scenario #5 — unauthenticated POST is 401 and stores NOTHING (CD-7, NFR-SEC-02)', async () => {
    const before = countEvents();
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      payload: { hook_event_name: 'PreToolUse', session_id: 'sess-negative-unauth' },
    });
    expect(response.statusCode).toBe(401);
    expect(countEvents()).toBe(before);
  });

  // --- Scenario #6 — invalid-token timing attack ----------------------------
  // Catalogue: "timing-safe compare; no differentiated error message" — CD-7,
  // NFR-SEC-02. HTTP-observable part: wrong tokens of ANY length produce the
  // IDENTICAL status and body (no oracle); the constant-time property itself
  // is asserted on the shared primitive the gate uses.
  it('Scenario #6 — wrong tokens of any length yield one indistinguishable 401 (CD-7, NFR-SEC-02)', async () => {
    const before = countEvents();
    const presented = [
      'x', // far too short
      'a'.repeat(TEST_TOKEN.length), // right length, wrong bytes
      `${TEST_TOKEN.slice(0, -1)}X`, // one byte off
      `${TEST_TOKEN}-suffix`, // right prefix, too long
    ];
    const responses = [];
    for (const token of presented) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: HOOK_EVENT_PATH,
          headers: { authorization: `Bearer ${token}` },
          payload: { hook_event_name: 'PreToolUse' },
        }),
      );
    }
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe(responses[0]?.body); // no differentiated error
      expect(response.body).not.toContain(TEST_TOKEN);
    }
    for (const [index, token] of presented.entries()) {
      expect(responses[index]?.body).not.toContain(token);
    }
    expect(countEvents()).toBe(before);
  });

  it('Scenario #6 — the gate primitive compares timing-safe across lengths', () => {
    // Different lengths must return false WITHOUT throwing (the compare
    // hashes both sides to fixed length first — no length oracle).
    expect(timingSafeTokenEqual(TEST_TOKEN, 'x')).toBe(false);
    expect(timingSafeTokenEqual(TEST_TOKEN, `${TEST_TOKEN}-suffix`)).toBe(false);
    expect(timingSafeTokenEqual(TEST_TOKEN, `${TEST_TOKEN.slice(0, -1)}X`)).toBe(false);
    expect(timingSafeTokenEqual(TEST_TOKEN, TEST_TOKEN)).toBe(true);
  });

  // --- Scenario #9 — huge payload (HTTP facet) ------------------------------
  // Catalogue: "rejected or truncated per policy; no UI lockup" — CD-10,
  // NFR-PERF-01. Policy: Fastify's default 1 MiB bodyLimit rejects with 413
  // before parsing; nothing reaches the store. The corpus-side oversize-file
  // policy is proved in ingest-restart.negative.test.ts.
  it('Scenario #9 — a >1 MiB hook body is 413 with ZERO db mutation (CD-10, NFR-PERF-01)', async () => {
    const before = countEvents();
    const response = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      headers: AUTH,
      payload: { hook_event_name: 'PreToolUse', blob: 'x'.repeat(1_100_000) },
    });
    expect(response.statusCode).toBe(413);
    expect(countEvents()).toBe(before);
  });
});
