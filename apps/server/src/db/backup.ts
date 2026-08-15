/**
 * WP-F8 - backup + tested restore.
 *
 * Backup uses better-sqlite3's online backup API (safe under WAL, no lock of
 * the live database). Restore copies the backup into place, reopens it with
 * the WP-D2 pragma assertions, and refuses to hand back a database that does
 * not pass `PRAGMA integrity_check`.
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, type SqliteDatabase } from './connection';

/** Back up an open database to `destPath` (parent directory is created). */
export async function backupDatabase(db: SqliteDatabase, destPath: string): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  await db.backup(destPath);
}

/**
 * Restore a backup file to `destPath` and return the opened database.
 * Throws (and closes the handle) if the restored file fails integrity_check.
 *
 * In-place restore (destPath is the live database path) requires the server -
 * every open handle on destPath - to be stopped first: an open WAL connection
 * would keep writing sidecars for the file being replaced underneath it.
 */
export function restoreDatabase(srcBackup: string, destPath: string): SqliteDatabase {
  mkdirSync(dirname(destPath), { recursive: true });
  // A leftover `-wal`/`-shm` pair belongs to the database being REPLACED
  // (e.g. after an unclean shutdown). SQLite recovery on open would replay
  // those frames INTO the restored image - silently mixing two database
  // states in exactly the disaster path restores exist for (review M-4).
  rmSync(`${destPath}-wal`, { force: true });
  rmSync(`${destPath}-shm`, { force: true });
  copyFileSync(srcBackup, destPath);
  const db = openDatabase(destPath);
  const result = db.pragma('integrity_check', { simple: true });
  if (result !== 'ok') {
    db.close();
    throw new Error(`Restored database failed integrity_check: ${String(result)}`);
  }
  return db;
}
