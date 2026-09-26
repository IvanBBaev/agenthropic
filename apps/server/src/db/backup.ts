/**
 * WP-F8 - backup + tested restore.
 *
 * Backup uses better-sqlite3's online backup API (safe under WAL, no lock of
 * the live database). Restore copies the backup to a staged file, checks it
 * with the WP-D2 pragma assertions and `PRAGMA integrity_check`, and only then
 * swaps it into place.
 */
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, type SqliteDatabase } from './connection';

/** Back up an open database to `destPath` (parent directory is created). */
export async function backupDatabase(db: SqliteDatabase, destPath: string): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  await db.backup(destPath);
}

/** Suffix of the file a restore copies into and checks before it swaps it in. */
export const RESTORE_STAGING_SUFFIX = '.restoring';

/**
 * Restore a backup file to `destPath` and return the opened database.
 *
 * The backup is copied to `${destPath}.restoring` and checked there first, so
 * a missing, unreadable or corrupt backup throws with `destPath` and its
 * `-wal`/`-shm` sidecars exactly as they were. A staged copy that fails
 * integrity_check is kept for inspection; the next restore overwrites it.
 *
 * In-place restore (destPath is the live database path) requires the server -
 * every open handle on destPath - to be stopped first: an open WAL connection
 * would keep writing sidecars for the file being replaced underneath it.
 */
export function restoreDatabase(srcBackup: string, destPath: string): SqliteDatabase {
  mkdirSync(dirname(destPath), { recursive: true });
  const staged = `${destPath}${RESTORE_STAGING_SUFFIX}`;
  rmSync(`${staged}-wal`, { force: true });
  rmSync(`${staged}-shm`, { force: true });
  copyFileSync(srcBackup, staged);
  const check = openDatabase(staged);
  let result: unknown;
  try {
    result = check.pragma('integrity_check', { simple: true });
  } finally {
    // integrity_check can throw (I/O error, unreadable page); the staged
    // handle must not outlive the restore that opened it.
    check.close();
  }
  if (result !== 'ok') {
    throw new Error(`Restored database failed integrity_check: ${String(result)}`);
  }
  // A leftover `-wal`/`-shm` pair belongs to the database being REPLACED
  // (e.g. after an unclean shutdown). SQLite recovery on open would replay
  // those frames INTO the restored image - silently mixing two database
  // states in exactly the disaster path restores exist for (review M-4).
  rmSync(`${destPath}-wal`, { force: true });
  rmSync(`${destPath}-shm`, { force: true });
  renameSync(staged, destPath);
  return openDatabase(destPath);
}
