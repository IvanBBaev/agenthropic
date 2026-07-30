/**
 * WP-D4 - upsert path for sessions (the subagent-tree roots).
 *
 * A session is keyed on its session-uuid (parser-spec 6.2), never the project
 * slug. Idempotent: re-applying the same id refreshes the row in place via
 * ON CONFLICT(id) DO UPDATE, so re-parsing a transcript never duplicates a
 * root. Uses a named-parameter prepared statement.
 */
import type { SqliteDatabase } from './connection';

export interface SessionUpsert {
  readonly id: string;
  readonly projectSlug: string | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly status: string;
}

export function upsertSession(db: SqliteDatabase, row: SessionUpsert): void {
  db.prepare(
    `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
     VALUES (@id, @projectSlug, @startedAt, @lastActivityAt, @status)
     ON CONFLICT(id) DO UPDATE SET
       project_slug     = excluded.project_slug,
       started_at       = excluded.started_at,
       last_activity_at = excluded.last_activity_at,
       status           = excluded.status`,
  ).run(row);
}
