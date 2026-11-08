/**
 * RELEASE.md §5 - the backup -> restore drill, as code (R10 follow-up).
 *
 * The drill used to be a `node -e` snippet that drove better-sqlite3's online
 * backup API directly. It defaulted to the repo-root `data/agenthropic.db` -
 * a stale schema-v7 file the server never opens, because the server runs with
 * `apps/server` as its working directory - and its copies were written with
 * the umask's mode (0644), not the 0600 every other backup gets (R4 / SEC-2).
 *
 * This module runs the SHIPPED code instead: `backupDatabase` (atomic,
 * verified, 0600) on a read-only handle to the live database, then
 * `restoreDatabase` of that backup into a scratch directory, then a table-by-
 * table row-count comparison between the backup and the restored copy. The
 * live database is never written; the server may stay up (the online backup
 * is safe under WAL).
 *
 * The backup is named `drill-<timestamp>.db`, outside `BACKUP_FILE_PATTERN`,
 * so retention never deletes it: RELEASE.md §5 keeps the pre-tag backup and
 * names it in the release notes. The scratch restore is removed afterwards.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backupDatabase, restoreDatabase } from './backup';
import { type SqliteDatabase } from './connection';
import { currentSchemaVersion, migrations } from './migrations';

export interface RestoreDrillOptions {
  /** The database the server runs on. Must exist: the drill never creates one. */
  readonly dbPath: string;
  /** Where the drill backup goes; the server's own backups directory by default. */
  readonly backupsDir: string;
  readonly now?: Date;
  /** The restore step; `restoreDatabase` unless a test proves the comparison bites. */
  readonly restore?: (backupPath: string, destPath: string) => SqliteDatabase;
}

export interface RestoreDrillTable {
  readonly name: string;
  readonly rows: number;
}

export interface RestoreDrillReport {
  /** The kept backup file. */
  readonly backupPath: string;
  /** Schema version of the backed-up database. */
  readonly schemaVersion: number;
  /** The newest migration this build knows; a lower `schemaVersion` will migrate at boot. */
  readonly buildSchemaVersion: number;
  /** Row counts of the restored copy, equal to the backup's, by table name. */
  readonly tables: readonly RestoreDrillTable[];
  readonly backupMs: number;
  readonly restoreMs: number;
}

function countRows(db: SqliteDatabase): RestoreDrillTable[] {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
  return names.map((name) => ({
    name,
    rows: db
      .prepare(`SELECT COUNT(*) FROM "${name.replaceAll('"', '""')}"`)
      .pluck()
      .get() as number,
  }));
}

function withDatabase<T>(db: SqliteDatabase, use: (db: SqliteDatabase) => T): T {
  try {
    return use(db);
  } finally {
    db.close();
  }
}

/**
 * Back up `dbPath`, restore the backup into a scratch directory and compare
 * the two copies. Throws when the database is missing, when either step fails
 * its checks, or when a table's row count differs.
 */
export async function runRestoreDrill(options: RestoreDrillOptions): Promise<RestoreDrillReport> {
  const { dbPath, backupsDir, restore = restoreDatabase } = options;
  if (!existsSync(dbPath)) {
    throw new Error(
      `No database at ${dbPath}. Point DASHBOARD_DB_PATH at the database the server runs on.`,
    );
  }
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupsDir, `drill-${stamp}.db`);

  const backupStart = performance.now();
  const live = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await backupDatabase(live, backupPath);
  } finally {
    live.close();
  }
  const backupMs = performance.now() - backupStart;
  const expected = withDatabase(new Database(backupPath, { fileMustExist: true }), countRows);

  const scratch = mkdtempSync(join(backupsDir, 'restore-drill-'));
  try {
    const restoreStart = performance.now();
    const restoredDb = restore(backupPath, join(scratch, 'agenthropic.db'));
    const restored = withDatabase(restoredDb, (db) => ({
      schemaVersion: currentSchemaVersion(db),
      tables: countRows(db),
    }));
    const restoreMs = performance.now() - restoreStart;

    const mismatches = compareCounts(expected, restored.tables);
    if (mismatches.length > 0) {
      throw new Error(`Restored copy differs from the backup: ${mismatches.join('; ')}`);
    }
    return {
      backupPath,
      schemaVersion: restored.schemaVersion,
      buildSchemaVersion: migrations.reduce((max, m) => Math.max(max, m.id), 0),
      tables: restored.tables,
      backupMs,
      restoreMs,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Differences between two row-count lists, one line per table; empty when equal. */
export function compareCounts(
  expected: readonly RestoreDrillTable[],
  actual: readonly RestoreDrillTable[],
): string[] {
  const actualByName = new Map(actual.map((t) => [t.name, t.rows]));
  const lines: string[] = [];
  for (const { name, rows } of expected) {
    const got = actualByName.get(name);
    if (got === undefined) {
      lines.push(`${name} missing`);
    } else if (got !== rows) {
      lines.push(`${name} ${String(rows)} -> ${String(got)} rows`);
    }
    actualByName.delete(name);
  }
  for (const name of actualByName.keys()) {
    lines.push(`${name} unexpected`);
  }
  return lines;
}

/**
 * The drill's console report. The last line, `restore drill OK: <backup>`, is
 * the line RELEASE.md §5 asks for; a database behind this build's schema is
 * called out, because a drill on a stale file proves nothing about the release.
 */
export function formatDrillReport(dbPath: string, report: RestoreDrillReport): string[] {
  const lines = [
    `database: ${dbPath}`,
    `schema: v${String(report.schemaVersion)} (this build: v${String(report.buildSchemaVersion)})`,
  ];
  if (report.schemaVersion < report.buildSchemaVersion) {
    lines.push(
      'WARNING: the database is behind this build. Is this the database the server runs on? ' +
        'If it is, the next boot migrates it (after its own pre-migration backup).',
    );
  }
  lines.push(
    `backup: ${report.backupMs.toFixed(0)} ms, restore + verify: ${report.restoreMs.toFixed(0)} ms`,
  );
  for (const table of report.tables) {
    lines.push(`  ${table.name}: ${String(table.rows)} rows`);
  }
  lines.push(`restore drill OK: ${report.backupPath}`);
  return lines;
}
