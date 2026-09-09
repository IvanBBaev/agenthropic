/**
 * P0 proof 4 (CD-10, the v1.0 exit gate in TODO.md): the FIVE DAILY QUESTIONS
 * are answerable over REAL HTTP.
 *
 * WHY THIS FILE EXISTS. The exit gate has ticked all five questions before, on
 * evidence assembled from server-side unit tests and UI unit tests separately.
 * That claim was overstated until 2026-08-07: a question stayed ticked while
 * its answer was reachable only by hand, with `curl`. Nothing in the suite
 * booted the server and asked it the five questions end to end. This file is
 * that missing mechanical proof:
 *
 *   1. the REAL fixture corpus is materialized on disk and ingested by the
 *      production `runCorpusIngest` - no hand-inserted rows anywhere;
 *   2. the REAL `buildServer` is booted over that database, with the hook
 *      receiver registered exactly the way the composition root (index.ts)
 *      registers it;
 *   3. every question is asked over HTTP through `app.inject`, with a real
 *      Bearer token, through the real routing + auth + serialization stack.
 *
 * A 200 IS NOT AN ANSWER. Every question below asserts that the payload
 * CONTAINS the answer - a named session, a real dollar figure, a real
 * parent->child edge with its persisted provenance, a real status. A 200
 * carrying an empty array FAILS here.
 *
 * THE STATUS CHOREOGRAPHY. Corpus ingest can only ever prove "activity
 * happened", so a freshly ingested corpus is uniformly 'working' and questions
 * 1 and 4 would both be answered by the same undifferentiated blob. So the
 * arrangement drives the two OTHER production status writers, in the order a
 * live server drives them:
 *
 *   - `runWatchdogSweep` at 2026-04-02T00:00:30Z with a 60s threshold. The
 *     seven January fixture sessions are ~2.5 months stale -> 'unknown' (the
 *     STUCK answer for Q4). The depth-2-sync session's three agents were last
 *     seen 25-29s earlier -> still 'working' (the RUNNING NOW answer for Q1).
 *   - two hook deliveries POSTed over HTTP to the real receiver: a
 *     `SubagentStop` for the grandchild agent -> 'completed', and a `Stop` for
 *     the main agent -> 'waiting'. These are the only terminal signals the
 *     system has (CD-1: hooks move liveness, never structure).
 *
 * THE MONEY QUESTION - WHAT THIS TEST DOES AND DOES NOT PIN. The dollar
 * figures are currently served through an UNRATIFIED change to
 * `api/queries.ts` (the M-19 `token_usage_rollup` reader cutover). This test
 * deliberately pins NO magic dollar constant: that would assert one candidate
 * implementation and would either break on a revert or silently canonise the
 * unratified path. It asserts the exit gate's actual criterion, which survives
 * either outcome - EVERY DISPLAYED DOLLAR TRACES TO GROUND-TRUTH TOKENS TIMES A
 * DATED PRICE - by re-deriving the whole summary here, in plain JS, straight
 * from `token_usage` + `model_pricing`, and never by reading the figure back
 * from the endpoint under test.
 *
 * SIGN AND FLOOR ARE ASSERTED SEPARATELY from that comparison, on purpose.
 * `CostTotalsSchema`'s `minimum: 0` does NOTHING at runtime: fast-json-stringify
 * serializes TO a schema, it does not validate AGAINST one, so a negative
 * figure would be served with a cheerful HTTP 200. A comparison-only test
 * passes if a sign error exists on both sides, so `tokens`, `costUsd` and
 * `unpricedTokens` are each asserted `>= 0` in their own right.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  ChangesDto,
  CostSummaryDto,
  GlobalDagDto,
  SessionChangeKind,
  SessionListDto,
  SessionTreeDto,
} from '@agenthropic/shared';
import { TERMINATED_EARLY_AGENT_ID, USER_INTERRUPT_AGENT_ID } from '@agenthropic/test-fixtures';
import {
  HOOK_EVENT_PATH,
  SqliteEventStore,
  applyHookLiveness,
  buildServer,
  currentSchemaVersion,
  loadPricing,
  registerHookRoutes,
  runCorpusIngest,
  runWatchdogSweep,
  type SqliteDatabase,
} from '../../src/index';
import { TEST_TOKEN } from '../helpers';
import {
  FIXED_NOW,
  allFixtures,
  corpusEnv,
  makeTempDir,
  materializeCorpus,
  openSeededDb,
} from './harness';

const INSTANCE = 'p0-proof-4';
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * The one session the choreography leaves LIVE (fixture `depth-2-sync`,
 * 2026-04-02). It is also the only fixture with a real two-level chain, which
 * is what makes it the subject of question 3.
 */
const LIVE_SESSION = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const LIVE_CHILD = 'd1d1a001';
const LIVE_GRANDCHILD = 'd2d2b002';

/** One of the seven January fixture sessions the watchdog ages to 'unknown'. */
const STUCK_SESSION = '11111111-2222-4333-8444-555555555555';

/**
 * The `agent-outcome-errors` fixture session (WP-U10): one January agent
 * terminated early -> `agents.status = 'error'` (the FAILED answer for Q4),
 * alongside a sibling a human interrupted -> ordinary liveness status, ages
 * to 'unknown' like every other January agent, never 'error'.
 */
const ERROR_SESSION = 'a9c0de00-1111-4222-8333-444444444444';

/**
 * The watchdog instant and window. 30 seconds after the live session's last
 * observed activity, with a 60s staleness window: the live session's agents
 * are inside it, every January agent is ~2.5 months outside it.
 */
const SWEEP_AT_MS = Date.parse('2026-04-02T00:00:30.000Z');
const SWEEP_THRESHOLD_MS = 60_000;

/** Every endpoint an answer below is read from, plus the hook receiver. */
const GUARDED_ENDPOINTS = [
  { method: 'GET' as const, url: '/api/sessions' },
  { method: 'GET' as const, url: `/api/sessions/${LIVE_SESSION}` },
  { method: 'GET' as const, url: `/api/sessions/${LIVE_SESSION}/tree` },
  { method: 'GET' as const, url: '/api/cost/summary' },
  { method: 'GET' as const, url: '/api/dag/global' },
  { method: 'GET' as const, url: '/api/changes?since=2026-01-01' },
  { method: 'POST' as const, url: HOOK_EVENT_PATH },
];

// --------------------------------------------------------------------------
// The independent re-derivation of every dollar, from ground truth only.
// --------------------------------------------------------------------------

interface LedgerRow {
  readonly session_id: string;
  readonly model: string;
  readonly bucket: string;
  readonly tokens: number;
  readonly occurred_at: string | null;
}

interface PriceRow {
  readonly model: string;
  readonly bucket: string;
  readonly usd_per_mtok: number;
  readonly effective_from: string;
}

interface Triple {
  tokens: number;
  costUsd: number;
  unpricedTokens: number;
}

/**
 * The dated-rate rule, re-implemented here rather than imported: the rate is
 * the LATEST `model_pricing` row for the exact (model, bucket) whose
 * `effective_from` is at or before the usage row's `occurred_at`. Null means
 * NO RATE WAS IN FORCE - those tokens are unpriced, contribute $0, and are
 * never guessed at.
 *
 * Both timestamps are compared as text because both columns are stored in the
 * single canonical spelling migrations 14/15 enforce (`YYYY-MM-DDTHH:mm:ss
 * .sssZ`), the one form in which lexicographic and chronological order
 * coincide. The values are read back out of the database rather than assumed,
 * so the canonicalizing triggers are part of what is being proved.
 */
function rateFor(prices: readonly PriceRow[], row: LedgerRow): number | null {
  if (row.occurred_at === null) {
    return null;
  }
  let winner: PriceRow | null = null;
  for (const price of prices) {
    if (price.model !== row.model || price.bucket !== row.bucket) {
      continue;
    }
    if (price.effective_from > row.occurred_at) {
      continue;
    }
    if (winner === null || price.effective_from > winner.effective_from) {
      winner = price;
    }
  }
  return winner === null ? null : winner.usd_per_mtok;
}

function emptyTriple(): Triple {
  return { tokens: 0, costUsd: 0, unpricedTokens: 0 };
}

function accumulate(into: Map<string, Triple>, key: string, tokens: number, rate: number | null) {
  const bucket = into.get(key) ?? emptyTriple();
  bucket.tokens += tokens;
  if (rate === null) {
    bucket.unpricedTokens += tokens;
  } else {
    bucket.costUsd += (tokens * rate) / 1_000_000;
  }
  into.set(key, bucket);
}

interface GroundTruth {
  readonly totals: Triple;
  readonly byModel: Map<string, Triple>;
  readonly byDay: Map<string, Triple>;
  readonly bySession: Map<string, Triple>;
}

/**
 * Re-derive the whole cost summary from the two ground-truth tables ONLY.
 *
 * This reads `token_usage` (the immutable ledger ingest wrote from the JSONL)
 * and `model_pricing`. It deliberately does NOT read `token_usage_rollup`: the
 * rollup is the projection the UNRATIFIED reader scans, and checking a reader
 * against its own input would prove nothing about whether the dollars trace to
 * ground truth.
 */
function recomputeFromGroundTruth(db: SqliteDatabase): GroundTruth {
  const ledger = db
    .prepare('SELECT session_id, model, bucket, tokens, occurred_at FROM token_usage')
    .all() as LedgerRow[];
  const prices = db
    .prepare('SELECT model, bucket, usd_per_mtok, effective_from FROM model_pricing')
    .all() as PriceRow[];

  const totals = emptyTriple();
  const byModel = new Map<string, Triple>();
  const byDay = new Map<string, Triple>();
  const bySession = new Map<string, Triple>();

  for (const row of ledger) {
    const rate = rateFor(prices, row);
    totals.tokens += row.tokens;
    if (rate === null) {
      totals.unpricedTokens += row.tokens;
    } else {
      totals.costUsd += (row.tokens * rate) / 1_000_000;
    }
    accumulate(byModel, row.model, row.tokens, rate);
    // The rollup's own day key: `substr(occurred_at, 1, 10)`, the literal
    // 'unknown' for a usage row that carries no timestamp.
    const day = row.occurred_at === null ? 'unknown' : row.occurred_at.slice(0, 10);
    accumulate(byDay, day, row.tokens, rate);
    accumulate(bySession, row.session_id, row.tokens, rate);
  }

  return { totals, byModel, byDay, bySession };
}

/**
 * Question 5's window, re-derived from ground truth ONLY - the same discipline
 * the money questions get, applied to the time axis.
 *
 * The re-derivation is deliberately a DIFFERENT implementation from the one
 * under test: the endpoint canonicalizes with SQLite's `strftime` and compares
 * text, this compares epoch milliseconds via `Date.parse`. Two implementations
 * that disagree about a boundary row will not agree here by accident, which is
 * the whole point - an off-by-one-boundary delta endpoint looks authoritative
 * while quietly dropping exactly the rows the operator came to see.
 */
interface DatedSession {
  readonly id: string;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
}

/** The instant a session is placed by: last activity, else its start. */
function sessionInstantMs(row: DatedSession): number {
  const key = row.last_activity_at ?? row.started_at;
  return key === null ? Number.NaN : Date.parse(key);
}

/** The ids the window `(since, until]` must contain, most recently first. */
function changedSessionsFromGroundTruth(
  db: SqliteDatabase,
  sinceMs: number,
  untilMs: number,
): string[] {
  const rows = db
    .prepare('SELECT id, started_at, last_activity_at FROM sessions')
    .all() as DatedSession[];
  return rows
    .map((row) => ({ id: row.id, ms: sessionInstantMs(row) }))
    .filter((row) => Number.isFinite(row.ms) && row.ms > sinceMs && row.ms <= untilMs)
    .sort((a, b) => (b.ms - a.ms !== 0 ? b.ms - a.ms : a.id.localeCompare(b.id)))
    .map((row) => row.id);
}

/**
 * The per-row `change` labels the window `(since, until]` must carry, keyed by
 * session id - re-derived here from `sessions` alone.
 *
 * The endpoint decides this in SQL, against canonicalized text; this decides it
 * in epoch milliseconds. `unknown` is reproduced as its own outcome rather than
 * folded into `updated`, because that distinction is the whole point of the
 * three-way label: a session with no parseable start cannot be said to have
 * begun inside the window OR before it.
 */
function changeKindsFromGroundTruth(
  db: SqliteDatabase,
  sinceMs: number,
  untilMs: number,
): Map<string, SessionChangeKind> {
  const rows = db
    .prepare('SELECT id, started_at, last_activity_at FROM sessions')
    .all() as DatedSession[];
  const kinds = new Map<string, SessionChangeKind>();
  for (const id of changedSessionsFromGroundTruth(db, sinceMs, untilMs)) {
    const row = rows.find((candidate) => candidate.id === id);
    const startedMs = row?.started_at === null ? Number.NaN : Date.parse(row?.started_at ?? '');
    kinds.set(
      id,
      !Number.isFinite(startedMs) ? 'unknown' : startedMs > sinceMs ? 'new' : 'updated',
    );
  }
  return kinds;
}

/**
 * A boundary that falls strictly INSIDE some session's life, derived from the
 * corpus rather than written down.
 *
 * WHY THIS EXISTS. Every fixture session is minutes long and they are spread
 * across two months, so both windows above happen to contain only sessions
 * that also STARTED inside them: every row is `new`, and `sessionsUpdated` is
 * 0 in both. That makes the `updated` arm of the endpoint's CASE - and the
 * counter beside it - unproduced, and an assertion that a number is 0 is
 * satisfied just as well by an implementation that can never emit it at all.
 * Splitting a session down the middle is the smallest change that gives the
 * label something to be wrong about.
 *
 * A hard-coded instant would do it too, and would rot the first time a fixture
 * moved. The midpoint is picked from the earliest session that measurably
 * spans time, so the choice is deterministic without being written down twice.
 */
function midLifeBoundaryMs(db: SqliteDatabase): number {
  const spans = (
    db.prepare('SELECT id, started_at, last_activity_at FROM sessions').all() as DatedSession[]
  )
    .map((row) => ({
      startedMs: row.started_at === null ? Number.NaN : Date.parse(row.started_at),
      endedMs: row.last_activity_at === null ? Number.NaN : Date.parse(row.last_activity_at),
    }))
    .filter((span) => Number.isFinite(span.startedMs) && span.endedMs > span.startedMs + 1)
    .sort((a, b) => a.startedMs - b.startedMs);
  const chosen = spans[0];
  expect(chosen, 'some fixture session measurably spans time').toBeDefined();
  return Math.floor(((chosen?.startedMs ?? 0) + (chosen?.endedMs ?? 0)) / 2);
}

/**
 * The newest instant the corpus can vouch for, across every table the changes
 * endpoint reads. This is what `until` must be: ingest lags event time, so a
 * wall-clock boundary would promise rows that have not arrived, and a caller
 * chaining `since=until` would step over them forever.
 */
function newestInstantFromGroundTruth(db: SqliteDatabase): number {
  const sessions = db
    .prepare('SELECT id, started_at, last_activity_at FROM sessions')
    .all() as DatedSession[];
  const agents = db.prepare('SELECT first_seen_at FROM agents').all() as ReadonlyArray<{
    readonly first_seen_at: string | null;
  }>;
  const usage = db.prepare('SELECT occurred_at FROM token_usage').all() as ReadonlyArray<{
    readonly occurred_at: string | null;
  }>;
  const candidates = [
    ...sessions.map(sessionInstantMs),
    ...agents.map((row) =>
      row.first_seen_at === null ? Number.NaN : Date.parse(row.first_seen_at),
    ),
    ...usage.map((row) => (row.occurred_at === null ? Number.NaN : Date.parse(row.occurred_at))),
  ].filter((ms) => Number.isFinite(ms));
  return Math.max(...candidates);
}

/** Tokens/dollars added inside `(since, until]`, from the ledger alone. */
function windowTripleFromGroundTruth(db: SqliteDatabase, sinceMs: number, untilMs: number): Triple {
  const ledger = db
    .prepare('SELECT session_id, model, bucket, tokens, occurred_at FROM token_usage')
    .all() as LedgerRow[];
  const prices = db
    .prepare('SELECT model, bucket, usd_per_mtok, effective_from FROM model_pricing')
    .all() as PriceRow[];
  const triple = emptyTriple();
  for (const row of ledger) {
    const ms = row.occurred_at === null ? Number.NaN : Date.parse(row.occurred_at);
    if (!Number.isFinite(ms) || ms <= sinceMs || ms > untilMs) {
      continue;
    }
    const rate = rateFor(prices, row);
    triple.tokens += row.tokens;
    if (rate === null) {
      triple.unpricedTokens += row.tokens;
    } else {
      triple.costUsd += (row.tokens * rate) / 1_000_000;
    }
  }
  return triple;
}

/**
 * The graph DTOs spell the same triple with a `totalTokens` key rather than
 * `tokens`; normalise so one set of sign/floor assertions covers every payload.
 */
function asTriple(row: {
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly unpricedTokens: number;
}): Triple {
  return { tokens: row.totalTokens, costUsd: row.costUsd, unpricedTokens: row.unpricedTokens };
}

/**
 * Sign and floor, asserted on their OWN - never as a by-product of comparing
 * two numbers that could both be wrong in the same direction. `minimum: 0` in
 * the response schema is decorative at runtime (fast-json-stringify serializes
 * to a schema, it does not validate against one), so this is the only thing
 * standing between a negative dollar figure and an HTTP 200.
 */
function expectNonNegative(triple: Triple, label: string): void {
  expect(Number.isInteger(triple.tokens), `${label}: tokens is an integer`).toBe(true);
  expect(Number.isInteger(triple.unpricedTokens), `${label}: unpricedTokens is an integer`).toBe(
    true,
  );
  expect(Number.isFinite(triple.costUsd), `${label}: costUsd is finite`).toBe(true);
  expect(triple.tokens, `${label}: tokens >= 0`).toBeGreaterThanOrEqual(0);
  expect(triple.costUsd, `${label}: costUsd >= 0`).toBeGreaterThanOrEqual(0);
  expect(triple.unpricedTokens, `${label}: unpricedTokens >= 0`).toBeGreaterThanOrEqual(0);
}

/**
 * The honest-uncertainty contract, independent of any implementation: tokens
 * that could not be priced are DISCLOSED as unpriced, never quietly served as
 * $0. So `unpricedTokens` is a subset of `tokens`; a row whose tokens are ALL
 * unpriced must report exactly $0; and a row with priced tokens must report a
 * dollar figure above zero (every rate in this corpus is strictly positive).
 */
function expectUnpricedDisclosed(triple: Triple, label: string): void {
  expect(triple.unpricedTokens, `${label}: unpricedTokens <= tokens`).toBeLessThanOrEqual(
    triple.tokens,
  );
  if (triple.unpricedTokens === triple.tokens) {
    expect(triple.costUsd, `${label}: fully unpriced => exactly $0`).toBe(0);
  } else {
    expect(triple.costUsd, `${label}: priced tokens => a dollar figure above zero`).toBeGreaterThan(
      0,
    );
  }
}

/**
 * Compare a served triple against the independently re-derived one. Token
 * counts are exact integers and must match exactly. Dollars are compared with
 * a tolerance rather than exactly ON PURPOSE: floating-point ADDITION ORDER
 * differs between any two groupings of the same terms, and pinning bit
 * equality here would silently canonise one implementation's accumulation
 * order - exactly what this test refuses to do.
 */
function expectMatchesGroundTruth(served: Triple, expected: Triple, label: string): void {
  expect(served.tokens, `${label}: tokens`).toBe(expected.tokens);
  expect(served.unpricedTokens, `${label}: unpricedTokens`).toBe(expected.unpricedTokens);
  expect(served.costUsd, `${label}: costUsd`).toBeCloseTo(expected.costUsd, 10);
}

describe('P0 proof 4 - the five daily questions, answered over real HTTP', () => {
  const dirs: string[] = [];
  let db: SqliteDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    const corpusRoot = makeTempDir('p0-questions-corpus-');
    const dbDir = makeTempDir('p0-questions-db-');
    dirs.push(corpusRoot, dbDir);

    // 1. The real fixture corpus on real disk, ingested by the real pipeline.
    materializeCorpus(corpusRoot, allFixtures());
    db = openSeededDb(join(dbDir, 'p0-questions.sqlite'));
    const summary = runCorpusIngest({
      db,
      pricing: loadPricing(db),
      env: corpusEnv(corpusRoot, INSTANCE),
      now: () => FIXED_NOW,
    });
    // The arrangement itself must not be silently empty: every question below
    // is only meaningful if there is a corpus behind it.
    expect(summary.sessionsOk).toBeGreaterThan(0);
    expect(summary.sessionsFailed).toBe(0);
    expect(summary.usageRowsInserted).toBeGreaterThan(0);
    expect(summary.edgesInserted).toBeGreaterThan(0);

    // 2. The watchdog, at a fixed instant - the 'unknown' half of Q4.
    const aged = runWatchdogSweep(db, SWEEP_AT_MS, SWEEP_THRESHOLD_MS);
    expect(aged.length).toBeGreaterThan(0);
    expect(aged.every((transition) => transition.newStatus === 'unknown')).toBe(true);

    // 3. The real server, wired the way the composition root wires it.
    app = buildServer({ token: TEST_TOKEN, schemaVersion: currentSchemaVersion(db), db });
    await registerHookRoutes(app, {
      eventStore: new SqliteEventStore(db),
      applyStatus: (hookName, payload) => {
        applyHookLiveness(db, hookName, payload);
      },
    });
    await app.ready();

    // 4. The terminal signals, delivered over HTTP to the real receiver.
    const subagentStop = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      headers: AUTH,
      payload: {
        hook_event_name: 'SubagentStop',
        session_id: LIVE_SESSION,
        agent_id: LIVE_GRANDCHILD,
      },
    });
    expect(subagentStop.statusCode).toBe(202);

    const stop = await app.inject({
      method: 'POST',
      url: HOOK_EVENT_PATH,
      headers: AUTH,
      payload: { hook_event_name: 'Stop', session_id: LIVE_SESSION },
    });
    expect(stop.statusCode).toBe(202);
  });

  afterAll(async () => {
    await app.close();
    db.close();
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P0: every endpoint that answers a daily question refuses an unauthenticated caller', async () => {
    for (const endpoint of GUARDED_ENDPOINTS) {
      const anonymous = await app.inject({
        method: endpoint.method,
        url: endpoint.url,
        ...(endpoint.method === 'POST' ? { payload: { hook_event_name: 'Stop' } } : {}),
      });
      expect(anonymous.statusCode, `${endpoint.method} ${endpoint.url} unauthenticated`).toBe(401);
      expect(anonymous.json()).toEqual({ error: 'Unauthorized.' });
      // The refusal must not leak the answer it refused to give.
      expect(anonymous.body).not.toContain(LIVE_SESSION);
    }

    // A malformed credential is refused exactly like a missing one.
    const wrongToken = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${TEST_TOKEN}x` },
    });
    expect(wrongToken.statusCode).toBe(401);
  });

  it('P0 question 1 - "what is running now" is answered by GET /api/sessions', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions', headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SessionListDto;

    // A 200 with an empty list is not an answer.
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.sessions.length);

    // THE ANSWER IS `sessions[].statusCounts.working` ON A NAMED SESSION: how
    // many agents of that session are currently observed as running. The live
    // fixture session must be there by name, with a live agent in it.
    const live = body.sessions.find((session) => session.id === LIVE_SESSION);
    expect(live, 'the live session is present in the list by name').toBeDefined();
    if (live === undefined) return;
    expect(live.statusCounts.working, 'the live session has a running agent').toBeGreaterThan(0);

    // ... and the answer must DISCRIMINATE. If every session came back
    // 'working' the question would be answered by a constant, which is the
    // failure mode a freshly ingested corpus produces. The stale sessions must
    // NOT be counted as running.
    const stuck = body.sessions.find((session) => session.id === STUCK_SESSION);
    expect(stuck, 'the stale session is present in the list by name').toBeDefined();
    if (stuck === undefined) return;
    expect(stuck.statusCounts.working, 'a stale session reports nothing running').toBe(0);

    // `status` on the session row itself is the second half of the answer: the
    // main agent's own liveness, mirrored onto the session. The `Stop` hook
    // delivered above moved it to 'waiting' - idle right now, honestly, rather
    // than the confident 'completed' a per-turn hook cannot justify.
    expect(live.status).toBe('waiting');
    expect(stuck.status).toBe('unknown');

    // Every session row carries the ground-truth rollup the status board
    // renders next to the status, and it must obey sign and floor.
    for (const session of body.sessions) {
      expectNonNegative(
        {
          tokens: session.totalTokens,
          costUsd: session.totalCostUsd,
          unpricedTokens: session.unpricedTokens,
        },
        `session ${session.id}`,
      );
      expect(session.agentCount).toBeGreaterThan(0);
    }
  });

  it('P0 question 2 - "where did the tokens and the money go" is answered by GET /api/cost/summary', async () => {
    // topN is raised so the whole corpus lands in `topSessions` and the list
    // can be checked against ground truth rather than sampled.
    const response = await app.inject({
      method: 'GET',
      url: '/api/cost/summary?topN=50',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as CostSummaryDto;
    const truth = recomputeFromGroundTruth(db);

    // A 200 with empty breakdowns is not an answer.
    expect(body.perModel.length).toBeGreaterThan(0);
    expect(body.perDay.length).toBeGreaterThan(0);
    expect(body.topSessions.length).toBeGreaterThan(0);

    // THE ANSWER IS `totals.costUsd` - a real, non-zero dollar figure - broken
    // down by `perModel[].costUsd` (where), `perDay[].costUsd` (when) and
    // `topSessions[].costUsd` (who). No magic constant is pinned: the criterion
    // is that every displayed dollar traces to ground-truth tokens times a
    // dated price, re-derived above from `token_usage` + `model_pricing`.
    expect(body.totals.costUsd, 'the corpus cost real money').toBeGreaterThan(0);
    expect(body.totals.tokens, 'the corpus burned real tokens').toBeGreaterThan(0);

    // Sign and floor FIRST, and on their own - a comparison alone would pass a
    // sign error present on both sides.
    expectNonNegative(body.totals, 'totals');
    expectUnpricedDisclosed(body.totals, 'totals');
    for (const row of body.perModel) {
      expectNonNegative(row, `perModel ${row.model}`);
      expectUnpricedDisclosed(row, `perModel ${row.model}`);
    }
    for (const row of body.perDay) {
      expectNonNegative(row, `perDay ${row.day}`);
      expectUnpricedDisclosed(row, `perDay ${row.day}`);
    }
    for (const row of body.topSessions) {
      expectNonNegative(row, `topSessions ${row.sessionId}`);
      expectUnpricedDisclosed(row, `topSessions ${row.sessionId}`);
    }

    // Then the traceability criterion, at every grain the endpoint serves.
    expectMatchesGroundTruth(body.totals, truth.totals, 'totals');

    expect(body.perModel.map((row) => row.model).sort()).toEqual([...truth.byModel.keys()].sort());
    for (const row of body.perModel) {
      const expected = truth.byModel.get(row.model);
      expect(expected, `perModel ${row.model} exists in ground truth`).toBeDefined();
      if (expected !== undefined) expectMatchesGroundTruth(row, expected, `perModel ${row.model}`);
    }

    expect(body.perDay.map((row) => row.day).sort()).toEqual([...truth.byDay.keys()].sort());
    for (const row of body.perDay) {
      const expected = truth.byDay.get(row.day);
      expect(expected, `perDay ${row.day} exists in ground truth`).toBeDefined();
      if (expected !== undefined) expectMatchesGroundTruth(row, expected, `perDay ${row.day}`);
    }

    // With topN above the corpus size, `topSessions` is the full attribution.
    expect(body.topSessions.map((row) => row.sessionId).sort()).toEqual(
      [...truth.bySession.keys()].sort(),
    );
    for (const row of body.topSessions) {
      const expected = truth.bySession.get(row.sessionId);
      expect(expected, `topSessions ${row.sessionId} exists in ground truth`).toBeDefined();
      if (expected !== undefined) {
        expectMatchesGroundTruth(row, expected, `topSessions ${row.sessionId}`);
      }
      // The money must be attributable to a project, not just to a uuid.
      expect(row.projectSlug).not.toBeNull();
    }

    // "Top" has to mean top: the list is ordered by spend, descending.
    const spends = body.topSessions.map((row) => row.costUsd);
    expect([...spends].sort((a, b) => b - a)).toEqual(spends);

    // The breakdowns must ADD UP to the headline figure - a per-model or
    // per-day chart that does not reconcile with the total is a lie the UI
    // would render without noticing.
    const sum = (rows: readonly { costUsd: number }[]): number =>
      rows.reduce((acc, row) => acc + row.costUsd, 0);
    expect(sum(body.perModel)).toBeCloseTo(body.totals.costUsd, 10);
    expect(sum(body.perDay)).toBeCloseTo(body.totals.costUsd, 10);
    expect(sum(body.topSessions)).toBeCloseTo(body.totals.costUsd, 10);
  });

  it('P0 question 3 - "what did session X spawn, and why" is answered by GET /api/sessions/:id/tree', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${LIVE_SESSION}/tree`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const tree = response.json() as SessionTreeDto;

    expect(tree.sessionId).toBe(LIVE_SESSION);
    // A 200 with an empty tree is not an answer.
    expect(tree.agents.length).toBeGreaterThan(0);
    expect(tree.edges.length).toBeGreaterThan(0);
    expect(tree.agentCount).toBe(tree.agents.length);
    expect(tree.edgeCount).toBe(tree.edges.length);

    // THE "WHAT" IS `agents[].parentAgentId` - the self-referential column that
    // makes the subagent tree a DATA FACT rather than a UI reconstruction. This
    // fixture is the two-level chain, so the answer must carry a spawn whose
    // parent is itself a spawn: main -> d1d1a001 -> d2d2b002.
    const byId = new Map(tree.agents.map((agent) => [agent.id, agent]));
    const child = byId.get(LIVE_CHILD);
    const grandchild = byId.get(LIVE_GRANDCHILD);
    expect(child, 'the child agent is in the tree').toBeDefined();
    expect(grandchild, 'the grandchild agent is in the tree').toBeDefined();
    if (child === undefined || grandchild === undefined) return;
    expect(child.parentAgentId).toBe(LIVE_SESSION);
    expect(grandchild.parentAgentId).toBe(LIVE_CHILD);

    // Part of the "why" is WHAT KIND of agent was spawned - the subagent type
    // taken verbatim from the transcript, never inferred.
    expect(child.subagentType).toBe('depth1-agent');
    expect(grandchild.subagentType).toBe('grandchild-agent');

    // ... and the rest of the "why" is `edges[].source`: the persisted
    // provenance, i.e. WHICH structural join path in the transcript proved this
    // spawn. It is served verbatim so an inferred edge stays distinguishable
    // from a directly observed one.
    const edgeFor = (childId: string) =>
      tree.edges.find((edge) => edge.childAgentId === childId) ?? null;
    expect(edgeFor(LIVE_CHILD)?.parentAgentId).toBe(LIVE_SESSION);
    expect(edgeFor(LIVE_CHILD)?.source).toBe('tool_use');
    expect(edgeFor(LIVE_GRANDCHILD)?.parentAgentId).toBe(LIVE_CHILD);
    expect(edgeFor(LIVE_GRANDCHILD)?.source).toBe('tool_use');

    // Each spawned agent carries its own share of the bill, so "what did it
    // spawn" and "what did that cost" are one answer, not two.
    for (const agent of tree.agents) {
      expectNonNegative(asTriple(agent), `tree agent ${agent.id}`);
      expect(agent.sessionId).toBe(LIVE_SESSION);
    }
    expectNonNegative(asTriple(tree.unattributed), 'tree unattributed');

    // The four OTHER provenance kinds are answered for their own sessions -
    // "why" must not be a single hard-coded path that happens to work.
    const provenance: readonly { session: string; child: string; source: string }[] = [
      { session: '22222222-3333-4444-8555-666666666666', child: 'deadbe01', source: 'directory' },
      {
        session: '33333333-4444-4555-8666-777777777777',
        child: 'c0ffee42',
        source: 'task_notification',
      },
      {
        session: '44444444-5555-4666-8777-888888888888',
        child: 'ba5eba11',
        source: 'queue_operation',
      },
      {
        session: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
        child: '0b501e7e',
        source: 'legacy_explore',
      },
    ];
    for (const expected of provenance) {
      const other = await app.inject({
        method: 'GET',
        url: `/api/sessions/${expected.session}/tree`,
        headers: AUTH,
      });
      expect(other.statusCode, `tree of ${expected.session}`).toBe(200);
      const otherTree = other.json() as SessionTreeDto;
      const edge = otherTree.edges.find((candidate) => candidate.childAgentId === expected.child);
      expect(edge, `${expected.session} spawned ${expected.child}`).toBeDefined();
      expect(edge?.source, `provenance of ${expected.child}`).toBe(expected.source);
      expect(edge?.parentAgentId).toBe(expected.session);
    }

    // An unknown session is a 404, never an empty tree passed off as an answer.
    const missing = await app.inject({
      method: 'GET',
      url: '/api/sessions/00000000-0000-4000-8000-000000000000/tree',
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('P0 question 4 - "what is stuck" and "what FAILED" are both answered by GET /api/sessions and GET /api/dag/global', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions?limit=200',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SessionListDto;

    // THE ANSWER (the "stuck" half) IS `statusCounts.unknown` PLUS the session
    // row's own `status`: agents whose last observed activity aged past the
    // watchdog window. 'unknown' is deliberately a first-class bucket - it is
    // what the status board's ATTENTION band is built on - and it is shown as
    // 'unknown', never softened into something friendlier.
    const stuck = body.sessions.filter((session) => session.statusCounts.unknown > 0);
    expect(stuck.length, 'at least one stuck session is reported').toBeGreaterThan(0);

    const named = stuck.find((session) => session.id === STUCK_SESSION);
    expect(named, 'the stuck session is named, not just counted').toBeDefined();
    if (named === undefined) return;
    expect(named.status).toBe('unknown');
    // Every agent of that session is stale, so the count is the whole session.
    expect(named.statusCounts.unknown).toBe(named.agentCount);

    // The answer discriminates: the live session is NOT in the stuck set.
    expect(stuck.some((session) => session.id === LIVE_SESSION)).toBe(false);

    // THE ANSWER (the "FAILED" half) IS `statusCounts.error`: WP-U10's
    // agent-outcome producer classifies a parent-side errored spawn, and the
    // normalizer promotes exactly one cause - `terminated_early` - onto
    // `agents.status = 'error'` (sticky: immune to the watchdog sweep run
    // above). The `agent-outcome-errors` fixture is named, not just counted.
    const failed = body.sessions.filter((session) => session.statusCounts.error > 0);
    expect(failed.length, 'at least one session reports a FAILED agent').toBeGreaterThan(0);

    const errored = failed.find((session) => session.id === ERROR_SESSION);
    expect(errored, 'the errored session is named, not just counted').toBeDefined();
    if (errored === undefined) return;
    expect(errored.statusCounts.error).toBeGreaterThan(0);

    const dag = await app.inject({ method: 'GET', url: '/api/dag/global', headers: AUTH });
    expect(dag.statusCode).toBe(200);
    const nodes = (dag.json() as GlobalDagDto).nodes;
    const statuses = new Set(nodes.map((node) => node.status));
    expect(statuses.has('error'), 'a real producer now writes the "error" status').toBe(true);
    expect([...statuses].sort()).toEqual(['completed', 'error', 'unknown', 'waiting', 'working']);

    // The discriminating property (not the mere presence of one 'error' row):
    // the agent that ran and was killed is 'error' ...
    const terminatedEarly = nodes.find((node) => node.id === TERMINATED_EARLY_AGENT_ID);
    expect(terminatedEarly, 'the terminated-early agent is in the global DAG').toBeDefined();
    expect(terminatedEarly?.status).toBe('error');

    // ... but its sibling, interrupted by a human on the SAME parent record,
    // is NOT - the two causes must not collapse into one status bucket. It
    // stays the ordinary liveness status ('error' is NOT sticky for this
    // cause) and ages under the SAME watchdog sweep as every other January
    // agent, landing on 'unknown' - never 'error'.
    const userInterrupt = nodes.find((node) => node.id === USER_INTERRUPT_AGENT_ID);
    expect(userInterrupt, 'the user-interrupt agent is in the global DAG').toBeDefined();
    expect(userInterrupt?.status).not.toBe('error');
    expect(userInterrupt?.status).toBe('unknown');
  });

  it('P0 question 5 - "what changed across sessions" is answered by GET /api/changes', async () => {
    // The cross-session SHAPE still comes from the DAG, and the time axis of
    // spend still comes from the cost summary's `perDay`. Both are asserted
    // below because both remain true and both are what /api/changes is
    // cross-checked against - but neither is the answer to question 5 any
    // more. The answer is a single windowed call, asserted last.
    const dagResponse = await app.inject({
      method: 'GET',
      url: '/api/dag/global?limit=5000',
      headers: AUTH,
    });
    expect(dagResponse.statusCode).toBe(200);
    const dag = dagResponse.json() as GlobalDagDto;

    // A 200 with an empty graph is not an answer.
    expect(dag.nodes.length).toBeGreaterThan(0);
    expect(dag.edges.length).toBeGreaterThan(0);

    // THE CROSS-SESSION ANSWER IS `counts` PLUS the node/edge arrays: one
    // payload spanning every session, with `truncated` telling the client
    // whether it is looking at all of it. Anything less and "across sessions"
    // would be a client-side loop over per-session calls.
    const sessionsOfNodes = new Set(dag.nodes.map((node) => node.sessionId));
    expect(sessionsOfNodes.size, 'the graph spans more than one session').toBeGreaterThan(1);
    expect(new Set(dag.edges.map((edge) => edge.sessionId)).size).toBeGreaterThan(1);
    expect(dag.counts.totalAgents).toBe(dag.nodes.length);
    expect(dag.counts.totalEdges).toBe(dag.edges.length);
    expect(dag.counts.returnedAgents).toBe(dag.nodes.length);
    expect(dag.counts.returnedEdges).toBe(dag.edges.length);
    expect(dag.counts.truncated, 'nothing was silently cut from the answer').toBe(false);

    // Cross-endpoint consistency: the DAG's session count is the same corpus
    // the list endpoint reports. Two readers, one truth.
    const listResponse = await app.inject({ method: 'GET', url: '/api/sessions', headers: AUTH });
    const list = listResponse.json() as SessionListDto;
    expect(dag.counts.totalSessions).toBe(list.total);
    expect(sessionsOfNodes.size).toBe(list.total);

    // "What CHANGED" also has a time axis, and it comes from a SECOND call:
    // `perDay` on the cost summary. It must span more than one day, or there is
    // no change to see.
    const costResponse = await app.inject({
      method: 'GET',
      url: '/api/cost/summary?topN=50',
      headers: AUTH,
    });
    const cost = costResponse.json() as CostSummaryDto;
    expect(cost.perDay.length, 'more than one day of history to compare').toBeGreaterThan(1);
    // `unknown` sorts last, real days most-recent first - so the series is
    // directly plottable as a change over time.
    const realDays = cost.perDay.map((row) => row.day).filter((day) => day !== 'unknown');
    expect([...realDays].sort().reverse()).toEqual(realDays);

    // And the per-session dimension of "what changed" comes from a THIRD
    // source: each node's `lastSeenAt`, which is what makes the graph
    // orderable in time at all.
    expect(dag.nodes.every((node) => node.lastSeenAt !== null)).toBe(true);

    expect(dag.counts.totalSessions).toBeGreaterThan(1);

    // ---------------------------------------------------------------------
    // THE ANSWER (WP-U11): ONE call, over an explicit window.
    //
    // What this replaces: until /api/changes existed, "what changed" had to be
    // stitched out of the two payloads above and diffed client-side - and the
    // stitch could not express a boundary at all, so a caller could neither
    // ask "since my last look" nor tell whether the answer had missed
    // anything. Every figure below is re-derived here from the ground-truth
    // tables, by a different implementation (epoch milliseconds via
    // `Date.parse`, not SQLite text comparison), and `token_usage_rollup` is
    // read nowhere.
    // ---------------------------------------------------------------------
    const EPOCH_SINCE = '2020-01-01';
    const epochSinceMs = Date.parse(`${EPOCH_SINCE}T00:00:00.000Z`);
    const newestMs = newestInstantFromGroundTruth(db);

    const wholeResponse = await app.inject({
      method: 'GET',
      url: `/api/changes?since=${EPOCH_SINCE}&limit=200`,
      headers: AUTH,
    });
    expect(wholeResponse.statusCode).toBe(200);
    const whole = wholeResponse.json() as ChangesDto;

    // The window is STATED, not implied - which is what makes the answer
    // chainable and what makes "did I miss anything" a checkable question.
    expect(whole.since).toBe('2020-01-01T00:00:00.000Z');
    expect(whole.interval).toBe('(since, until]');
    expect(whole.basis).toBe('event-time');
    // `until` is the corpus's newest instant, never the wall clock.
    expect(Date.parse(whole.until)).toBe(newestMs);
    expect(Date.parse(whole.until)).toBeLessThan(Date.now());

    // A 200 with an empty delta is not an answer.
    expect(whole.sessions.length).toBeGreaterThan(1);
    expect(whole.sessions.map((session) => session.id)).toEqual(
      changedSessionsFromGroundTruth(db, epochSinceMs, newestMs),
    );
    expect(whole.total).toBe(list.total);
    // Every fixture session carries a usable timestamp, so nothing is undated
    // - and the endpoint SAYS so rather than leaving it to be assumed.
    expect(whole.coverage).toEqual({
      undatedSessions: 0,
      undatedAgents: 0,
      undatedUsageRows: 0,
    });

    // The classification partitions the window exactly, and over a window that
    // predates the whole corpus every session is genuinely new.
    expect(whole.totals.sessionsNew).toBe(whole.total);
    expect(whole.totals.sessionsUpdated).toBe(0);
    expect(whole.totals.sessionsUnknownStart).toBe(0);
    expect(whole.totals.agentsAppeared).toBe(dag.counts.totalAgents);

    // Money: the same rule as every other dollar in this suite - ground-truth
    // tokens times a dated price - re-derived, never read back from the
    // endpoint under test. A window this wide must equal the whole ledger.
    const wholeTriple: Triple = {
      tokens: whole.totals.tokensAdded,
      costUsd: whole.totals.costAddedUsd,
      unpricedTokens: whole.totals.unpricedTokensAdded,
    };
    expectNonNegative(wholeTriple, 'changes(whole corpus)');
    expectUnpricedDisclosed(wholeTriple, 'changes(whole corpus)');
    expectMatchesGroundTruth(
      wholeTriple,
      recomputeFromGroundTruth(db).totals,
      'changes(whole corpus)',
    );
    // Every priced token in this window belongs to a session that changed in
    // it, so nothing is left unattributed.
    expect(whole.totals.tokensAddedOutsideChangedSessions).toBe(0);

    // A NARROWER window actually narrows - the January corpus drops out and
    // the live April session is what is left.
    const recentSince = '2026-02-01';
    const recentSinceMs = Date.parse(`${recentSince}T00:00:00.000Z`);
    const recentResponse = await app.inject({
      method: 'GET',
      url: `/api/changes?since=${recentSince}&limit=200`,
      headers: AUTH,
    });
    expect(recentResponse.statusCode).toBe(200);
    const recent = recentResponse.json() as ChangesDto;
    const expectedRecent = changedSessionsFromGroundTruth(db, recentSinceMs, newestMs);
    expect(recent.sessions.map((session) => session.id)).toEqual(expectedRecent);
    expect(recent.total).toBe(expectedRecent.length);
    expect(recent.total).toBeLessThan(whole.total);
    expect(expectedRecent, 'the live session is what changed recently').toContain(LIVE_SESSION);
    expect(expectedRecent, 'the January corpus is not "recent"').not.toContain(STUCK_SESSION);

    const recentTriple: Triple = {
      tokens: recent.totals.tokensAdded,
      costUsd: recent.totals.costAddedUsd,
      unpricedTokens: recent.totals.unpricedTokensAdded,
    };
    expectNonNegative(recentTriple, 'changes(recent)');
    expectMatchesGroundTruth(
      recentTriple,
      windowTripleFromGroundTruth(db, recentSinceMs, newestMs),
      'changes(recent)',
    );
    expect(recent.totals.tokensAdded).toBeLessThan(whole.totals.tokensAdded);

    // The PER-ROW label, at every grain the endpoint serves it. The two
    // windows above assert only the aggregate counters, and both of them see a
    // corpus in which every changed session also started inside the window -
    // so `sessionsUpdated` is 0 in both, and `new` is the only label either one
    // can observe. A `change` column that returned the literal 'new' for every
    // row would satisfy everything asserted so far.
    expect(new Map(whole.sessions.map((session) => [session.id, session.change]))).toEqual(
      changeKindsFromGroundTruth(db, epochSinceMs, newestMs),
    );
    expect(new Map(recent.sessions.map((session) => [session.id, session.change]))).toEqual(
      changeKindsFromGroundTruth(db, recentSinceMs, newestMs),
    );

    // ...and a window that SPLITS a session, which is the only shape in this
    // corpus that can produce an `updated` row at all. The session the boundary
    // cuts through was already running when the window opened; the ones that
    // start after it are new. Both labels are now observed, and the counters
    // beside them are pinned to a re-derivation rather than to zero.
    const midSinceMs = midLifeBoundaryMs(db);
    const midResponse = await app.inject({
      method: 'GET',
      url: `/api/changes?since=${new Date(midSinceMs).toISOString()}&limit=200`,
      headers: AUTH,
    });
    expect(midResponse.statusCode).toBe(200);
    const mid = midResponse.json() as ChangesDto;
    const midKinds = changeKindsFromGroundTruth(db, midSinceMs, newestMs);
    expect(new Map(mid.sessions.map((session) => [session.id, session.change]))).toEqual(midKinds);

    // Anti-vacuity: the comparison above is only worth making because BOTH
    // labels are actually present in it.
    const kinds = [...midKinds.values()];
    expect(kinds, 'the split session is reported as updated').toContain('updated');
    expect(kinds, 'the later sessions are still reported as new').toContain('new');
    expect(mid.totals.sessionsUpdated).toBe(kinds.filter((kind) => kind === 'updated').length);
    expect(mid.totals.sessionsNew).toBe(kinds.filter((kind) => kind === 'new').length);
    expect(mid.totals.sessionsUnknownStart).toBe(kinds.filter((kind) => kind === 'unknown').length);
    // The three classes partition the window - no row is counted twice, none
    // is dropped between them.
    expect(
      mid.totals.sessionsNew + mid.totals.sessionsUpdated + mid.totals.sessionsUnknownStart,
    ).toBe(mid.total);

    // CHAINING, the property the client-side stitch could never offer: feed
    // `until` back in as `since` and the corpus is walked with no gap and no
    // repeat. With nothing newer ingested, the follow-up window is empty and
    // SAYS it is empty rather than reaching for the clock.
    const nextResponse = await app.inject({
      method: 'GET',
      url: `/api/changes?since=${whole.until}`,
      headers: AUTH,
    });
    expect(nextResponse.statusCode).toBe(200);
    const next = nextResponse.json() as ChangesDto;
    expect(next.since).toBe(whole.until);
    expect(next.until).toBe(whole.until);
    expect(next.total).toBe(0);
    expect(next.sessions).toEqual([]);
    expect(next.totals.tokensAdded).toBe(0);
    expect(next.totals.costAddedUsd).toBe(0);

    // ...and a boundary that is not a real instant is refused, never quietly
    // reinterpreted as some other window.
    const bogus = await app.inject({
      method: 'GET',
      url: '/api/changes?since=2026-02-30',
      headers: AUTH,
    });
    expect(bogus.statusCode).toBe(400);
    expect(Object.keys(bogus.json() as object)).toEqual(['error']);
  });
});
