/**
 * WP-U3/WP-U4 - read-only SQL behind the API routes. SELECT statements only:
 * every write path belongs to ingest, never to this layer.
 *
 * Cost discipline (the honesty rules of ux0-design):
 * - every dollar is tokens x a dated `model_pricing` rate - the rate is the
 *   latest row with `effective_from <= occurred_at` for the exact
 *   (model, bucket); nothing is ever invented;
 * - tokens with no resolvable rate (unknown model, missing timestamp, or no
 *   effective price yet) are counted in `unpricedTokens` and contribute $0 -
 *   surfaced, never silently priced;
 * - agents with a NULL status are counted in the `unknown` bucket - an absent
 *   status IS unknown, and hiding it would fake certainty;
 * - trees/DAGs are queries over persisted rows (`agents.parent_agent_id`,
 *   `orchestration_edges`), never a render-time reconstruction, and the edge
 *   `source` provenance is served verbatim.
 */
import {
  MAX_AGGREGATE_SKIPPED_SAMPLE,
  type AggregateDelegationSavingsDto,
  type AggregateSavingsSkipDto,
  type AgentNodeDto,
  type CostSummaryDto,
  type GlobalDagDto,
  type ModelCostDto,
  type OrchestrationEdgeDto,
  type SessionDetailDto,
  type SessionEventsDto,
  type SessionSummaryDto,
  type SessionTreeDto,
} from '@agenthropic/shared';
import { PricingError, computeDelegationSavings } from '@agenthropic/core';
import type { DedupedUsage, ParsedAgent, ParsedSession, PricingEntry } from '@agenthropic/core';
import type { SqliteDatabase } from '../db/connection';

/**
 * Shared CTE: every `token_usage` row with its resolved USD/Mtok rate (NULL
 * when no dated price applies). ISO-8601 strings compare correctly as text,
 * so `effective_from <= occurred_at` needs no date parsing.
 */
function pricedCte(where = ''): string {
  return `
  priced AS (
    SELECT
      tu.session_id AS session_id,
      tu.agent_id AS agent_id,
      tu.model AS model,
      tu.tokens AS tokens,
      tu.occurred_at AS occurred_at,
      (
        SELECT mp.usd_per_mtok
        FROM model_pricing mp
        WHERE mp.model = tu.model
          AND mp.bucket = tu.bucket
          AND tu.occurred_at IS NOT NULL
          AND mp.effective_from <= tu.occurred_at
        ORDER BY mp.effective_from DESC
        LIMIT 1
      ) AS rate
    FROM token_usage tu
    ${where}
  )
`;
}

const PRICED_CTE = pricedCte();

/** USD over PRICED rows only - unpriced rows contribute $0, never a guess. */
const COST_USD = `SUM(CASE WHEN rate IS NOT NULL THEN tokens * rate / 1000000.0 ELSE 0 END)`;

/** Tokens whose rate could not be resolved - surfaced, never hidden. */
const UNPRICED = `SUM(CASE WHEN rate IS NULL THEN tokens ELSE 0 END)`;

/**
 * Session-summary projection for an explicit set of session ids.
 *
 * The restriction is injected into every scan rather than applied once at the
 * end. SQLite cannot push an outer predicate through the `LEFT JOIN` onto a
 * `GROUP BY` subquery, so the previous shape priced and grouped the WHOLE
 * `token_usage` table and then discarded all but the requested rows - making a
 * single-session read scale with corpus size instead of session size (measured:
 * 627 ms vs 9 ms over a 752k-row usage table, same result).
 *
 * Takes three id lists' worth of parameters, in scan order: `priced`, then
 * `agents_by_session`, then the driving `sessions` scan.
 */
function sessionSummarySelect(idCount: number): string {
  const ids = `(${Array.from({ length: idCount }, () => '?').join(', ')})`;
  return `
  WITH ${pricedCte(`WHERE tu.session_id IN ${ids}`)},
  usage_by_session AS (
    SELECT
      session_id,
      SUM(tokens) AS total_tokens,
      ${COST_USD} AS cost_usd,
      ${UNPRICED} AS unpriced_tokens
    FROM priced
    GROUP BY session_id
  ),
  agents_by_session AS (
    SELECT
      session_id,
      COUNT(*) AS agent_count,
      SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) AS working_count,
      SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN status IS NULL OR status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count
    FROM agents
    WHERE session_id IN ${ids}
    GROUP BY session_id
  )
  SELECT
    s.id AS id,
    s.project_slug AS project_slug,
    s.status AS status,
    s.started_at AS started_at,
    s.last_activity_at AS last_activity_at,
    COALESCE(a.agent_count, 0) AS agent_count,
    COALESCE(a.working_count, 0) AS working_count,
    COALESCE(a.waiting_count, 0) AS waiting_count,
    COALESCE(a.completed_count, 0) AS completed_count,
    COALESCE(a.error_count, 0) AS error_count,
    COALESCE(a.unknown_count, 0) AS unknown_count,
    COALESCE(u.total_tokens, 0) AS total_tokens,
    COALESCE(u.cost_usd, 0) AS cost_usd,
    COALESCE(u.unpriced_tokens, 0) AS unpriced_tokens
  FROM sessions s
  LEFT JOIN agents_by_session a ON a.session_id = s.id
  LEFT JOIN usage_by_session u ON u.session_id = s.id
  WHERE s.id IN ${ids}
`;
}

interface SessionSummaryRow {
  readonly id: string;
  readonly project_slug: string | null;
  readonly status: string | null;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly agent_count: number;
  readonly working_count: number;
  readonly waiting_count: number;
  readonly completed_count: number;
  readonly error_count: number;
  readonly unknown_count: number;
  readonly total_tokens: number;
  readonly cost_usd: number;
  readonly unpriced_tokens: number;
}

function toSessionSummary(row: SessionSummaryRow): SessionSummaryDto {
  return {
    id: row.id,
    projectSlug: row.project_slug,
    status: row.status,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    agentCount: row.agent_count,
    totalTokens: row.total_tokens,
    totalCostUsd: row.cost_usd,
    unpricedTokens: row.unpriced_tokens,
    statusCounts: {
      working: row.working_count,
      waiting: row.waiting_count,
      completed: row.completed_count,
      error: row.error_count,
      unknown: row.unknown_count,
    },
  };
}

export function countSessions(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number };
  return row.c;
}

const SESSION_PAGE_ORDER = 'COALESCE(s.last_activity_at, s.started_at) DESC, s.id ASC';

/** Recent-first page of session summaries (WP-U3). */
export function listSessions(
  db: SqliteDatabase,
  limit: number,
  offset: number,
): SessionSummaryDto[] {
  // Resolve WHICH sessions are on this page before pricing anything: the
  // ordering key lives entirely on `sessions`, so the page is knowable without
  // reading a single `token_usage` row. Pricing the whole usage table only to
  // return one page of it is what made this endpoint scale with corpus size
  // instead of page size.
  const ids = (
    db
      .prepare(`SELECT s.id AS id FROM sessions s ORDER BY ${SESSION_PAGE_ORDER} LIMIT ? OFFSET ?`)
      .all(limit, offset) as Array<{ id: string }>
  ).map((row) => row.id);
  if (ids.length === 0) {
    return [];
  }
  const rows = db
    .prepare(`${sessionSummarySelect(ids.length)} ORDER BY ${SESSION_PAGE_ORDER}`)
    .all(...ids, ...ids, ...ids) as SessionSummaryRow[];
  return rows.map(toSessionSummary);
}

function getSessionSummary(db: SqliteDatabase, sessionId: string): SessionSummaryDto | undefined {
  const row = db.prepare(sessionSummarySelect(1)).get(sessionId, sessionId, sessionId) as
    SessionSummaryRow | undefined;
  return row === undefined ? undefined : toSessionSummary(row);
}

interface ModelCostRow {
  readonly model: string;
  readonly tokens: number;
  readonly cost_usd: number;
  readonly unpriced_tokens: number;
}

function toModelCost(row: ModelCostRow): ModelCostDto {
  return {
    model: row.model,
    tokens: row.tokens,
    costUsd: row.cost_usd,
    unpricedTokens: row.unpriced_tokens,
  };
}

/** Session summary + edge count + per-model cost rollup, or undefined. */
export function getSessionDetail(
  db: SqliteDatabase,
  sessionId: string,
): SessionDetailDto | undefined {
  const summary = getSessionSummary(db, sessionId);
  if (summary === undefined) {
    return undefined;
  }
  const edgeCount = (
    db
      .prepare('SELECT COUNT(*) AS c FROM orchestration_edges WHERE session_id = ?')
      .get(sessionId) as {
      c: number;
    }
  ).c;
  const models = db
    .prepare(
      `WITH ${PRICED_CTE}
       SELECT model, SUM(tokens) AS tokens, ${COST_USD} AS cost_usd, ${UNPRICED} AS unpriced_tokens
       FROM priced
       WHERE session_id = ?
       GROUP BY model
       ORDER BY cost_usd DESC, model ASC`,
    )
    .all(sessionId) as ModelCostRow[];
  return { ...summary, edgeCount, models: models.map(toModelCost) };
}

interface AgentNodeRow {
  readonly id: string;
  readonly session_id: string;
  readonly type: string | null;
  readonly subagent_type: string | null;
  readonly status: string | null;
  readonly parent_agent_id: string | null;
  readonly first_seen_at: string | null;
  readonly last_seen_at: string | null;
  readonly total_tokens: number;
  readonly cost_usd: number;
  readonly unpriced_tokens: number;
}

function toAgentNode(row: AgentNodeRow): AgentNodeDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type as AgentNodeDto['type'],
    subagentType: row.subagent_type,
    status: row.status as AgentNodeDto['status'],
    parentAgentId: row.parent_agent_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    unpricedTokens: row.unpriced_tokens,
  };
}

interface EdgeRow {
  readonly id: number;
  readonly session_id: string;
  readonly parent_agent_id: string;
  readonly child_agent_id: string;
  readonly source: string;
  readonly instance: string;
  readonly host_id: string;
  readonly created_at: string | null;
}

function toEdge(row: EdgeRow): OrchestrationEdgeDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentAgentId: row.parent_agent_id,
    childAgentId: row.child_agent_id,
    source: row.source as OrchestrationEdgeDto['source'],
    instance: row.instance,
    hostId: row.host_id,
    createdAt: row.created_at,
  };
}

const EDGE_COLUMNS =
  'id, session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at';

/**
 * The session's persisted subagent tree: every agent row (with its usage
 * rollup), every orchestration edge as stored, plus the `unattributed` usage
 * bucket - rows whose agent_id is NULL or points outside this session's agents.
 * Main-agent turns are NOT in that bucket: the writer resolves them onto the
 * main node (agents.id === sessionId), so a root reporting $0 means it really
 * spent nothing. What remains unattributed is usage whose owner could not be
 * joined to a materialized node - shown, never dropped and never guessed onto
 * an agent. Undefined for an unknown session.
 */
export function getSessionTree(db: SqliteDatabase, sessionId: string): SessionTreeDto | undefined {
  const exists = db.prepare('SELECT 1 AS one FROM sessions WHERE id = ?').get(sessionId);
  if (exists === undefined) {
    return undefined;
  }
  const agentRows = db
    .prepare(
      `WITH ${PRICED_CTE},
       usage_by_agent AS (
         SELECT agent_id, SUM(tokens) AS total_tokens, ${COST_USD} AS cost_usd, ${UNPRICED} AS unpriced_tokens
         FROM priced
         WHERE session_id = ? AND agent_id IS NOT NULL
         GROUP BY agent_id
       )
       SELECT
         ag.id AS id, ag.session_id AS session_id, ag.type AS type,
         ag.subagent_type AS subagent_type, ag.status AS status,
         ag.parent_agent_id AS parent_agent_id,
         ag.first_seen_at AS first_seen_at, ag.last_seen_at AS last_seen_at,
         COALESCE(u.total_tokens, 0) AS total_tokens,
         COALESCE(u.cost_usd, 0) AS cost_usd,
         COALESCE(u.unpriced_tokens, 0) AS unpriced_tokens
       FROM agents ag
       LEFT JOIN usage_by_agent u ON u.agent_id = ag.id
       WHERE ag.session_id = ?
       ORDER BY COALESCE(ag.first_seen_at, '') ASC, ag.id ASC`,
    )
    .all(sessionId, sessionId) as AgentNodeRow[];
  const edgeRows = db
    .prepare(`SELECT ${EDGE_COLUMNS} FROM orchestration_edges WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId) as EdgeRow[];
  const unattributed = db
    .prepare(
      `WITH ${PRICED_CTE}
       SELECT
         COALESCE(SUM(tokens), 0) AS total_tokens,
         COALESCE(${COST_USD}, 0) AS cost_usd,
         COALESCE(${UNPRICED}, 0) AS unpriced_tokens
       FROM priced
       WHERE session_id = ?
         AND (agent_id IS NULL OR agent_id NOT IN (SELECT id FROM agents WHERE session_id = ?))`,
    )
    .get(sessionId, sessionId) as {
    total_tokens: number;
    cost_usd: number;
    unpriced_tokens: number;
  };
  return {
    sessionId,
    agents: agentRows.map(toAgentNode),
    edges: edgeRows.map(toEdge),
    agentCount: agentRows.length,
    edgeCount: edgeRows.length,
    unattributed: {
      totalTokens: unattributed.total_tokens,
      costUsd: unattributed.cost_usd,
      unpricedTokens: unattributed.unpriced_tokens,
    },
  };
}

interface HookEventRow {
  readonly id: number;
  readonly raw_event_id: number;
  readonly agent_id: string | null;
  readonly event_type: string | null;
  readonly occurred_at: string | null;
}

/**
 * WP-D5 reader - one session's hook LIVENESS timeline, oldest first with
 * `id` as the stable tiebreaker for equal timestamps. Undefined for an
 * unknown session (404 at the route); a known session with zero hook events
 * is the honest `{ events: [], total: 0 }` - those are different facts.
 *
 * `occurredAtSource` is 'receipt' on every row: the projection writes the
 * server receive time because the hook envelope contract carries no
 * event-originated timestamp (see db/event-store.ts) - surfaced here so a
 * consumer can never mistake receipt time for event time. Rows whose
 * `session_id` could not be extracted (NULL) belong to no session timeline
 * and are reachable only through `events_raw`.
 */
export function getSessionEvents(
  db: SqliteDatabase,
  sessionId: string,
  limit: number,
  offset: number,
): SessionEventsDto | undefined {
  const exists = db.prepare('SELECT 1 AS one FROM sessions WHERE id = ?').get(sessionId);
  if (exists === undefined) {
    return undefined;
  }
  const total = (
    db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId) as {
      c: number;
    }
  ).c;
  const rows = db
    .prepare(
      `SELECT id, raw_event_id, agent_id, event_type, occurred_at
       FROM events
       WHERE session_id = ?
       ORDER BY occurred_at ASC, id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(sessionId, limit, offset) as HookEventRow[];
  return {
    sessionId,
    events: rows.map((row) => ({
      id: row.id,
      rawEventId: row.raw_event_id,
      agentId: row.agent_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      occurredAtSource: 'receipt' as const,
    })),
    total,
    limit,
    offset,
  };
}

/** Global totals, per-model, per-day and top-N session cost rollups (WP-U4). */
interface CostRollupRow {
  readonly session_id: string;
  readonly model: string;
  readonly day: string;
  readonly tokens: number;
  readonly cost_usd: number;
  readonly unpriced_tokens: number;
}

interface CostBucket {
  tokens: number;
  costUsd: number;
  unpricedTokens: number;
}

function accumulate(into: Map<string, CostBucket>, key: string, row: CostRollupRow): void {
  const bucket = into.get(key) ?? { tokens: 0, costUsd: 0, unpricedTokens: 0 };
  bucket.tokens += row.tokens;
  bucket.costUsd += row.cost_usd;
  bucket.unpricedTokens += row.unpriced_tokens;
  into.set(key, bucket);
}

/**
 * Tie-break on a grouping key. SQLite orders TEXT with BINARY collation, so
 * this compares code units rather than locale. Every caller passes keys of a
 * `Map`, which are unique by construction, so equality has no arm.
 */
function byBinary(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/**
 * The persisted project slug for one session, or null when the session is
 * unknown (or was ingested without a slug). The substrate provider takes this
 * as its `slugOf` LOCATION HINT: the value is re-vetted against corpus
 * containment before any path is touched, and every miss falls back to full
 * enumeration — so a stale value can only cost a lookup its speed, never its
 * answer or its containment.
 */
export function getSessionProjectSlug(db: SqliteDatabase, sessionId: string): string | null {
  const row = db.prepare('SELECT project_slug FROM sessions WHERE id = ?').get(sessionId) as
    { project_slug: string | null } | undefined;
  return row === undefined ? null : row.project_slug;
}

/** The columns whose content the pricing fingerprint must not miss. */
interface PricingFingerprintRow {
  readonly model: string;
  readonly bucket: string;
  readonly usd_per_mtok: number;
  readonly effective_from: string;
}

interface CostSummaryCacheEntry {
  readonly stateKey: string;
  readonly topN: number;
  readonly summary: CostSummaryDto;
}

/**
 * One cached summary per live connection handle. A WeakMap so production (one
 * handle) holds exactly one entry, test suites with many temp databases can
 * never bleed cached dollars into each other, and entries die with their
 * connection. One entry — not an LRU over topN values — is a PROVISIONAL
 * policy: the dashboard issues one topN per view, so a second slot has no
 * known consumer yet.
 */
const costSummaryCache = new WeakMap<SqliteDatabase, CostSummaryCacheEntry>();

/**
 * Execution-count seam for the cache tests: `onScan` fires exactly when the
 * token_usage rollup actually runs, so a test can prove a cache hit skipped
 * the expensive scan by counting — never by timing.
 */
export interface CostSummaryProbe {
  onScan(): void;
}

/**
 * Cheap self-validating state key for the cost-summary cache, recomputed on
 * every request. The cached dollars are a pure function of `token_usage`,
 * `sessions` (slug lookup) and `model_pricing`, so the key must move whenever
 * any of them can have changed:
 *
 * - `total_changes()` counts every row this CONNECTION has inserted, updated
 *   or deleted, across all tables — verified empirically against
 *   better-sqlite3 (2026-08-12): ingest INSERTs, retention DELETEs and even
 *   an in-place UPDATE rewriting identical values all bump it. That covers
 *   `token_usage` and `sessions` entirely, because only this server process
 *   writes them (single-writer by design: ingest and retention run on this
 *   same handle) — a hypothetical second writer to those tables is out of
 *   threat scope, and WAL locking makes it a misconfiguration, not a flow.
 * - `total_changes()` is blind to OTHER connections (also verified), and
 *   `model_pricing` is the one table with a documented cross-connection write
 *   path: the operator seeds rates via the sqlite3 CLI while the server runs.
 *   So the table's full content rides in the key verbatim — ~25 rows
 *   (PROVISIONAL: the WP-C1 seed's size), a trivial read next to the
 *   token_usage scan being avoided.
 *
 * The fingerprint is serialized in JS over an ORDER BY'd SELECT rather than
 * SQL group_concat, whose concatenation order SQLite does not guarantee.
 * False invalidations (e.g. an unrelated `events` INSERT, or a rolled-back
 * write — total_changes counts those too) merely recompute; the design errs
 * only in the never-stale direction.
 *
 * That direction is the right one, but be honest about its price: on a server
 * with ingest running, a false invalidation is the NORM, not the exception —
 * every poll tick that writes anything at all moves this key. See the M-19 note
 * in {@link getCostSummary}: this key makes the cache correct, not the read
 * bounded.
 */
function costSummaryStateKey(db: SqliteDatabase): string {
  const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const pricing = db
    .prepare(
      `SELECT model, bucket, usd_per_mtok, effective_from
       FROM model_pricing
       ORDER BY model, bucket, effective_from`,
    )
    .all() as PricingFingerprintRow[];
  return `${changes}|${JSON.stringify(pricing)}`;
}

export function getCostSummary(
  db: SqliteDatabase,
  topN: number,
  probe?: CostSummaryProbe,
): CostSummaryDto {
  // M-19 — READ THIS BEFORE RECORDING THE FINDING AS CLOSED.
  //
  // What this cache IS: a one-entry memo behind the self-validating key above.
  // It bounds REPEAT reads on a QUIESCENT connection — a dashboard refresh, a
  // second widget on the same page, any read while nothing is being written.
  // A hit returns the SAME DTO object by reference; routes only serialize it,
  // never mutate it.
  //
  // What this cache IS NOT: an asymptotic fix. THE ASYMPTOTICS ARE UNCHANGED.
  // The cold path below still prices and groups ALL of `token_usage` — a table
  // whose retention is deliberately refused (cost history is the product), so
  // it grows with corpus age forever — and the key above is invalidated by
  // `total_changes()`, which moves on essentially every ingest tick and on
  // every retention pass. On an actively ingesting server nearly every
  // /api/cost/summary read is therefore still a cold, full scan. The cache
  // widened the hit window; it did not bound the read.
  //
  // Why the key is not simply narrowed here: a narrower key must be
  // CONSERVATIVE (never miss a change to `token_usage` / `sessions`) and cheap,
  // and no read-only signal is both.
  //  - `PRAGMA data_version` moves only for OTHER connections' commits. Ingest
  //    and retention run on THIS handle, so it is blind to exactly the writes
  //    that matter — it would serve stale dollars, which is the one failure
  //    this layer may never have.
  //  - A per-table write counter WOULD be exact, but it has to be bumped where
  //    the writes happen (db/token-usage.ts, db/sessions.ts). This module is
  //    SELECT-only by contract and owns no write-side seam.
  //  - Every purely read-side detector is itself O(token_usage) AND still
  //    inexact: the ingest upsert's settle arm UPDATES rows in place, so
  //    COUNT(*) / MAX(id) cannot see it, and a message-level model settle
  //    changes per-model attribution without changing SUM(tokens).
  //
  // The only variant that actually bounds the read is a PERSISTED
  // (session, model, bucket, day, tokens) rollup maintained inside the existing
  // per-session ingest transaction, priced at read time by the same dated
  // rates. That is a schema + ingest change (db/migrations.ts,
  // db/token-usage.ts, ingest/project-session.ts), not a read-layer change.
  // Note the grain: (session, model, DAY) as the review words it is not exactly
  // repriceable when a `model_pricing.effective_from` falls mid-day — the
  // bucket must be carried too, and tokens (not dollars) must be what is
  // stored, or the rollup and a direct scan can disagree.
  //
  // test/api-cost-summary-equivalence.test.ts is the standing guard: whatever
  // this function returns must equal a full uncached scan of the same data.
  const stateKey = costSummaryStateKey(db);
  const cached = costSummaryCache.get(db);
  if (cached !== undefined && cached.stateKey === stateKey && cached.topN === topN) {
    return cached.summary;
  }
  probe?.onScan();
  // ONE scan of `token_usage`, rolled up to (session, model, day) - the
  // coarsest grain from which all four sections below are derivable. The
  // previous shape ran the priced CTE four separate times, so every global cost
  // read scanned AND sorted the whole usage table once per output section:
  // 2.64 s over 752k rows, which is a page load, not a query. The rollup is
  // bounded by distinct sessions x models x days, orders of magnitude smaller
  // than the row count, so the regroupings below are free.
  const rollup = db
    .prepare(
      `WITH ${PRICED_CTE}
       SELECT
         session_id AS session_id,
         model AS model,
         CASE WHEN occurred_at IS NULL THEN 'unknown' ELSE substr(occurred_at, 1, 10) END AS day,
         SUM(tokens) AS tokens,
         ${COST_USD} AS cost_usd,
         ${UNPRICED} AS unpriced_tokens
       FROM priced
       GROUP BY session_id, model, day`,
    )
    .all() as CostRollupRow[];

  const totals: CostBucket = { tokens: 0, costUsd: 0, unpricedTokens: 0 };
  const byModel = new Map<string, CostBucket>();
  const byDay = new Map<string, CostBucket>();
  const bySession = new Map<string, CostBucket>();
  for (const row of rollup) {
    totals.tokens += row.tokens;
    totals.costUsd += row.cost_usd;
    totals.unpricedTokens += row.unpriced_tokens;
    accumulate(byModel, row.model, row);
    accumulate(byDay, row.day, row);
    accumulate(bySession, row.session_id, row);
  }

  const perModel = [...byModel]
    .sort(([aKey, a], [bKey, b]) => b.costUsd - a.costUsd || byBinary(aKey, bKey))
    .map(([model, bucket]) => ({ model, ...bucket }));
  // `unknown` last, then most-recent day first - the SQL's
  // `ORDER BY (day = 'unknown') ASC, day DESC`, and ISO days sort as text.
  const perDay = [...byDay]
    .sort(
      ([aKey], [bKey]) =>
        Number(aKey === 'unknown') - Number(bKey === 'unknown') || byBinary(bKey, aKey),
    )
    .map(([day, bucket]) => ({ day, ...bucket }));
  const top = [...bySession]
    .sort(([aKey, a], [bKey, b]) => b.costUsd - a.costUsd || byBinary(aKey, bKey))
    .slice(0, topN);
  // Only the surviving sessions need a project slug. A session_id present in
  // `token_usage` but absent from `sessions` keeps a null slug, exactly as the
  // LEFT JOIN this replaces did - the row is never dropped to hide the gap.
  const slugRows =
    top.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, project_slug FROM sessions
              WHERE id IN (${Array.from({ length: top.length }, () => '?').join(', ')})`,
          )
          .all(...top.map(([id]) => id)) as Array<{ id: string; project_slug: string | null }>);
  const slugs = new Map<string, string | null>(slugRows.map((row) => [row.id, row.project_slug]));

  const summary: CostSummaryDto = {
    totals,
    perModel,
    perDay,
    topSessions: top.map(([sessionId, bucket]) => ({
      sessionId,
      projectSlug: slugs.get(sessionId) ?? null,
      ...bucket,
    })),
  };
  // Stored under the key OBSERVED BEFORE the scan — safe because better-sqlite3
  // is synchronous: nothing on this connection can write between the two.
  costSummaryCache.set(db, { stateKey, topN, summary });
  return summary;
}

/**
 * The persisted cross-session DAG, capped at `nodeLimit` recent-first agent
 * nodes. Returned edges are those whose BOTH endpoints made the cap, so the
 * client never renders a dangling reference; `counts` carries the full totals
 * and a `truncated` flag so the cap is always visible, never silent.
 */
export function getGlobalDag(db: SqliteDatabase, nodeLimit: number): GlobalDagDto {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  const totalSessions = count('sessions');
  const totalAgents = count('agents');
  const totalEdges = count('orchestration_edges');
  // Resolve WHICH agents make the cap first, then inject the id list into
  // every scan - the sessionSummarySelect idiom. The previous shape priced
  // and grouped the WHOLE token_usage table regardless of nodeLimit (SQLite
  // cannot push the LIMIT through the LEFT JOIN onto the GROUP BY subquery),
  // making the response scale with corpus size instead of response size
  // (measured: 432 ms over a 752k-row usage table for the same payload).
  // The ordering key lives entirely on `agents`, so the selection itself
  // never touches token_usage. Parameter count is bounded by
  // MAX_DAG_NODE_LIMIT (5000) bound twice per statement - well under
  // SQLite's default variable cap (32766).
  const ids = (
    db
      .prepare(
        `SELECT id FROM agents
         ORDER BY COALESCE(last_seen_at, first_seen_at, '') DESC, id ASC
         LIMIT ?`,
      )
      .all(nodeLimit) as Array<{ id: string }>
  ).map((row) => row.id);
  const counts = (returnedAgents: number, returnedEdges: number): GlobalDagDto['counts'] => ({
    totalSessions,
    totalAgents,
    totalEdges,
    returnedAgents,
    returnedEdges,
    // Same arithmetic as before the id-list rewrite: a zero-node selection
    // over a non-empty agents table is honestly truncated.
    truncated: returnedAgents < totalAgents,
  });
  if (ids.length === 0) {
    // An empty IN () list is invalid SQLite - and with no selected nodes
    // there is nothing to price and no edge can have both endpoints.
    return { nodes: [], edges: [], counts: counts(0, 0) };
  }
  const idList = `(${ids.map(() => '?').join(', ')})`;
  // No `agent_id IS NOT NULL` arm: NULL never matches an IN list, so rows
  // with a NULL agent_id are excluded by the same predicate that scopes the
  // scan (as are rows whose agent_id matches no selected agent).
  const nodeRows = db
    .prepare(
      `WITH ${pricedCte(`WHERE tu.agent_id IN ${idList}`)},
       usage_by_agent AS (
         SELECT agent_id, SUM(tokens) AS total_tokens, ${COST_USD} AS cost_usd, ${UNPRICED} AS unpriced_tokens
         FROM priced
         GROUP BY agent_id
       )
       SELECT
         ag.id AS id, ag.session_id AS session_id, ag.type AS type,
         ag.subagent_type AS subagent_type, ag.status AS status,
         ag.parent_agent_id AS parent_agent_id,
         ag.first_seen_at AS first_seen_at, ag.last_seen_at AS last_seen_at,
         COALESCE(u.total_tokens, 0) AS total_tokens,
         COALESCE(u.cost_usd, 0) AS cost_usd,
         COALESCE(u.unpriced_tokens, 0) AS unpriced_tokens
       FROM agents ag
       LEFT JOIN usage_by_agent u ON u.agent_id = ag.id
       WHERE ag.id IN ${idList}
       ORDER BY COALESCE(ag.last_seen_at, ag.first_seen_at, '') DESC, ag.id ASC`,
    )
    .all(...ids, ...ids) as AgentNodeRow[];
  // The edge scan reuses the SAME resolved id list instead of re-deriving the
  // selection with a second ORDER BY/LIMIT subquery - nodes and edges can
  // never disagree about membership.
  const edgeRows = db
    .prepare(
      `SELECT ${EDGE_COLUMNS}
       FROM orchestration_edges
       WHERE parent_agent_id IN ${idList}
         AND child_agent_id IN ${idList}
       ORDER BY id ASC`,
    )
    .all(...ids, ...ids) as EdgeRow[];
  return {
    nodes: nodeRows.map(toAgentNode),
    edges: edgeRows.map(toEdge),
    counts: counts(nodeRows.length, edgeRows.length),
  };
}

/* -------------------------------------------------------------------------
 * M-9 (aggregate half) — corpus-wide delegation savings.
 *
 * The per-session route answers the same counterfactual from the JSONL
 * substrate. This one answers it from the STORED ROWS, and deliberately so:
 * a KPI on the cost page cannot re-parse every transcript in the corpus on
 * each cold request, and the DB is the project's declared ground truth for
 * token counts. Both paths feed the SAME pure `computeDelegationSavings`, so
 * the only question is whether the reconstruction below is faithful.
 *
 * It is, mechanically, for any session ingested by this server:
 *   - `token_usage` stores a complete (message_id, bucket) matrix — all five
 *     buckets, zero-token ones included — with the message-level settled
 *     `model` and `occurred_at` replicated across the five rows, so grouping
 *     by message_id reproduces a `DedupedUsage` exactly (see db/token-usage.ts);
 *   - the estimator reads only `{id, type, parentAgentId}` off each agent plus
 *     the usage rows — never `startedAt`/`endedAt`/`subagentType`/`edges`;
 *   - the one real translation is the main-agent key (see `mainAgentIds`).
 * `api-aggregate-savings-equivalence.test.ts` proves it end to end: ingest a
 * fixture, then assert this function equals the substrate-parsed per-session
 * figure to the micro-dollar.
 *
 * Where the two CAN diverge is where the database itself lacks the rows, and
 * every such case is either reported or provably zero:
 *   1. M-12 cross-session `message_id` ownership — when two transcripts (fork
 *      or resume) carry the same message id, the first-ingested session keeps
 *      it and the loser's rows are not written at all. The aggregate therefore
 *      counts that usage once, under the owning session; a per-session
 *      substrate analysis of the LOSING session counts it too. This one is not
 *      countable from the DB (the loser leaves no row) — the server's
 *      cross-session collision counter is the place that fact is surfaced.
 *   2. Retention prunes `token_usage` but never `agents`, so an old session can
 *      keep subagents with no usage. Those price to $0 honestly (no rows, no
 *      cost, no hypothetical) rather than erroring.
 *   3. A residual-cycle `parent_agent_id` nulled at ingest makes a subagent's
 *      top-tier model underivable — it self-reports in `subagentsSkipped`.
 *   4. Sessions on disk that were never ingested are outside `sessionsTotal`
 *      entirely, exactly as they are for every other DB-backed figure.
 * ------------------------------------------------------------------------- */

/**
 * The scan's universe. A session with no persisted subagent cannot contribute
 * a cent — the estimator sums over `type = 'subagent'` agents only — so it is
 * left out of the scan and reported as a measured zero
 * (`sessionsTotal - sessionsWithSubagents`), never as a gap.
 */
const DELEGATING_SESSIONS_CTE = `
  delegating AS (SELECT DISTINCT session_id FROM agents WHERE type = 'subagent')
`;

interface DelegationAgentRow {
  readonly id: string;
  readonly session_id: string;
  readonly type: ParsedAgent['type'];
  readonly subagent_type: string | null;
  readonly parent_agent_id: string | null;
}

/**
 * Agents of the delegating sessions. The `type IN (...)` filter is not
 * cosmetic: the column is nullable and a NULL type has no meaning in the
 * estimator's tree walk. Such rows are counted separately (`untypedAgents`)
 * so their exclusion is stated rather than silently applied.
 */
const DELEGATION_AGENTS_SQL = `
  WITH ${DELEGATING_SESSIONS_CTE}
  SELECT a.id AS id, a.session_id AS session_id, a.type AS type,
         a.subagent_type AS subagent_type, a.parent_agent_id AS parent_agent_id
  FROM agents a
  JOIN delegating d ON d.session_id = a.session_id
  WHERE a.type IN ('main', 'subagent')
  ORDER BY a.session_id ASC, a.id ASC
`;

interface DelegationUsageRow {
  readonly session_id: string;
  readonly message_id: string;
  readonly agent_id: string | null;
  readonly model: string;
  readonly occurred_at: string;
  readonly undated_rows: number;
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
}

/**
 * One row per stored message — the DB's own dedup, since ingest already
 * collapsed each `message.id` to its per-bucket maximum before writing.
 *
 * The `MAX()`s over `agent_id`/`model`/`occurred_at` are identities on
 * anything this server wrote (the writer settles all three at MESSAGE level
 * and replicates them across the five bucket rows); they exist so a
 * hand-inserted row set that disagrees resolves deterministically instead of
 * depending on scan order. `undated_rows` counts the timestamps SQLite cannot
 * price against — the session carrying any is excluded and named, never priced
 * from an empty date.
 */
const DELEGATION_USAGE_SQL = `
  WITH ${DELEGATING_SESSIONS_CTE}
  SELECT
    tu.session_id AS session_id,
    tu.message_id AS message_id,
    MAX(tu.agent_id) AS agent_id,
    MAX(tu.model) AS model,
    COALESCE(MAX(tu.occurred_at), '') AS occurred_at,
    SUM(CASE WHEN tu.occurred_at IS NULL THEN 1 ELSE 0 END) AS undated_rows,
    SUM(CASE WHEN tu.bucket = 'input' THEN tu.tokens ELSE 0 END) AS input,
    SUM(CASE WHEN tu.bucket = 'output' THEN tu.tokens ELSE 0 END) AS output,
    SUM(CASE WHEN tu.bucket = 'cache_read' THEN tu.tokens ELSE 0 END) AS cache_read,
    SUM(CASE WHEN tu.bucket = 'cache_write_5m' THEN tu.tokens ELSE 0 END) AS cache_write_5m,
    SUM(CASE WHEN tu.bucket = 'cache_write_1h' THEN tu.tokens ELSE 0 END) AS cache_write_1h
  FROM token_usage tu
  JOIN delegating d ON d.session_id = tu.session_id
  GROUP BY tu.session_id, tu.message_id
  ORDER BY tu.session_id ASC, tu.message_id ASC
`;

interface ReconstructedSession {
  readonly sessionId: string;
  readonly agents: ParsedAgent[];
  readonly usage: DedupedUsage[];
  /** Stored usage rows of this session that carry no timestamp. */
  undatedRows: number;
}

/**
 * Rebuild a `ParsedSession`-shaped value per delegating session, straight off
 * the stored rows. Module-private on purpose: the placeholder timestamps below
 * must never reach a DTO.
 */
function reconstructDelegatingSessions(db: SqliteDatabase): Map<string, ReconstructedSession> {
  const sessions = new Map<string, ReconstructedSession>();
  const entryFor = (sessionId: string): ReconstructedSession => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: ReconstructedSession = { sessionId, agents: [], usage: [], undatedRows: 0 };
    sessions.set(sessionId, created);
    return created;
  };
  // Agent ids are a global PRIMARY KEY, so one set spans the whole corpus.
  // Typed to accept the nullable usage column: `has(null)` is false and the
  // false arm returns that same null, so the inversion below needs no separate
  // null guard for usage rows that carry no agent id.
  const mainAgentIds = new Set<string | null>();

  for (const row of db.prepare(DELEGATION_AGENTS_SQL).all() as DelegationAgentRow[]) {
    entryFor(row.session_id).agents.push({
      id: row.id,
      type: row.type,
      subagentType: row.subagent_type,
      parentAgentId: row.parent_agent_id,
      // NOT measurements, and never presented as any. `computeDelegationSavings`
      // reads neither field; they exist only to satisfy `ParsedAgent`. Empty
      // strings rather than a fabricated timestamp, so a future core version
      // that starts reading them fails loudly instead of pricing a lie.
      startedAt: '',
      endedAt: '',
    });
    if (row.type === 'main') mainAgentIds.add(row.id);
  }

  for (const row of db.prepare(DELEGATION_USAGE_SQL).all() as DelegationUsageRow[]) {
    const entry = entryFor(row.session_id);
    entry.undatedRows += row.undated_rows;
    entry.usage.push({
      messageId: row.message_id,
      model: row.model,
      timestamp: row.occurred_at,
      // The one mandatory translation. Ingest stores the MAIN agent's usage
      // under that agent's id, while the parser — and therefore the estimator —
      // keys main-transcript usage as `null`. Without inverting it here, every
      // subagent whose nearest usage-bearing ancestor is the main agent would
      // be reported as having no derivable top-tier model.
      agentId: mainAgentIds.has(row.agent_id) ? null : row.agent_id,
      usage: {
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite5m: row.cache_write_5m,
        cacheWrite1h: row.cache_write_1h,
      },
    });
  }
  return sessions;
}

export interface AggregateDelegationSavingsOptions {
  /** WP-C5 rule-1 routing override, passed straight through to the estimator. */
  readonly topTierModel?: string;
}

/**
 * Corpus-wide delegation savings (M-9). Never refuses on account of one bad
 * session and never quietly drops one either: a session whose usage cannot be
 * priced is excluded from the sums AND named in `skippedSessions` with the
 * pricing error that caused it, so the reader can see the aggregate's true
 * scope. That follows the house precedent — `getCostSummary` reports
 * `unpricedTokens` rather than withholding the whole figure — and it is the
 * only choice that scales: on a corpus of hundreds of sessions, refusing
 * everything because one names an unknown model would make the KPI useless
 * exactly when it matters.
 */
export function getAggregateDelegationSavings(
  db: SqliteDatabase,
  pricing: readonly PricingEntry[],
  options: AggregateDelegationSavingsOptions = {},
): AggregateDelegationSavingsDto {
  const countOf = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const sessionsTotal = countOf('SELECT COUNT(*) AS n FROM sessions');
  const untypedAgents = countOf('SELECT COUNT(*) AS n FROM agents WHERE type IS NULL');
  const sessions = reconstructDelegatingSessions(db);
  const savingsOptions =
    options.topTierModel === undefined ? {} : { topTierModel: options.topTierModel };

  let actualUsd = 0;
  let hypotheticalUsd = 0;
  let savingsUsd = 0;
  let sessionsPriced = 0;
  let subagentsPriced = 0;
  let subagentsSkipped = 0;
  const hypotheticalModels = new Set<string>();
  const skipped: AggregateSavingsSkipDto[] = [];

  for (const entry of sessions.values()) {
    if (entry.undatedRows > 0) {
      // Pricing is date-driven; an empty timestamp has no rate, and inventing
      // one (say, "now") would silently reprice history.
      skipped.push({
        sessionId: entry.sessionId,
        reason: 'undated-usage',
        detail: `${String(entry.undatedRows)} stored usage row(s) carry no timestamp, so no dated rate applies`,
      });
      continue;
    }
    try {
      const result = computeDelegationSavings(
        {
          sessionId: entry.sessionId,
          agents: entry.agents,
          // The estimator walks `parentAgentId`; it never reads `edges`. An
          // equivalence test guards that claim against a core change.
          edges: [],
          usage: entry.usage,
        } satisfies ParsedSession,
        pricing,
        savingsOptions,
      );
      sessionsPriced += 1;
      actualUsd += result.actualUsd;
      hypotheticalUsd += result.hypotheticalUsd;
      savingsUsd += result.savingsUsd;
      subagentsPriced += result.perAgent.length;
      subagentsSkipped += result.skippedAgentIds.length;
      for (const agent of result.perAgent) hypotheticalModels.add(agent.hypotheticalModel);
    } catch (error) {
      if (!(error instanceof PricingError)) throw error; // → uniform detail-free 500
      skipped.push({ sessionId: entry.sessionId, reason: 'unpriceable', detail: error.message });
    }
  }

  return {
    actualUsd,
    hypotheticalUsd,
    savingsUsd,
    isEstimate: true,
    basis: 'stored-usage-rows',
    sessionsTotal,
    sessionsWithSubagents: sessions.size,
    sessionsPriced,
    // The COUNT is authoritative and uncapped; the array is a bounded sample so
    // one KPI request cannot turn a broken corpus into a huge payload.
    skippedSessionCount: skipped.length,
    skippedSessions: skipped.slice(0, MAX_AGGREGATE_SKIPPED_SAMPLE),
    subagentsPriced,
    subagentsSkipped,
    untypedAgents,
    hypotheticalModels: [...hypotheticalModels].sort(byBinary),
  };
}
