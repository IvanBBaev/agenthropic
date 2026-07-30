/**
 * WP-D6 - upsert path for agents, the first-class queryable entities whose
 * self-referential parent_agent_id makes the subagent tree a data fact.
 *
 * Idempotent replay lives in the storage engine: ON CONFLICT(id) DO UPDATE
 * refreshes the mutable projection (type, subagent_type, status, parent, and
 * the seen-at timestamps) while leaving session_id - the immutable owning
 * session - untouched. Foreign keys (session_id -> sessions, parent_agent_id
 * -> agents self) are enforced by the WP-D2 connection pragmas; the CALLER
 * guarantees the session and any referenced parent agent are inserted first.
 */
import type { AgentStatus, AgentType } from '@agenthropic/shared';
import type { SqliteDatabase } from './connection';

export interface AgentUpsert {
  readonly id: string;
  readonly sessionId: string;
  readonly type: AgentType;
  readonly subagentType: string | null;
  readonly status: AgentStatus;
  readonly parentAgentId: string | null;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
}

/** One non-terminal agent row projected for the WP-IN12 watchdog decision. */
export interface WatchdogCandidate {
  readonly id: string;
  readonly sessionId: string;
  readonly status: AgentStatus | null;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
}

interface WatchdogCandidateRow {
  readonly id: string;
  readonly session_id: string;
  readonly status: AgentStatus | null;
  readonly first_seen_at: string | null;
  readonly last_seen_at: string | null;
}

/**
 * Agents still in a non-terminal state — the watchdog's candidate set. Rows
 * whose status is already terminal ('completed' / 'error' / 'unknown') are
 * excluded HERE so the sweep can never re-fire a transition for an agent it
 * has already marked 'unknown'.
 */
export function listWatchdogCandidates(db: SqliteDatabase): WatchdogCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, status, first_seen_at, last_seen_at
         FROM agents
        WHERE status IN ('working', 'waiting') OR status IS NULL`,
    )
    .all() as WatchdogCandidateRow[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}

/** Point status update used by the watchdog; never touches any other column. */
export function setAgentStatus(db: SqliteDatabase, id: string, status: AgentStatus): void {
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
}

export function upsertAgent(db: SqliteDatabase, row: AgentUpsert): void {
  db.prepare(
    `INSERT INTO agents
       (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type            = excluded.type,
       subagent_type   = excluded.subagent_type,
       status          = excluded.status,
       parent_agent_id = excluded.parent_agent_id,
       first_seen_at   = excluded.first_seen_at,
       last_seen_at    = excluded.last_seen_at`,
  ).run(
    row.id,
    row.sessionId,
    row.type,
    row.subagentType,
    row.status,
    row.parentAgentId,
    row.firstSeenAt,
    row.lastSeenAt,
  );
}
