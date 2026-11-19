/**
 * The global agent DAG read and its per-session usage cache.
 *
 * Split out of `api/queries.ts` (ARC-4, 2026-11-19), which stays the public
 * entry point and re-exports this module. The cost and honesty rules that
 * govern every read here are documented at the top of that file.
 */
import { type GlobalDagDto } from '@agenthropic/shared';
import type { SqliteDatabase } from '../../db/connection';
import { ledgerEpoch } from '../../db/ledger-epoch';
import { COST_USD, UNPRICED, canonicalInstant, pricedCte } from './shared';
import { type AgentNodeRow, EDGE_COLUMNS, type EdgeRow, toAgentNode, toEdge } from './sessions';
import { pricingFingerprint } from './cost';
import { UNSTAMPED } from './savings';

/** An agent row of the global DAG, with its session's change stamp. */
interface DagAgentRow extends Omit<AgentNodeRow, 'total_tokens' | 'cost_usd' | 'unpriced_tokens'> {
  /** `sessions.ingest_seq`, or null when the sessions row is missing. */
  readonly ingest_seq: number | null;
}

/** One agent's usage rollup inside its own session. */
interface DagAgentUsage {
  readonly total_tokens: number;
  readonly cost_usd: number;
  readonly unpriced_tokens: number;
}

/** Test seam: observes every session whose agent usage is re-priced. */
export interface GlobalDagProbe {
  onSessionPriced(sessionId: string): void;
}

/**
 * Row-1 performance - per-session agent usage behind `/api/dag/global`.
 *
 * Measured 2026-11-13 on the real corpus: the top-1000 agents own ~392k of
 * ~1.21M usage rows, and every one of them runs the correlated pricing
 * subquery on every DAG read. Almost all of those sessions are finished, so
 * the rollup is cached per session and re-priced only when it can have moved.
 *
 * Never-stale contract, the same as the delegation-savings cache:
 *   - a session's entry is served only while its `ingest_seq` stamp is
 *     unchanged - migration 22 bumps it on every value-changing INSERT/UPDATE
 *     of its sessions/agents/token_usage rows;
 *   - DELETEs stamp nothing, so the whole cache is keyed on `data_version`
 *     (another connection committed) and the ledger epoch (retention deleted
 *     on this connection), plus the pricing table (rates are not stamped);
 *   - a session with no sessions row has no stamp and is re-priced every time.
 * The per-session map is rebuilt from the current selection on each read, so
 * it holds at most `nodeLimit` sessions.
 */
const dagUsageCache = new WeakMap<
  SqliteDatabase,
  {
    readonly globalKey: string;
    readonly perSession: Map<string, { seq: number; usage: Map<string, DagAgentUsage> }>;
  }
>();

const DAG_SESSION_USAGE_SQL = `WITH ${pricedCte('WHERE tu.session_id = ?')}
  SELECT agent_id, SUM(tokens) AS total_tokens, ${COST_USD} AS cost_usd, ${UNPRICED} AS unpriced_tokens
  FROM priced
  WHERE agent_id IS NOT NULL
  GROUP BY agent_id`;

function dagUsageBySession(
  db: SqliteDatabase,
  agentRows: readonly DagAgentRow[],
  probe: GlobalDagProbe | undefined,
): Map<string, Map<string, DagAgentUsage>> {
  // Read through `prepare`, the only surface getGlobalDag uses (the M-5
  // scoping test wraps the connection in a prepare-only spy).
  const { data_version: dataVersion } = db.prepare('PRAGMA data_version').get() as {
    data_version: number;
  };
  const globalKey = JSON.stringify([dataVersion, ledgerEpoch(db), pricingFingerprint(db)]);
  const cached = dagUsageCache.get(db);
  const previous = cached?.globalKey === globalKey ? cached.perSession : undefined;
  const perSession = new Map<string, { seq: number; usage: Map<string, DagAgentUsage> }>();
  const usageStmt = db.prepare(DAG_SESSION_USAGE_SQL);
  for (const row of agentRows) {
    if (perSession.has(row.session_id)) {
      continue;
    }
    const seq = row.ingest_seq ?? UNSTAMPED;
    const hit = previous?.get(row.session_id);
    if (hit !== undefined && seq !== UNSTAMPED && hit.seq === seq) {
      perSession.set(row.session_id, hit);
      continue;
    }
    probe?.onSessionPriced(row.session_id);
    const usage = new Map<string, DagAgentUsage>();
    for (const u of usageStmt.all(row.session_id) as Array<DagAgentUsage & { agent_id: string }>) {
      usage.set(u.agent_id, {
        total_tokens: u.total_tokens,
        cost_usd: u.cost_usd,
        unpriced_tokens: u.unpriced_tokens,
      });
    }
    perSession.set(row.session_id, { seq, usage });
  }
  dagUsageCache.set(db, { globalKey, perSession });
  const result = new Map<string, Map<string, DagAgentUsage>>();
  for (const [sessionId, entry] of perSession) {
    result.set(sessionId, entry.usage);
  }
  return result;
}

/** Recent-first agent order by instant, for an optional table alias prefix. */
function agentRecencyOrder(alias: string): string {
  return `COALESCE(${canonicalInstant(`COALESCE(${alias}last_seen_at, ${alias}first_seen_at)`)}, '') DESC, ${alias}id ASC`;
}

/**
 * The persisted cross-session DAG, capped at `nodeLimit` recent-first agent
 * nodes. Returned edges are those whose BOTH endpoints made the cap, so no
 * returned edge names an agent outside `nodes`. Each node's `parentAgentId`
 * is NOT subject to the cap: it is the persisted data fact served as-is, so a
 * capped read can carry a node whose parent fell outside the returned set
 * (F4, 2026-09-26). That is deliberate - the subagent tree is a data fact,
 * not a UI reconstruction - and the client draws its links from `edges`, which
 * is the capped surface. `counts` carries the full totals and a `truncated`
 * flag so the cap is always visible, never silent.
 */
export function getGlobalDag(
  db: SqliteDatabase,
  nodeLimit: number,
  probe?: GlobalDagProbe,
): GlobalDagDto {
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
  // never touches token_usage. Usage is then priced per SELECTED session
  // through `dagUsageBySession` (cached by ingest_seq). Parameter count is bounded by
  // MAX_DAG_NODE_LIMIT (5000) bound twice per statement - well under
  // SQLite's default variable cap (32766).
  const ids = (
    db
      .prepare(
        // SA-Z1: the cap keeps the most recent agents by INSTANT; a raw-text
        // order would keep an older agent and drop a newer one while
        // `truncated` presents the cap as the recent-first cut it claims.
        `SELECT id FROM agents
         ORDER BY ${agentRecencyOrder('')}
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
  const agentRows = db
    .prepare(
      `SELECT
         ag.id AS id, ag.session_id AS session_id, ag.type AS type,
         ag.subagent_type AS subagent_type, ag.status AS status,
         ag.outcome_cause AS outcome_cause,
         ag.parent_agent_id AS parent_agent_id,
         ag.first_seen_at AS first_seen_at, ag.last_seen_at AS last_seen_at,
         s.ingest_seq AS ingest_seq
       FROM agents ag
       LEFT JOIN sessions s ON s.id = ag.session_id
       WHERE ag.id IN ${idList}
       ORDER BY ${agentRecencyOrder('ag.')}`,
    )
    .all(...ids) as DagAgentRow[];
  const usage = dagUsageBySession(db, agentRows, probe);
  const nodeRows = agentRows.map((row): AgentNodeRow => {
    // Scoped to the agent's OWN session, as the session tree scopes it: a
    // usage row in another session that names this agent id is that
    // session's unattributed usage, never this node's (no FK forbids it).
    const totals = usage.get(row.session_id)?.get(row.id);
    return {
      id: row.id,
      session_id: row.session_id,
      type: row.type,
      subagent_type: row.subagent_type,
      status: row.status,
      outcome_cause: row.outcome_cause,
      parent_agent_id: row.parent_agent_id,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      total_tokens: totals?.total_tokens ?? 0,
      cost_usd: totals?.cost_usd ?? 0,
      unpriced_tokens: totals?.unpriced_tokens ?? 0,
    };
  });
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
