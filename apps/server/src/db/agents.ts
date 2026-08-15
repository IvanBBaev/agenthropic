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
 *
 * `status` is the ONE column the upsert does not simply overwrite - see the
 * CASE in {@link upsertAgent}.
 */
import type { AgentStatus, AgentType } from '@agenthropic/shared';
import type { AgentStatusChangedEvent } from '../ingest/ingest-events';
import type { SqliteDatabase } from './connection';

export interface AgentUpsert {
  readonly id: string;
  readonly sessionId: string;
  readonly type: AgentType;
  readonly subagentType: string | null;
  /**
   * The status to assert for a FIRST sighting or for genuinely NEW activity.
   * It is not applied unconditionally: an already-observed terminal verdict is
   * sticky and an unchanged replay is a no-op (see {@link upsertAgent}).
   */
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

/**
 * The status arm of the upsert, kept here so the rule is readable in one place.
 *
 * Three properties this CASE has to hold simultaneously:
 *
 *  1. OBSERVED TERMINALS ARE STICKY. Once a hook has observed a subagent stop
 *     ('completed') or an error was recorded, a later transcript flush of the
 *     SAME bytes must not resurrect it as 'working'. Reading a transcript
 *     proves activity happened, never that it is still happening.
 *  2. INFERRED STATES YIELD TO EVIDENCE. 'unknown' (watchdog guess) and
 *     'waiting' (idle between turns) revert to 'working' the moment the
 *     transcript proves NEW activity — this is the OPEN-2 revert rule.
 *  3. AN UNCHANGED REPLAY IS A NO-OP. The decision reads ONLY JSONL
 *     timestamps, never the wall clock, and requires `last_seen_at` to
 *     STRICTLY ADVANCE. Re-ingesting identical bytes therefore writes an
 *     identical row — which is what the P0 byte-identical double-replay proof
 *     pins.
 */
const AGENT_STATUS_CASE = `CASE
         WHEN agents.status IN ('completed', 'error') THEN agents.status
         WHEN agents.status IS NULL THEN excluded.status
         WHEN excluded.last_seen_at IS NOT NULL
          AND (agents.last_seen_at IS NULL OR excluded.last_seen_at > agents.last_seen_at)
           THEN excluded.status
         ELSE agents.status
       END`;

export interface AgentUpsertResult {
  /** True when the row did not exist before this call — a FIRST sighting. */
  readonly inserted: boolean;
}

export function upsertAgent(db: SqliteDatabase, row: AgentUpsert): AgentUpsertResult {
  // First-sighting probe (M-13). A SubagentStop hook that fires before the
  // transcript is ever parsed is stored as raw liveness and changes no row
  // (CD-1) — the projection replays it the moment the row is CREATED, so it
  // must know which upserts were first sightings. `info.changes` cannot tell:
  // ON CONFLICT ... DO UPDATE reports 1 for insert and update alike. The
  // probe-then-write pair is race-free because every caller runs on the
  // single write connection, inside the projection transaction.
  const existing = db.prepare('SELECT 1 FROM agents WHERE id = ?').get(row.id);
  db.prepare(
    `INSERT INTO agents
       (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type            = excluded.type,
       subagent_type   = excluded.subagent_type,
       status          = ${AGENT_STATUS_CASE},
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
  return { inserted: existing === undefined };
}

interface AgentStatusRow {
  readonly sessionId: string;
  readonly status: AgentStatus | null;
}

/**
 * CD-1 primitive: move ONE existing agent's status and report the transition.
 *
 * UPDATE-only by construction — it can never create, delete or re-parent a row,
 * which is exactly the constraint hooks operate under (liveness only, never
 * structure). An unknown agent id yields `null` (the hook is still stored as
 * raw liveness; it simply has no row to move), and a no-op transition yields
 * `null` too so the realtime stream never emits `working -> working`.
 */
export function applyAgentStatus(
  db: SqliteDatabase,
  id: string,
  status: AgentStatus,
): AgentStatusChangedEvent | null {
  const row = db
    .prepare('SELECT session_id AS sessionId, status FROM agents WHERE id = ?')
    .get(id) as AgentStatusRow | undefined;
  if (row === undefined || row.status === status) {
    return null;
  }
  setAgentStatus(db, id, status);
  return {
    type: 'agent-status-changed',
    agentId: id,
    sessionId: row.sessionId,
    oldStatus: row.status,
    newStatus: status,
  };
}

/**
 * M-13 reconcile primitive: apply a status recovered from STORED hook evidence
 * to an agent whose row was created AFTER the hook fired.
 *
 * Differs from {@link applyAgentStatus} in exactly one arm: a row that already
 * holds an OBSERVED terminal ('completed' / 'error') is left alone. The live
 * hook path may move any status because its evidence is fresher than the row
 * by definition; a reconcile replays OLD evidence, so any terminal verdict
 * that landed in the meantime must win. That same arm is what makes
 * reconciliation idempotent: the first pass moves the row, every replay of
 * the same stored evidence finds the terminal already set and returns null.
 * The same-status arm keeps the primitive's contract honest — it can never
 * emit an `X -> X` transition onto the realtime stream.
 */
export function reconcileAgentStatus(
  db: SqliteDatabase,
  id: string,
  status: AgentStatus,
): AgentStatusChangedEvent | null {
  const row = db
    .prepare('SELECT session_id AS sessionId, status FROM agents WHERE id = ?')
    .get(id) as AgentStatusRow | undefined;
  if (
    row === undefined ||
    row.status === 'completed' ||
    row.status === 'error' ||
    row.status === status
  ) {
    return null;
  }
  setAgentStatus(db, id, status);
  return {
    type: 'agent-status-changed',
    agentId: id,
    sessionId: row.sessionId,
    oldStatus: row.status,
    newStatus: status,
  };
}
