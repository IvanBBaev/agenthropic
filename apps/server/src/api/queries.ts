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
import type {
  AgentNodeDto,
  CostSummaryDto,
  GlobalDagDto,
  ModelCostDto,
  OrchestrationEdgeDto,
  SessionDetailDto,
  SessionEventsDto,
  SessionSummaryDto,
  SessionTreeDto,
} from '@agenthropic/shared';
import type { SqliteDatabase } from '../db/connection';

/**
 * Shared CTE: every `token_usage` row with its resolved USD/Mtok rate (NULL
 * when no dated price applies). ISO-8601 strings compare correctly as text,
 * so `effective_from <= occurred_at` needs no date parsing.
 */
const PRICED_CTE = `
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
  )
`;

/** USD over PRICED rows only - unpriced rows contribute $0, never a guess. */
const COST_USD = `SUM(CASE WHEN rate IS NOT NULL THEN tokens * rate / 1000000.0 ELSE 0 END)`;

/** Tokens whose rate could not be resolved - surfaced, never hidden. */
const UNPRICED = `SUM(CASE WHEN rate IS NULL THEN tokens ELSE 0 END)`;

const SESSION_SUMMARY_SELECT = `
  WITH ${PRICED_CTE},
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
`;

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

/** Recent-first page of session summaries (WP-U3). */
export function listSessions(
  db: SqliteDatabase,
  limit: number,
  offset: number,
): SessionSummaryDto[] {
  const rows = db
    .prepare(
      `${SESSION_SUMMARY_SELECT}
       ORDER BY COALESCE(s.last_activity_at, s.started_at) DESC, s.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as SessionSummaryRow[];
  return rows.map(toSessionSummary);
}

function getSessionSummary(db: SqliteDatabase, sessionId: string): SessionSummaryDto | undefined {
  const row = db.prepare(`${SESSION_SUMMARY_SELECT} WHERE s.id = ?`).get(sessionId) as
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
 * bucket - rows whose agent_id is NULL (main-agent turns awaiting backfill)
 * or points outside this session's agents. Undefined for an unknown session.
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
export function getCostSummary(db: SqliteDatabase, topN: number): CostSummaryDto {
  const totals = db
    .prepare(
      `WITH ${PRICED_CTE}
       SELECT
         COALESCE(SUM(tokens), 0) AS tokens,
         COALESCE(${COST_USD}, 0) AS cost_usd,
         COALESCE(${UNPRICED}, 0) AS unpriced_tokens
       FROM priced`,
    )
    .get() as { tokens: number; cost_usd: number; unpriced_tokens: number };
  const perModel = db
    .prepare(
      `WITH ${PRICED_CTE}
       SELECT model, SUM(tokens) AS tokens, ${COST_USD} AS cost_usd, ${UNPRICED} AS unpriced_tokens
       FROM priced
       GROUP BY model
       ORDER BY cost_usd DESC, model ASC`,
    )
    .all() as ModelCostRow[];
  const perDay = db
    .prepare(
      `WITH ${PRICED_CTE}
       SELECT
         CASE WHEN occurred_at IS NULL THEN 'unknown' ELSE substr(occurred_at, 1, 10) END AS day,
         SUM(tokens) AS tokens, ${COST_USD} AS cost_usd, ${UNPRICED} AS unpriced_tokens
       FROM priced
       GROUP BY day
       ORDER BY (day = 'unknown') ASC, day DESC`,
    )
    .all() as Array<{ day: string; tokens: number; cost_usd: number; unpriced_tokens: number }>;
  const topSessions = db
    .prepare(
      `WITH ${PRICED_CTE}
       SELECT
         p.session_id AS session_id,
         s.project_slug AS project_slug,
         SUM(p.tokens) AS tokens,
         ${COST_USD} AS cost_usd,
         ${UNPRICED} AS unpriced_tokens
       FROM priced p
       LEFT JOIN sessions s ON s.id = p.session_id
       GROUP BY p.session_id
       ORDER BY cost_usd DESC, session_id ASC
       LIMIT ?`,
    )
    .all(topN) as Array<{
    session_id: string;
    project_slug: string | null;
    tokens: number;
    cost_usd: number;
    unpriced_tokens: number;
  }>;
  return {
    totals: {
      tokens: totals.tokens,
      costUsd: totals.cost_usd,
      unpricedTokens: totals.unpriced_tokens,
    },
    perModel: perModel.map(toModelCost),
    perDay: perDay.map((row) => ({
      day: row.day,
      tokens: row.tokens,
      costUsd: row.cost_usd,
      unpricedTokens: row.unpriced_tokens,
    })),
    topSessions: topSessions.map((row) => ({
      sessionId: row.session_id,
      projectSlug: row.project_slug,
      tokens: row.tokens,
      costUsd: row.cost_usd,
      unpricedTokens: row.unpriced_tokens,
    })),
  };
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
  const nodeRows = db
    .prepare(
      `WITH ${PRICED_CTE},
       usage_by_agent AS (
         SELECT agent_id, SUM(tokens) AS total_tokens, ${COST_USD} AS cost_usd, ${UNPRICED} AS unpriced_tokens
         FROM priced
         WHERE agent_id IS NOT NULL
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
       ORDER BY COALESCE(ag.last_seen_at, ag.first_seen_at, '') DESC, ag.id ASC
       LIMIT ?`,
    )
    .all(nodeLimit) as AgentNodeRow[];
  const edgeRows = db
    .prepare(
      `WITH selected AS (
         SELECT id FROM agents
         ORDER BY COALESCE(last_seen_at, first_seen_at, '') DESC, id ASC
         LIMIT ?
       )
       SELECT ${EDGE_COLUMNS}
       FROM orchestration_edges
       WHERE parent_agent_id IN (SELECT id FROM selected)
         AND child_agent_id IN (SELECT id FROM selected)
       ORDER BY id ASC`,
    )
    .all(nodeLimit) as EdgeRow[];
  return {
    nodes: nodeRows.map(toAgentNode),
    edges: edgeRows.map(toEdge),
    counts: {
      totalSessions,
      totalAgents,
      totalEdges,
      returnedAgents: nodeRows.length,
      returnedEdges: edgeRows.length,
      truncated: nodeRows.length < totalAgents,
    },
  };
}
