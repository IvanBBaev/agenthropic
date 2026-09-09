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
  type ChangesDto,
  type CostSummaryDto,
  type GlobalDagDto,
  type ModelCostDto,
  type OrchestrationEdgeDto,
  type SessionChangeKind,
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
  readonly outcome_cause: string | null;
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
    // Served as persisted. NULL is "no outcome was observed", not "succeeded",
    // and the five causes stay distinct - see AgentNodeSchema.
    outcomeCause: row.outcome_cause as AgentNodeDto['outcomeCause'],
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
         ag.outcome_cause AS outcome_cause,
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

/**
 * One `token_usage_rollup` row as the cost read consumes it (WP-U4 / M-19).
 *
 * `rate_effective_from` is the rollup's stored pointer at the `model_pricing`
 * row that WON the dated-rate resolution when the ledger row was written - or
 * '' for "no rate was in force". `bucket` is carried because the rate is keyed
 * by (model, bucket): it never reaches the DTO, it only completes the price
 * lookup.
 */
interface CostRollupRow {
  readonly session_id: string;
  readonly model: string;
  readonly bucket: string;
  readonly day: string;
  readonly rate_effective_from: string;
  readonly tokens: number;
}

interface CostBucket {
  tokens: number;
  costUsd: number;
  unpricedTokens: number;
}

function accumulate(into: Map<string, CostBucket>, key: string, add: CostBucket): void {
  const bucket = into.get(key) ?? { tokens: 0, costUsd: 0, unpricedTokens: 0 };
  bucket.tokens += add.tokens;
  bucket.costUsd += add.costUsd;
  bucket.unpricedTokens += add.unpricedTokens;
  into.set(key, bucket);
}

/** A `model_pricing` row with its join key derived exactly as migration 16 derives it. */
interface CanonicalPriceRow {
  readonly model: string;
  readonly bucket: string;
  readonly usd_per_mtok: number;
  readonly canonical_effective_from: string;
}

/**
 * Map key for a resolved price. The separator is U+0000, written as a JS
 * ESCAPE SEQUENCE and never as a literal control byte in this file: it is the
 * one code unit that cannot occur in a model id, a bucket name or an ISO-8601
 * instant, so ('a|b', 'c') and ('a', 'b|c') can never collide into one key.
 */
function rateKey(model: string, bucket: string, effectiveFrom: string): string {
  return [model, bucket, effectiveFrom].join('\u0000');
}

/**
 * The whole of `model_pricing` (~25 rows) as a lookup keyed by the rollup's
 * stored join key.
 *
 * `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` is applied here for the same reason
 * migration 16 applies it when WRITING `rate_effective_from`: deriving both
 * sides of the join through the identical expression makes them incapable of
 * drifting, even though migrations 14 and 15 already guarantee the stored text
 * is canonical. The `COALESCE` back to the raw text mirrors migration 16's
 * `at()` fallback and keeps the key total - a row whose `effective_from` is not
 * a date at all (unstorable through SQL since migration 14's guard trigger)
 * simply gets a key that no rollup row can ever name.
 *
 * A duplicate key is a LOUD THROW, not a last-one-wins overwrite. Two
 * `model_pricing` rows for one (model, bucket) that canonicalize to the same
 * instant would make a SQL LEFT JOIN emit the rollup row twice and DOUBLE its
 * dollars silently; there is no honest cost to report from that state, so the
 * read refuses to produce one. Migration 14's canonicalizing triggers make it
 * unreachable through SQL - the collision aborts on the primary key - so this
 * arm is a corruption tripwire, and the equivalence suite reaches it only by
 * dropping those triggers first.
 */
function readRateTable(db: SqliteDatabase): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT model, bucket, usd_per_mtok,
              COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', effective_from), effective_from)
                AS canonical_effective_from
         FROM model_pricing`,
    )
    .all() as CanonicalPriceRow[];
  const rates = new Map<string, number>();
  for (const row of rows) {
    const key = rateKey(row.model, row.bucket, row.canonical_effective_from);
    if (rates.has(key)) {
      throw new Error(
        `model_pricing holds two rows for model=${row.model} bucket=${row.bucket} ` +
          `effective_from=${row.canonical_effective_from} after canonicalization. ` +
          'Cost cannot be reported unambiguously; refusing to guess.',
      );
    }
    rates.set(key, row.usd_per_mtok);
  }
  return rates;
}

/**
 * The rate a priced rollup row was rolled up under.
 *
 * A miss means the rollup names a `model_pricing` row that is not there - and
 * the rollup's maintenance triggers recompute the whole (model, bucket) slice
 * on every pricing INSERT, UPDATE and DELETE, so in a live database this cannot
 * happen. It is therefore a torn-invariant report, never a reason to fall back
 * to $0: silently counting those tokens as unpriced would present real, priced
 * spend as unknown and hide the broken table that caused it.
 */
function rateFor(rates: Map<string, number>, row: CostRollupRow): number {
  const rate = rates.get(rateKey(row.model, row.bucket, row.rate_effective_from));
  if (rate === undefined) {
    throw new Error(
      `token_usage_rollup names a model_pricing row that does not exist: model=${row.model} ` +
        `bucket=${row.bucket} effective_from=${row.rate_effective_from}. ` +
        'The rollup is out of step with pricing; refusing to report a cost from it.',
    );
  }
  return rate;
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
 * read actually runs — on every cache MISS and on no cache hit — so a test can
 * prove a hit skipped the work by COUNTING, never by timing.
 *
 * M-19 kept the seam and its meaning while changing what it counts. Before the
 * cutover it counted a full priced scan of `token_usage`; it now counts the
 * `model_pricing` read plus the ordered scan of `token_usage_rollup`. In both
 * eras it also covers everything downstream of that read — the JS regroup, the
 * three sorts and the top-N slug lookup — because all of it sits below this
 * call and none of it runs on a hit. So the count still equals the whole of
 * the work a cache hit avoids: the probe reports no scan that has stopped
 * happening and hides none that still does.
 *
 * What it deliberately does NOT count is {@link costSummaryStateKey}, which
 * runs BEFORE the hit test and therefore on every request, hit or miss.
 */
export interface CostSummaryProbe {
  onScan(): void;
}

/**
 * Cheap self-validating state key for the cost-summary cache, recomputed on
 * every request. Since M-19 the cached dollars are computed from
 * `token_usage_rollup`, `sessions` (slug lookup) and `model_pricing` — and the
 * rollup is a trigger-maintained projection of `token_usage`, so a change to
 * the ledger is still a change to the answer. The key must therefore move
 * whenever any of those can have changed:
 *
 * - `total_changes()` counts every row this CONNECTION has inserted, updated
 *   or deleted, across all tables — verified empirically against
 *   better-sqlite3 (2026-08-12): ingest INSERTs, retention DELETEs and even
 *   an in-place UPDATE rewriting identical values all bump it. That covers
 *   `token_usage`, the rollup rows migration 16's triggers write behind it
 *   (a trigger's writes count as this connection's — re-verified 2026-08-31:
 *   one INSERT firing one trigger INSERT moves total_changes by 2) and
 *   `sessions` entirely, because only this server process writes them
 *   (single-writer by design: ingest and retention run on this same handle) —
 *   a hypothetical second writer to those tables is out of threat scope, and
 *   WAL locking makes it a misconfiguration, not a flow.
 * - `total_changes()` is blind to OTHER connections (also verified), and
 *   `model_pricing` is the one table with a documented cross-connection write
 *   path: the operator seeds rates via the sqlite3 CLI while the server runs.
 *   Such a write also rewrites the affected rollup slice through migration
 *   16's `model_pricing` triggers, on that other connection and so equally
 *   invisible here. So the table's full content rides in the key verbatim —
 *   ~25 rows (PROVISIONAL: the WP-C1 seed's size), a trivial read next to the
 *   rollup scan being avoided, and the one thing that makes a cross-connection
 *   repricing visible to this cache at all.
 *
 * The fingerprint is serialized in JS over an ORDER BY'd SELECT rather than
 * SQL group_concat, whose concatenation order SQLite does not guarantee.
 * False invalidations (e.g. an unrelated `events` INSERT, or a rolled-back
 * write — total_changes counts those too) merely recompute; outside an open
 * transaction the design errs only in the never-stale direction.
 *
 * INSIDE one it does not, and the qualifier above is load-bearing. MEASURED
 * 2026-08-31: `total_changes()` is monotonic and a ROLLBACK never moves it
 * back, so a summary computed and cached INSIDE a transaction or SAVEPOINT
 * keeps a key that is still current after that transaction is rolled back —
 * and the next read is a HIT serving dollars derived from rows that no longer
 * exist. Reproduced by deleting rollup rows inside a savepoint, reading (which
 * caches the post-delete answer), rolling back, and reading again: the second
 * read still reports the deleted state. This is NOT a cutover regression — the
 * pre-M-19 memo had the same key and the same hole — and it is not reachable
 * through the server, because better-sqlite3 is synchronous and no HTTP
 * handler can run inside ingest's or retention's transaction on this handle.
 * It is written down rather than fixed because the fix is a behaviour change
 * to an UNRATIFIED read path; anything that starts calling a query function
 * from inside a transaction must revisit it first.
 *
 * The never-stale direction is the right one to err in, but be honest about
 * its price: on a server with ingest running, a false invalidation is the
 * NORM, not the exception — every poll tick that writes anything at all moves
 * this key. So this key makes the cache correct for every read the server
 * actually performs; it was never what bounded the read, and after M-19 it
 * does not have to be — what bounds the read is the persisted rollup
 * {@link getCostSummary} now scans. See the note there.
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
  // M-19 — THE CUTOVER. This read is bounded by the persisted rollup.
  //
  // History, so the shape below is not mistaken for an accident. This function
  // used to price and group ALL of `token_usage` on every cold read, and
  // `token_usage` is the one table whose retention is deliberately refused —
  // cost history IS the product — so it grows with corpus age forever. The
  // one-entry memo below widened the cache's hit window but never bounded the
  // read: `total_changes()` moves on essentially every ingest tick, so on an
  // actively ingesting server nearly every /api/cost/summary read was a cold,
  // full scan. Re-measured 2026-08-31 on a SYNTHETIC 751,275-row ledger (1855
  // sessions, 38,825 rollup rows, the 25 seeded pricing rows plus one extra
  // rate epoch, ~176 MB database) built by a throwaway script — rows inserted
  // directly, not ingested — on an M4 Mac Mini under concurrent load: median
  // 947 ms of blocked event loop per cold read, spread 720-1351 ms over seven
  // reads on fresh handles. Treat the shape as the finding and the absolute
  // numbers as this corpus on this machine; a real ledger is not this tidy.
  //
  // Migration 16 installed `token_usage_rollup` — grain
  // (session_id, model, bucket, day, rate_effective_from), storing TOKENS and
  // the resolved pricing row's `effective_from`, never dollars — and keeps it
  // exact through triggers on both `token_usage` and `model_pricing`. This
  // function is the reader that migration's shadow-table note was waiting for.
  // Same ledger, same script — which measured the pre-cutover read by
  // transcribing it from git history and INTERLEAVED the two paths so neither
  // got the warmer page cache: median 58 ms, spread 34-78 ms, over the same
  // seven cold reads — a 16x cut at the medians. The spread is quoted rather
  // than a single flattering figure because that is what was observed. The
  // rollup grows with distinct (session, model, bucket, day, rate)
  // combinations rather than with message count, so the gap widens with
  // corpus age.
  //
  // WHY THE RATE IS APPLIED HERE AND NOT IN SQL. The rollup stores the WINNING
  // `effective_from`, so pricing is a lookup on a stored key, never a redo of
  // the dated-rate resolution — no `ORDER BY effective_from DESC LIMIT 1`
  // correlated subquery per row anywhere below. That lookup is done in JS
  // against a Map built from the whole of `model_pricing` (~25 rows) rather
  // than as a SQL LEFT JOIN, for two reasons. A LEFT JOIN that matched two
  // pricing rows would silently DOUBLE a cost with nothing able to report it;
  // building a Map makes that collision a loud throw (see readRateTable). And
  // doing the arithmetic in JS pins the float accumulation order instead of
  // leaving it to the query planner.
  //
  // FLOAT ACCUMULATION ORDER — a deliberate, documented change. The old path
  // summed one `tokens * rate / 1e6` term PER LEDGER ROW inside SQLite's
  // compensated SUM(); this one sums one term per rollup GROUP, over an exact
  // integer token total, in primary-key order. Those two cannot be
  // bit-identical in general, and the new order is the more accurate of the
  // two: strictly fewer floating-point additions over the same exact integers,
  // with the per-group token total carried as an integer until the single
  // multiplication. The order is PINNED by the ORDER BY below — the rollup is
  // WITHOUT ROWID, so primary-key order is its natural scan order and the sort
  // costs nothing — and test/api-cost-summary-equivalence.test.ts re-derives
  // the SAME grain in the SAME order straight from `token_usage` and asserts
  // exact equality, then compares against the pre-cutover ledger SQL to prove
  // no cent drifted. On the 751,275-row corpus measured above, the two paths
  // agree on every token count, on every unpriced-token count and on the order
  // of every list, and their dollars differ by 1.7e-10 USD on a $48,329.62
  // total — floating-point noise at the last representable bits. Which of the
  // two lands nearer the exact rational answer was NOT computed; the reason to
  // prefer this order is the structural argument above (strictly fewer
  // additions), not that measurement.
  //
  // NO FALLBACK. If `token_usage_rollup` is absent this SELECT throws and the
  // request fails loudly. There is deliberately no "scan the ledger instead"
  // arm: a silent fallback would hide a broken migration behind a whole-ledger
  // scan that merely feels slow, and would make the equivalence proof
  // unfalsifiable in production — the one place it matters.
  const stateKey = costSummaryStateKey(db);
  const cached = costSummaryCache.get(db);
  if (cached !== undefined && cached.stateKey === stateKey && cached.topN === topN) {
    return cached.summary;
  }
  // THE FATE OF THE MEMO (M-19, decided): it stays, demoted. It is no longer
  // load-bearing — the read below is bounded by rollup cardinality, not by
  // ledger size — but a repeat read on a quiescent connection still costs
  // 0.02 ms instead of 58 ms on the corpus measured above (median of twenty
  // warm-handle repeat reads), and deleting a correct, cheap, already-proven
  // behaviour would buy nothing. It is kept
  // BEHIND the same self-validating key, so it can still only ever be stale in
  // the never-stale direction. `probe.onScan()` therefore keeps its exact
  // meaning: it fires on a cache MISS and only on a miss. What it counts has
  // changed with this cutover, and its docstring says so.
  probe?.onScan();
  const rates = readRateTable(db);
  // ONE ordered scan of the rollup. `ORDER BY` names the primary key of a
  // WITHOUT ROWID table, so this is the table's own storage order: it pins the
  // summation order (above) without adding a sorter.
  const rollup = db
    .prepare(
      `SELECT session_id, model, bucket, day, rate_effective_from, tokens
         FROM token_usage_rollup
        ORDER BY session_id, model, bucket, day, rate_effective_from`,
    )
    .all() as CostRollupRow[];

  const totals: CostBucket = { tokens: 0, costUsd: 0, unpricedTokens: 0 };
  const byModel = new Map<string, CostBucket>();
  const byDay = new Map<string, CostBucket>();
  const bySession = new Map<string, CostBucket>();
  for (const row of rollup) {
    // '' is the rollup's encoding of "no rate was in force" — the priced CTE's
    // NULL rate. Those tokens are surfaced as unpriced and contribute $0; they
    // are never guessed at, and never dropped.
    const add: CostBucket =
      row.rate_effective_from === ''
        ? { tokens: row.tokens, costUsd: 0, unpricedTokens: row.tokens }
        : {
            tokens: row.tokens,
            costUsd: (row.tokens * rateFor(rates, row)) / 1000000,
            unpricedTokens: 0,
          };
    totals.tokens += add.tokens;
    totals.costUsd += add.costUsd;
    totals.unpricedTokens += add.unpricedTokens;
    accumulate(byModel, row.model, add);
    accumulate(byDay, row.day, add);
    accumulate(bySession, row.session_id, add);
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
         ag.outcome_cause AS outcome_cause,
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

// ==========================================================================
// WP-U11 - "what changed across sessions" (CD-10 daily question 5).
//
// Appended as a self-contained region ON PURPOSE. It reads `sessions`,
// `agents` and `token_usage` only; it imports nothing from the cost-summary
// region above and shares no state with it, so the UNRATIFIED M-19
// `token_usage_rollup` reader cutover can be reverted wholesale without
// touching a line of this.
//
// THE TWO TIMESTAMP REGIMES, and why this code treats them differently.
//
//   `token_usage.occurred_at` is CANONICAL by construction: migration 15
//   rewrote every stored value and installed guard + canonicalizing triggers,
//   so `YYYY-MM-DDTHH:mm:ss.sssZ` is the only spelling the column can hold.
//   Text comparison is therefore chronological comparison, and the raw column
//   is compared directly - which also keeps `idx_token_usage_occurred_at_id`
//   usable on the one table that grows without bound.
//
//   `sessions.started_at`, `sessions.last_activity_at` and
//   `agents.first_seen_at` carry NO such guarantee - nothing canonicalizes
//   them, and the corpus does contain second-precision and offset spellings.
//   Comparing those as raw text is silently wrong: '...T00:00:00Z' sorts
//   ABOVE '...T00:00:00.000Z' ('Z' > '.'), so a session would fall on the
//   wrong side of a boundary that names the very same instant. Every read of
//   those columns therefore goes through `strftime`, which normalizes the
//   spelling and folds a UTC offset onto the clock. A value `strftime` cannot
//   parse yields NULL and the row becomes UNDATED - counted in `coverage`,
//   never guessed into the window.
// ==========================================================================

/** The canonical instant spelling, derived rather than trusted. */
function canonicalInstant(expr: string): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', ${expr})`;
}

/**
 * The key that places a session in a window: its last observed activity,
 * falling back to its start. NULL (either column absent, or the chosen one
 * unparseable) means the session cannot be placed in ANY window - it is
 * reported in `coverage.undatedSessions` instead of being quietly dated.
 */
const SESSION_CHANGED_AT = canonicalInstant('COALESCE(s.last_activity_at, s.started_at)');
const SESSION_STARTED_AT = canonicalInstant('s.started_at');
const AGENT_APPEARED_AT = canonicalInstant('first_seen_at');

/** `(since, until]` over the session key. */
const SESSION_WINDOW = `${SESSION_CHANGED_AT} > ? AND ${SESSION_CHANGED_AT} <= ?`;

/**
 * Accepted `since` spellings: a bare UTC date, or an ISO-8601 instant that
 * carries its zone. A time WITHOUT a zone designator is rejected rather than
 * assumed to be UTC - ECMAScript reads it as local time, so accepting it would
 * silently answer a question about a different window than the one asked.
 */
export const ISO_INSTANT_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2}))?$';

const ISO_INSTANT = new RegExp(ISO_INSTANT_PATTERN);

/**
 * Validate and canonicalize a `since` argument. Returns NULL for anything that
 * is not an unambiguous instant; the caller answers 400. Nothing is defaulted
 * and nothing is repaired - a silently corrected boundary answers a different
 * question than the one that was asked, with no sign that it did.
 *
 * The calendar round-trip is not redundant with `Date.parse`: V8 rolls
 * '2026-02-30' forward to March 2 rather than rejecting it, so a request for a
 * day that does not exist would otherwise be answered for a different day.
 */
export function normalizeSinceInstant(raw: string): string | null {
  const datePart = raw.slice(0, 10);
  const dayOnly = new Date(`${datePart}T00:00:00.000Z`);
  const epochMs = Date.parse(raw);
  if (
    !ISO_INSTANT.test(raw) ||
    Number.isNaN(dayOnly.getTime()) ||
    dayOnly.toISOString().slice(0, 10) !== datePart ||
    Number.isNaN(epochMs)
  ) {
    return null;
  }
  return new Date(epochMs).toISOString();
}

/**
 * The window's upper boundary, taken from THE DATA rather than the clock.
 *
 * A wall-clock boundary would be wrong in the one direction that matters:
 * ingest lags event time, so `until = now` promises a window whose tail has
 * not been ingested yet, and a client chaining `since=until` would step over
 * those rows forever. The newest instant this endpoint can actually SEE - over
 * all three tables it reads - is the newest instant it can honestly promise.
 *
 * Clamped up to `since` so the window is never inverted: a `since` in the
 * future of the whole corpus yields the empty window `(since, since]`, which
 * is the truthful answer, not an error.
 */
function changesBoundary(db: SqliteDatabase, since: string): string {
  const row = db
    .prepare(
      `SELECT MAX(instant) AS latest FROM (
         SELECT MAX(${SESSION_CHANGED_AT}) AS instant FROM sessions s
         UNION ALL SELECT MAX(${AGENT_APPEARED_AT}) FROM agents
         UNION ALL SELECT MAX(occurred_at) FROM token_usage
       )`,
    )
    .get() as { readonly latest: string | null };
  return row.latest === null || row.latest < since ? since : row.latest;
}

interface ChangeClassRow {
  readonly total: number;
  readonly unknown_start: number;
  readonly new_count: number;
  readonly updated_count: number;
}

interface ChangedSessionRow {
  readonly id: string;
  readonly project_slug: string | null;
  readonly status: string | null;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly changed_at: string;
  readonly change_kind: SessionChangeKind;
}

interface WindowUsageRow {
  readonly session_id: string;
  readonly tokens: number;
  readonly cost_usd: number;
  readonly unpriced_tokens: number;
}

interface WindowAgentRow {
  readonly session_id: string;
  readonly appeared: number;
}

interface WindowTotalsRow {
  readonly tokens_added: number;
  readonly cost_added_usd: number;
  readonly unpriced_tokens_added: number;
  readonly tokens_outside: number;
}

interface ChangesCoverageRow {
  readonly undated_sessions: number;
  readonly undated_agents: number;
  readonly undated_usage_rows: number;
}

interface WindowMoney {
  readonly tokens: number;
  readonly cost: number;
  readonly unpriced: number;
}

/** A session with no usage dated inside the window added exactly nothing. */
const NO_WINDOW_MONEY: WindowMoney = { tokens: 0, cost: 0, unpriced: 0 };

/**
 * Every number in the answer, flattened for the sign/finiteness sweep below.
 */
function changeMeasurements(dto: ChangesDto): ReadonlyArray<readonly [string, number]> {
  const { totals, coverage } = dto;
  const entries: Array<readonly [string, number]> = [
    ['total', dto.total],
    ['totals.sessionsNew', totals.sessionsNew],
    ['totals.sessionsUpdated', totals.sessionsUpdated],
    ['totals.sessionsUnknownStart', totals.sessionsUnknownStart],
    ['totals.agentsAppeared', totals.agentsAppeared],
    ['totals.tokensAdded', totals.tokensAdded],
    ['totals.costAddedUsd', totals.costAddedUsd],
    ['totals.unpricedTokensAdded', totals.unpricedTokensAdded],
    ['totals.tokensAddedOutsideChangedSessions', totals.tokensAddedOutsideChangedSessions],
    ['coverage.undatedSessions', coverage.undatedSessions],
    ['coverage.undatedAgents', coverage.undatedAgents],
    ['coverage.undatedUsageRows', coverage.undatedUsageRows],
  ];
  for (const session of dto.sessions) {
    entries.push([`session ${session.id} agentsAppeared`, session.agentsAppeared]);
    entries.push([`session ${session.id} tokensAdded`, session.tokensAdded]);
    entries.push([`session ${session.id} costAddedUsd`, session.costAddedUsd]);
    entries.push([`session ${session.id} unpricedTokensAdded`, session.unpricedTokensAdded]);
  }
  return entries;
}

/**
 * THE LOUD HALF of this endpoint's honesty contract.
 *
 * `ChangesResponseSchema`'s `minimum: 0` does NOTHING at runtime:
 * fast-json-stringify serializes TO a schema, it does not validate AGAINST
 * one, so a negative or non-finite figure would be served with a cheerful HTTP
 * 200. These invariants are therefore asserted in CODE, and a violation
 * REFUSES the answer (the plugin error handler turns the throw into a
 * detail-free 500) rather than serving a confident wrong number.
 *
 * Every check here is a statement that must hold for ANY window over ANY
 * database. None of them is a plausibility heuristic - a heuristic that fires
 * on real data would train an operator to ignore it.
 *
 * Exported so the checks can be exercised directly against hand-built
 * payloads: a violation is by construction unreachable through the queries
 * above, and a rule that is only ever asserted on data that cannot break it is
 * not a tested rule.
 */
export function assertChangesInvariants(dto: ChangesDto): void {
  const problems: string[] = [];
  const { totals } = dto;

  if (dto.until < dto.since) {
    problems.push(`the window is inverted: until ${dto.until} precedes since ${dto.since}`);
  }
  const classified = totals.sessionsNew + totals.sessionsUpdated + totals.sessionsUnknownStart;
  if (classified !== dto.total) {
    problems.push(
      `classified ${String(classified)} session(s) but the window holds ${String(dto.total)}`,
    );
  }
  if (dto.sessions.length > dto.limit) {
    problems.push(
      `page of ${String(dto.sessions.length)} exceeds the limit ${String(dto.limit)} it was capped at`,
    );
  }
  if (dto.sessions.length > dto.total) {
    problems.push(
      `page of ${String(dto.sessions.length)} exceeds the window total ${String(dto.total)}`,
    );
  }
  if (totals.unpricedTokensAdded > totals.tokensAdded) {
    problems.push(
      `unpriced ${String(totals.unpricedTokensAdded)} exceeds the ${String(totals.tokensAdded)} tokens it is drawn from`,
    );
  }
  if (totals.tokensAddedOutsideChangedSessions > totals.tokensAdded) {
    problems.push(
      `unattributed ${String(totals.tokensAddedOutsideChangedSessions)} exceeds the ${String(totals.tokensAdded)} tokens in the window`,
    );
  }

  let pageTokens = 0;
  for (const session of dto.sessions) {
    pageTokens += session.tokensAdded;
    if (session.changedAt <= dto.since || session.changedAt > dto.until) {
      problems.push(
        `session ${session.id} changed at ${session.changedAt}, outside (${dto.since}, ${dto.until}]`,
      );
    }
    if (session.unpricedTokensAdded > session.tokensAdded) {
      problems.push(`session ${session.id} reports more unpriced tokens than tokens`);
    }
  }
  if (pageTokens > totals.tokensAdded) {
    problems.push(
      `the page sums to ${String(pageTokens)} tokens, more than the window's ${String(totals.tokensAdded)}`,
    );
  }

  for (const [label, value] of changeMeasurements(dto)) {
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`${label} is ${String(value)}, which is not a countable quantity`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`/api/changes computed an impossible answer: ${problems.join('; ')}`);
  }
}

/**
 * `GET /api/changes` - the delta between `since` and the newest instant this
 * database can vouch for, over the half-open window `(since, until]`.
 *
 * `totals` and `coverage` span the WHOLE window; `sessions` is one capped page
 * of it, ordered recent-first, with `total` saying how much of the window the
 * page shows. Summing a page would understate the window silently, so the two
 * are computed by separate queries rather than one being derived from the
 * other.
 */
export function getChanges(
  db: SqliteDatabase,
  since: string,
  limit: number,
  offset: number,
): ChangesDto {
  const until = changesBoundary(db, since);

  // Classification is over the whole window, not the page. A NULL
  // `started_at` matches neither comparison (SQL NULL is not orderable), so it
  // lands in `unknown_start` and nowhere else - the three counts partition the
  // window exactly, which the invariant check then re-proves.
  const classes = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN ${SESSION_STARTED_AT} IS NULL THEN 1 ELSE 0 END), 0) AS unknown_start,
         COALESCE(SUM(CASE WHEN ${SESSION_STARTED_AT} > ? THEN 1 ELSE 0 END), 0) AS new_count,
         COALESCE(SUM(CASE WHEN ${SESSION_STARTED_AT} <= ? THEN 1 ELSE 0 END), 0) AS updated_count
       FROM sessions s
       WHERE ${SESSION_WINDOW}`,
    )
    .get(since, since, since, until) as ChangeClassRow;

  // Which sessions are on this page is knowable from `sessions` alone, so the
  // page is resolved BEFORE any usage row is priced - the house idiom from
  // `listSessions`, for the same reason: pricing the whole ledger to return
  // one page of it makes the endpoint scale with corpus size, not page size.
  const pageRows = db
    .prepare(
      `SELECT
         s.id AS id,
         s.project_slug AS project_slug,
         s.status AS status,
         s.started_at AS started_at,
         s.last_activity_at AS last_activity_at,
         ${SESSION_CHANGED_AT} AS changed_at,
         CASE
           WHEN ${SESSION_STARTED_AT} IS NULL THEN 'unknown'
           WHEN ${SESSION_STARTED_AT} > ? THEN 'new'
           ELSE 'updated'
         END AS change_kind
       FROM sessions s
       WHERE ${SESSION_WINDOW}
       ORDER BY ${SESSION_CHANGED_AT} DESC, s.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(since, since, until, limit, offset) as ChangedSessionRow[];

  const money = new Map<string, WindowMoney>();
  const appeared = new Map<string, number>();
  const ids = pageRows.map((row) => row.id);
  if (ids.length > 0) {
    const placeholders = `(${ids.map(() => '?').join(', ')})`;
    const usageRows = db
      .prepare(
        `WITH ${pricedCte(
          `WHERE tu.session_id IN ${placeholders} AND tu.occurred_at > ? AND tu.occurred_at <= ?`,
        )}
         SELECT
           session_id,
           SUM(tokens) AS tokens,
           ${COST_USD} AS cost_usd,
           ${UNPRICED} AS unpriced_tokens
         FROM priced
         GROUP BY session_id`,
      )
      .all(...ids, since, until) as WindowUsageRow[];
    for (const row of usageRows) {
      money.set(row.session_id, {
        tokens: row.tokens,
        cost: row.cost_usd,
        unpriced: row.unpriced_tokens,
      });
    }
    const agentRows = db
      .prepare(
        `SELECT session_id, COUNT(*) AS appeared
         FROM agents
         WHERE session_id IN ${placeholders}
           AND ${AGENT_APPEARED_AT} > ? AND ${AGENT_APPEARED_AT} <= ?
         GROUP BY session_id`,
      )
      .all(...ids, since, until) as WindowAgentRow[];
    for (const row of agentRows) {
      appeared.set(row.session_id, row.appeared);
    }
  }

  // Window totals over the LEDGER, independent of which sessions changed.
  // "How many tokens were added in this window" is a question about usage
  // rows, and scoping it to the changed-session set would understate it. The
  // residue that belongs to no changed session is measured rather than
  // dropped, so the per-session breakdown's shortfall is always explained.
  const totalsRow = db
    .prepare(
      `WITH ${pricedCte('WHERE tu.occurred_at > ? AND tu.occurred_at <= ?')}
       SELECT
         COALESCE(SUM(tokens), 0) AS tokens_added,
         COALESCE(${COST_USD}, 0) AS cost_added_usd,
         COALESCE(${UNPRICED}, 0) AS unpriced_tokens_added,
         COALESCE(SUM(CASE WHEN session_id IN (
           SELECT s.id FROM sessions s WHERE ${SESSION_WINDOW}
         ) THEN 0 ELSE tokens END), 0) AS tokens_outside
       FROM priced`,
    )
    .get(since, until, since, until) as WindowTotalsRow;

  const agentsAppeared = (
    db
      .prepare(
        `SELECT COUNT(*) AS appeared FROM agents
         WHERE ${AGENT_APPEARED_AT} > ? AND ${AGENT_APPEARED_AT} <= ?`,
      )
      .get(since, until) as WindowAgentRow
  ).appeared;

  const coverage = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions s WHERE ${SESSION_CHANGED_AT} IS NULL) AS undated_sessions,
         (SELECT COUNT(*) FROM agents WHERE ${AGENT_APPEARED_AT} IS NULL) AS undated_agents,
         (SELECT COUNT(*) FROM token_usage WHERE occurred_at IS NULL) AS undated_usage_rows`,
    )
    .get() as ChangesCoverageRow;

  const dto: ChangesDto = {
    since,
    until,
    interval: '(since, until]',
    basis: 'event-time',
    sessions: pageRows.map((row) => {
      const added = money.get(row.id) ?? NO_WINDOW_MONEY;
      return {
        id: row.id,
        projectSlug: row.project_slug,
        status: row.status,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
        changedAt: row.changed_at,
        change: row.change_kind,
        agentsAppeared: appeared.get(row.id) ?? 0,
        tokensAdded: added.tokens,
        costAddedUsd: added.cost,
        unpricedTokensAdded: added.unpriced,
      };
    }),
    totals: {
      sessionsNew: classes.new_count,
      sessionsUpdated: classes.updated_count,
      sessionsUnknownStart: classes.unknown_start,
      agentsAppeared,
      tokensAdded: totalsRow.tokens_added,
      costAddedUsd: totalsRow.cost_added_usd,
      unpricedTokensAdded: totalsRow.unpriced_tokens_added,
      tokensAddedOutsideChangedSessions: totalsRow.tokens_outside,
    },
    coverage: {
      undatedSessions: coverage.undated_sessions,
      undatedAgents: coverage.undated_agents,
      undatedUsageRows: coverage.undated_usage_rows,
    },
    total: classes.total,
    limit,
    offset,
  };
  assertChangesInvariants(dto);
  return dto;
}
