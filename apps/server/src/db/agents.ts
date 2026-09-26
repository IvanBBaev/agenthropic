/**
 * WP-D6 - upsert path for agents, the first-class queryable entities whose
 * self-referential parent_agent_id makes the subagent tree a data fact.
 *
 * Idempotent replay lives in the storage engine: ON CONFLICT(id) DO UPDATE
 * refreshes the mutable projection (type, subagent_type, status, outcome_cause,
 * parent, and the seen-at timestamps) while leaving session_id - the immutable owning
 * session - untouched. A null incoming parent never erases a stored one. Foreign keys (session_id -> sessions, parent_agent_id
 * -> agents self) are enforced by the WP-D2 connection pragmas; the CALLER
 * guarantees the session and any referenced parent agent are inserted first.
 *
 * `status`, `outcome_cause`, `parent_agent_id` and `last_seen_at` are the
 * columns the upsert does not simply overwrite - see the status CASE, the
 * COALESCEs and the monotonic last_seen_at in
 * {@link upsertAgent}.
 */
import type { AgentOutcomeCause, AgentStatus, AgentType } from '@agenthropic/shared';
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
  /**
   * The observed run outcome, or `null` when the substrate carried none. Like
   * an observed terminal it is EVIDENCE, so the upsert never erases a recorded
   * cause with a later `null` (see {@link upsertAgent}).
   */
  readonly outcomeCause: AgentOutcomeCause | null;
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

/**
 * Point status update used by the watchdog; never touches any other column.
 *
 * Deliberately id-only, unlike the session-scoped {@link applyAgentStatus} and
 * {@link reconcileAgentStatus}. Those two act on an agent id that arrives in an
 * untrusted hook payload next to a separately claimed session id, so the two
 * claims can disagree and the SQL must check them against each other. This
 * primitive's only production caller, the WP-IN12 watchdog sweep, has no such
 * second claim: it passes ids it has just read from this very table
 * ({@link listWatchdogCandidates}) in the same synchronous call. `agents.id` is
 * the primary key and `session_id` is immutable once inserted (the upsert never
 * rewrites it), so adding `AND session_id = ?` with the candidate's own
 * session id would only compare the row with itself - it would guard nothing.
 * Callers that hold an externally supplied agent id must use the scoped
 * primitives instead.
 */
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
 *
 * One exception to property 3: an incoming 'error' applies without an anchor
 * advance. Ingest asserts 'error' only for an OBSERVED error outcome, and that
 * outcome is read from the PARENT transcript. A killed child's own transcript
 * stops growing, so the pass that first sees the outcome carries the same
 * anchor as the pass before. The arm cannot resurrect anything: an observed
 * 'completed' is caught by the sticky arm first, and a replay of an 'error'
 * writes 'error' again.
 */
const AGENT_STATUS_CASE = `CASE
         WHEN agents.status IN ('completed', 'error') THEN agents.status
         WHEN agents.status IS NULL THEN excluded.status
         WHEN excluded.status = 'error' THEN 'error'
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
       (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at,
        last_seen_at, outcome_cause)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type            = excluded.type,
       subagent_type   = excluded.subagent_type,
       status          = ${AGENT_STATUS_CASE},
       -- COALESCE, not overwrite: a pass re-reads only the files it COULD
       -- read. When the main (or a depth-1 parent) transcript is skipped that
       -- pass (oversize, EACCES), the child still ingests, and the normalizer
       -- nulls its parent for FK safety because the parent node was not
       -- emitted. That null is absence of evidence, not evidence of no parent;
       -- a non-null value still replaces (a genuine re-resolution wins).
       parent_agent_id = COALESCE(excluded.parent_agent_id, agents.parent_agent_id),
       -- Monotonic non-increasing, the mirror of last_seen_at below: a pass
       -- that reads a LATER first record (compaction evicted the head, a
       -- skipped file, duplicate-slug dedupe picking a copy that starts
       -- later) must not move the first sighting forward. A NULL is absence
       -- of evidence, so the COALESCE tail keeps whichever side is known.
       first_seen_at   = COALESCE(MIN(excluded.first_seen_at, agents.first_seen_at),
                                  excluded.first_seen_at, agents.first_seen_at),
       -- Monotonic non-decreasing, never overwrite: a pass that reads FEWER
       -- records for an agent (a skipped file, or duplicate-slug dedupe picking
       -- a shorter copy) must not move the anchor backwards. A regressed
       -- anchor misorders the recent-activity lists and breaks the status
       -- CASE's "strictly advance" rule: the next unchanged replay would read
       -- as new activity. Scalar MAX() returns NULL if either side is NULL, so
       -- the COALESCE tail keeps whichever side is known (a NULL is absence of
       -- evidence). Every SET expression sees the PRE-update row, so the
       -- status CASE above still compares against the stored anchor. An
       -- identical replay writes an identical value, which keeps the P0
       -- byte-identical double-replay proof intact.
       last_seen_at    = COALESCE(MAX(excluded.last_seen_at, agents.last_seen_at),
                                  excluded.last_seen_at, agents.last_seen_at),
       -- COALESCE, not overwrite: an outcome is a one-time OBSERVATION of a
       -- parent-side spawn result. That result lives in the PARENT transcript,
       -- which compaction can evict while the child transcript survives, so a
       -- later replay legitimately re-parses the same child with no outcome to
       -- report. Overwriting would read that silence as "it did not happen".
       -- Replaying identical bytes still writes an identical row, so the P0
       -- byte-identical double-replay property is untouched.
       outcome_cause   = COALESCE(excluded.outcome_cause, agents.outcome_cause)`,
  ).run(
    row.id,
    row.sessionId,
    row.type,
    row.subagentType,
    row.status,
    row.parentAgentId,
    row.firstSeenAt,
    row.lastSeenAt,
    row.outcomeCause,
  );
  return { inserted: existing === undefined };
}

interface AgentStatusRow {
  readonly status: AgentStatus | null;
}

/**
 * Read the status of agent `id` ONLY if it belongs to session `sessionId`.
 * `undefined` covers both "no such agent" and "an agent of another session":
 * to a session-scoped caller the two are the same - there is no row of THIS
 * session to move.
 */
function readScopedStatus(
  db: SqliteDatabase,
  id: string,
  sessionId: string,
): AgentStatusRow | undefined {
  return db
    .prepare('SELECT status FROM agents WHERE id = ? AND session_id = ?')
    .get(id, sessionId) as AgentStatusRow | undefined;
}

/**
 * The session-scoped status write. Keyed on `(id, session_id)`, never on the
 * id alone, so even a caller that skipped the ownership read cannot move a row
 * owned by another session.
 */
function writeScopedStatus(
  db: SqliteDatabase,
  id: string,
  sessionId: string,
  status: AgentStatus,
): void {
  db.prepare('UPDATE agents SET status = ? WHERE id = ? AND session_id = ?').run(
    status,
    id,
    sessionId,
  );
}

/**
 * CD-1 primitive: move ONE existing agent's status and report the transition.
 *
 * UPDATE-only by construction — it can never create, delete or re-parent a row,
 * which is exactly the constraint hooks operate under (liveness only, never
 * structure). An unknown agent id yields `null` (the hook is still stored as
 * raw liveness; it simply has no row to move), and a no-op transition yields
 * `null` too so the realtime stream never emits `working -> working`.
 *
 * SESSION-SCOPED AT THE SQL LAYER. The hook payload that names `id` is
 * untrusted, and it also names the session that fired it (`sessionId`). A
 * stop can only speak for an agent of its own session, so both the read and
 * the UPDATE key on `(id, session_id)`: an agent owned by another session
 * yields `null` and is never written, even for a caller that skipped the hook
 * layer's own ownership check (defence in depth).
 */
export function applyAgentStatus(
  db: SqliteDatabase,
  id: string,
  status: AgentStatus,
  sessionId: string,
): AgentStatusChangedEvent | null {
  const row = readScopedStatus(db, id, sessionId);
  if (row === undefined || row.status === status) {
    return null;
  }
  writeScopedStatus(db, id, sessionId, status);
  return {
    type: 'agent-status-changed',
    agentId: id,
    sessionId,
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
 *
 * Session-scoped at the SQL layer exactly like {@link applyAgentStatus}: the
 * stored evidence belongs to `sessionId`, and a row owned by any other session
 * is neither read nor written.
 */
export function reconcileAgentStatus(
  db: SqliteDatabase,
  id: string,
  status: AgentStatus,
  sessionId: string,
): AgentStatusChangedEvent | null {
  const row = readScopedStatus(db, id, sessionId);
  if (
    row === undefined ||
    row.status === 'completed' ||
    row.status === 'error' ||
    row.status === status
  ) {
    return null;
  }
  writeScopedStatus(db, id, sessionId, status);
  return {
    type: 'agent-status-changed',
    agentId: id,
    sessionId,
    oldStatus: row.status,
    newStatus: status,
  };
}
