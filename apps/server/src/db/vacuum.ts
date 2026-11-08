/**
 * R19 / OPS-7 - the storage-growth half of the vacuum policy, as an operator
 * command: `pnpm --filter @agenthropic/server db:vacuum`.
 *
 * Why not automatic: `VACUUM` rewrites the whole file synchronously on the one
 * connection the server has, so on a multi-GiB store it would freeze the hook
 * receiver, the API and the stream for as long as it runs. Retention frees
 * `events` pages, and SQLite reuses free pages for new rows, so the file
 * plateaus instead of growing without bound; what `VACUUM` adds is giving that
 * free space back to the disk. That is worth doing occasionally, with the
 * server stopped, and never worth a frozen dashboard.
 *
 * The command refuses while a server answers on the configured port, takes a
 * verified backup first (`pre-vacuum-<timestamp>.db`, outside the retention
 * pattern, so it is kept until the operator removes it), then vacuums and
 * truncates the WAL, and reports the size before and after.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backupDatabase } from './backup';
import { openDatabase, type SqliteDatabase } from './connection';

export interface VacuumOptions {
  /** The database the server runs on. Must exist: the command never creates one. */
  readonly dbPath: string;
  /** Where the pre-vacuum backup goes; the server's own backups directory. */
  readonly backupsDir: string;
  /** Resolves true while a dashboard server answers; the command then refuses. */
  readonly isServerRunning: () => Promise<boolean>;
  readonly now?: Date;
}

export interface StoreSize {
  readonly fileBytes: number;
  readonly freePages: number;
  readonly pageSize: number;
}

export interface VacuumReport {
  readonly backupPath: string;
  readonly before: StoreSize;
  readonly after: StoreSize;
  readonly vacuumMs: number;
}

function storeSize(db: SqliteDatabase, dbPath: string): StoreSize {
  return {
    fileBytes: statSync(dbPath).size,
    freePages: db.pragma('freelist_count', { simple: true }) as number,
    pageSize: db.pragma('page_size', { simple: true }) as number,
  };
}

/** Back up, vacuum and checkpoint `dbPath`; throws on any refusal or failure. */
export async function runVacuum(options: VacuumOptions): Promise<VacuumReport> {
  const { dbPath, backupsDir } = options;
  if (!existsSync(dbPath)) {
    throw new Error(
      `No database at ${dbPath}. Point DASHBOARD_DB_PATH at the database the server runs on.`,
    );
  }
  if (await options.isServerRunning()) {
    throw new Error(
      'A dashboard server is answering on the configured port. Stop it first: VACUUM ' +
        'needs the database to itself, and would otherwise make its writes fail.',
    );
  }
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupsDir, `pre-vacuum-${stamp}.db`);

  const db = openDatabase(dbPath);
  try {
    // Fold the WAL in first, so the "before" size is the whole store.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const before = storeSize(db, dbPath);
    await backupDatabase(db, backupPath);
    const start = performance.now();
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const vacuumMs = performance.now() - start;
    return { backupPath, before, after: storeSize(db, dbPath), vacuumMs };
  } finally {
    db.close();
  }
}

/**
 * The default `isServerRunning`: does anything answer HTTP on the server's
 * loopback port? Any response counts, a 401 included - only a refused or
 * timed-out connection means no server.
 */
export async function isServerAnswering(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch {
    return false;
  }
}

const MIB = 1024 * 1024;

function describe(size: StoreSize): string {
  const freeMib = (size.freePages * size.pageSize) / MIB;
  return `${(size.fileBytes / MIB).toFixed(1)} MiB (${freeMib.toFixed(1)} MiB free pages)`;
}

/** The console report; the last line, `vacuum OK: <backup>`, names the kept backup. */
export function formatVacuumReport(dbPath: string, report: VacuumReport): string[] {
  return [
    `database: ${dbPath}`,
    `before: ${describe(report.before)}`,
    `after:  ${describe(report.after)}`,
    `vacuum + checkpoint: ${report.vacuumMs.toFixed(0)} ms`,
    `vacuum OK: ${report.backupPath}`,
  ];
}
