/**
 * WP-D4 - upsert path for sessions (the subagent-tree roots).
 *
 * A session is keyed on its session-uuid (parser-spec 6.2), never the project
 * slug. Idempotent: re-applying the same id refreshes the row in place via
 * ON CONFLICT(id) DO UPDATE, so re-parsing a transcript never duplicates a
 * root. Uses a named-parameter prepared statement.
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
       started_at       = excluded.started_at,
       last_activity_at = excluded.last_activity_at,
       status           = ${SESSION_STATUS_CASE}`,
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
