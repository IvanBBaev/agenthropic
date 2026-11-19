/**
 * Session list, detail, tree and hook-event reads.
 *
 * Split out of `api/queries.ts` (ARC-4, 2026-11-19), which stays the public
 * entry point and re-exports this module. The cost and honesty rules that
 * govern every read here are documented at the top of that file.
 */
import {
  type AgentNodeDto,
  type ModelCostDto,
  type OrchestrationEdgeDto,
  type SessionDetailDto,
  type SessionEventsDto,
  type SessionPartialDto,
  type SessionSummaryDto,
  type SessionTreeDto,
} from '@agenthropic/shared';
import type { SqliteDatabase } from '../../db/connection';
import { COST_USD, PRICED_CTE, UNPRICED, canonicalInstant, pricedCte } from './shared';

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
      SUM(CASE WHEN status IS NULL OR status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
      SUM(CASE WHEN outcome_cause = 'concurrency_limit' THEN 1 ELSE 0 END) AS cause_concurrency_limit,
      SUM(CASE WHEN outcome_cause = 'user_interrupt' THEN 1 ELSE 0 END) AS cause_user_interrupt,
      SUM(CASE WHEN outcome_cause = 'permission_failed' THEN 1 ELSE 0 END) AS cause_permission_failed,
      SUM(CASE WHEN outcome_cause = 'dispatch_unavailable' THEN 1 ELSE 0 END) AS cause_dispatch_unavailable,
      SUM(CASE WHEN outcome_cause = 'terminated_early' THEN 1 ELSE 0 END) AS cause_terminated_early,
      SUM(CASE WHEN outcome_cause = 'unclassified' THEN 1 ELSE 0 END) AS cause_unclassified
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
    COALESCE(a.cause_concurrency_limit, 0) AS cause_concurrency_limit,
    COALESCE(a.cause_user_interrupt, 0) AS cause_user_interrupt,
    COALESCE(a.cause_permission_failed, 0) AS cause_permission_failed,
    COALESCE(a.cause_dispatch_unavailable, 0) AS cause_dispatch_unavailable,
    COALESCE(a.cause_terminated_early, 0) AS cause_terminated_early,
    COALESCE(a.cause_unclassified, 0) AS cause_unclassified,
    COALESCE(u.total_tokens, 0) AS total_tokens,
    COALESCE(u.cost_usd, 0) AS cost_usd,
    COALESCE(u.unpriced_tokens, 0) AS unpriced_tokens,
    s.partial_reason AS partial_reason,
    s.partial_skipped_bytes AS partial_skipped_bytes,
    s.usage_records_dropped AS usage_records_dropped
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
  readonly cause_concurrency_limit: number;
  readonly cause_user_interrupt: number;
  readonly cause_permission_failed: number;
  readonly cause_dispatch_unavailable: number;
  readonly cause_terminated_early: number;
  readonly cause_unclassified: number;
  readonly total_tokens: number;
  readonly cost_usd: number;
  readonly unpriced_tokens: number;
  readonly partial_reason: string | null;
  readonly partial_skipped_bytes: number | null;
  readonly usage_records_dropped: number;
}

/**
 * The per-session honesty columns (owner decisions 1 and 2), as their DTO
 * fields. `partial_reason` is CHECK-constrained to the one reason the schema
 * knows, so the cast only restates what the migration enforces; a null reason
 * is a whole read whatever the byte column says.
 */
export function toHonesty(
  reason: string | null,
  skippedBytes: number | null,
  usageRecordsDropped: number,
): { partial: SessionPartialDto | null; usageRecordsDropped: number } {
  return {
    partial:
      reason === null ? null : { reason: reason as SessionPartialDto['reason'], skippedBytes },
    usageRecordsDropped,
  };
}

export interface HonestyRow {
  readonly partial_reason: string | null;
  readonly partial_skipped_bytes: number | null;
  readonly usage_records_dropped: number;
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
    // D9: one bucket per persisted cause; NULL-cause agents count nowhere.
    outcomeCauseCounts: {
      concurrency_limit: row.cause_concurrency_limit,
      user_interrupt: row.cause_user_interrupt,
      permission_failed: row.cause_permission_failed,
      dispatch_unavailable: row.cause_dispatch_unavailable,
      terminated_early: row.cause_terminated_early,
      unclassified: row.cause_unclassified,
    },
    ...toHonesty(row.partial_reason, row.partial_skipped_bytes, row.usage_records_dropped),
  };
}

/**
 * UX-12: optional narrowing of the session list. `status` is an exact match on
 * the stored session status; `search` is a case-insensitive substring of the
 * session id OR the project slug. `instr` rather than `LIKE`, so a `%` or `_`
 * the reader types is matched literally instead of as a wildcard.
 */
export interface SessionListFilter {
  readonly status?: string;
  readonly search?: string;
}

function sessionFilterWhere(filter: SessionListFilter): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status !== undefined) {
    clauses.push('s.status = ?');
    params.push(filter.status);
  }
  if (filter.search !== undefined) {
    clauses.push(
      "(instr(lower(s.id), lower(?)) > 0 OR instr(lower(COALESCE(s.project_slug, '')), lower(?)) > 0)",
    );
    params.push(filter.search, filter.search);
  }
  return { sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, params };
}

/** Sessions matching `filter` (all of them when it is empty). */
export function countSessions(db: SqliteDatabase, filter: SessionListFilter = {}): number {
  const where = sessionFilterWhere(filter);
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM sessions s ${where.sql}`)
    .get(...where.params) as { c: number };
  return row.c;
}

// SA-Z1: recent-first by INSTANT, not by stored text. These columns are not
// canonicalized (see the timestamp-regime note at the top of `changes.ts`), and as raw text
// '...T00:00:00Z' sorts above '...T00:00:00.500Z' and an offset spelling sorts
// by its local wall clock - the list head would not be the latest session.
// NULL (no timestamp, or one strftime cannot parse) sorts last under DESC.
const SESSION_PAGE_ORDER = `${canonicalInstant('COALESCE(s.last_activity_at, s.started_at)')} DESC, s.id ASC`;

/** Recent-first page of session summaries (WP-U3). */
export function listSessions(
  db: SqliteDatabase,
  limit: number,
  offset: number,
  filter: SessionListFilter = {},
): SessionSummaryDto[] {
  // Resolve WHICH sessions are on this page before pricing anything: the
  // ordering key lives entirely on `sessions`, so the page is knowable without
  // reading a single `token_usage` row. Pricing the whole usage table only to
  // return one page of it is what made this endpoint scale with corpus size
  // instead of page size.
  const where = sessionFilterWhere(filter);
  const ids = (
    db
      .prepare(
        `SELECT s.id AS id FROM sessions s ${where.sql} ORDER BY ${SESSION_PAGE_ORDER} LIMIT ? OFFSET ?`,
      )
      .all(...where.params, limit, offset) as Array<{ id: string }>
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

export interface AgentNodeRow {
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

export function toAgentNode(row: AgentNodeRow): AgentNodeDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type as AgentNodeDto['type'],
    subagentType: row.subagent_type,
    status: row.status as AgentNodeDto['status'],
    // Served as persisted. NULL is "no outcome was observed", not "succeeded",
    // and the six causes stay distinct - see AgentNodeSchema.
    outcomeCause: row.outcome_cause as AgentNodeDto['outcomeCause'],
    parentAgentId: row.parent_agent_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    unpricedTokens: row.unpriced_tokens,
  };
}

export interface EdgeRow {
  readonly id: number;
  readonly session_id: string;
  readonly parent_agent_id: string;
  readonly child_agent_id: string;
  readonly source: string;
  readonly instance: string;
  readonly host_id: string;
  readonly created_at: string | null;
}

export function toEdge(row: EdgeRow): OrchestrationEdgeDto {
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

export const EDGE_COLUMNS =
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
  const honesty = db
    .prepare(
      `SELECT partial_reason, partial_skipped_bytes, usage_records_dropped
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as HonestyRow | undefined;
  if (honesty === undefined) {
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
       ORDER BY COALESCE(${canonicalInstant('ag.first_seen_at')}, '') ASC, ag.id ASC`,
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
    ...toHonesty(
      honesty.partial_reason,
      honesty.partial_skipped_bytes,
      honesty.usage_records_dropped,
    ),
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
