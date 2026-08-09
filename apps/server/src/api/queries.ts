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

export function getCostSummary(db: SqliteDatabase, topN: number): CostSummaryDto {
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

  return {
    totals,
    perModel,
    perDay,
    topSessions: top.map(([sessionId, bucket]) => ({
      sessionId,
      projectSlug: slugs.get(sessionId) ?? null,
      ...bucket,
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
