/**
 * WP-D4 - upsert path for sessions (the subagent-tree roots).
 *
 * A session is keyed on its session-uuid (parser-spec 6.2), never the project
 * slug. Idempotent: re-applying the same id refreshes the row in place via
 * ON CONFLICT(id) DO UPDATE, so re-parsing a transcript never duplicates a
 * root. Uses a named-parameter prepared statement. `last_activity_at` never
 * moves backwards and `status` follows the CASE below — see {@link upsertSession}.
 */
import type { AgentStatus } from '@agenthropic/shared';
import type { SqliteDatabase } from './connection';

export interface SessionUpsert {
  readonly id: string;
  readonly projectSlug: string | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly status: string;
}

/**
 * Same three properties as the agent status CASE in `db/agents.ts` (observed
 * terminals sticky, inferred states yield to fresh activity, an unchanged
 * replay is a no-op) — here anchored on `last_activity_at`.
 */
const SESSION_STATUS_CASE = `CASE
         WHEN sessions.status IN ('completed', 'error') THEN sessions.status
         WHEN sessions.status IS NULL THEN excluded.status
         WHEN excluded.last_activity_at IS NOT NULL
          AND (sessions.last_activity_at IS NULL
               OR excluded.last_activity_at > sessions.last_activity_at)
           THEN excluded.status
         ELSE sessions.status
       END`;

export function upsertSession(db: SqliteDatabase, row: SessionUpsert): void {
  db.prepare(
    `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
     VALUES (@id, @projectSlug, @startedAt, @lastActivityAt, @status)
     ON CONFLICT(id) DO UPDATE SET
       project_slug     = excluded.project_slug,
       -- Monotonic non-increasing, the mirror of last_activity_at below: a
       -- pass whose earliest agent starts LATER (compaction evicted the head,
       -- a skipped file, duplicate-slug dedupe picking a copy that starts
       -- later) must not move the session start forward. A NULL is absence
       -- of evidence, so the COALESCE tail keeps whichever side is known.
       started_at       = COALESCE(MIN(excluded.started_at, sessions.started_at),
                                   excluded.started_at, sessions.started_at),
       -- Monotonic non-decreasing, never overwrite: the anchor is the MAX
       -- endedAt over the agents a pass emitted, so a pass that reads LESS (a
       -- skipped subagent transcript, or duplicate-slug dedupe picking a
       -- shorter copy) would move it backwards. A regressed anchor misorders
       -- the session lists and breaks the status CASE's "strictly advance"
       -- rule: the next unchanged replay would read as new activity. Scalar
       -- MAX() returns NULL if either side is NULL, so the COALESCE tail keeps
       -- whichever side is known (a NULL is absence of evidence). Every SET
       -- expression sees the PRE-update row, so the status CASE below still
       -- compares against the stored anchor even though this column is
       -- assigned first. An identical replay writes an identical value, which
       -- keeps the P0 byte-identical double-replay proof intact.
       last_activity_at = COALESCE(MAX(excluded.last_activity_at, sessions.last_activity_at),
                                   excluded.last_activity_at, sessions.last_activity_at),
       status          = ${SESSION_STATUS_CASE}`,
  ).run(row);
}

/**
 * A session's status mirrors its MAIN agent's status — one rule, one place,
 * used by both the hook applier and the watchdog so the two can never drift.
 *
 * Deliberately expressed as a single guarded UPDATE: if `agentId` is a
 * subagent (or unknown), the subselect matches nothing and the statement is a
 * no-op. A subagent finishing says nothing about whether its parent session is
 * still working, so it must NOT touch the session row.
 */
export function mirrorMainAgentStatus(
  db: SqliteDatabase,
  agentId: string,
  status: AgentStatus,
): void {
  db.prepare(
    `UPDATE sessions
        SET status = ?
      WHERE id = (SELECT session_id FROM agents WHERE id = ? AND type = 'main')`,
  ).run(status, agentId);
}
