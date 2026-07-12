import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';

export interface TempDb {
  readonly db: SqliteDatabase;
  readonly dir: string;
  readonly path: string;
  cleanup(): void;
}

/** Open a fresh migrated database in a throwaway temp directory. */
export function createMigratedTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'agenthropic-server-test-'));
  const path = join(dir, 'test.db');
  const db = openDatabase(path);
  runMigrations(db);
  return {
    db,
    dir,
    path,
    cleanup(): void {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export function insertSession(db: SqliteDatabase, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
     VALUES (?, 'test-slug', '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z', 'active')`,
  ).run(id);
}

export function insertAgent(
  db: SqliteDatabase,
  id: string,
  sessionId: string,
  parentAgentId: string | null = null,
  status = 'working',
): void {
  db.prepare(
    `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES (?, ?, 'subagent', 'explorer', ?, ?, '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z')`,
  ).run(id, sessionId, status, parentAgentId);
}
