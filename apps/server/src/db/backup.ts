/**
 * WP-F8 - backup + tested restore.
 *
 * Backup uses better-sqlite3's online backup API (safe under WAL, no lock of
 * the live database) into a `.partial` file, checks it with
 * `PRAGMA integrity_check`, and only then renames it to its final name (R9 /
 * OPS-3). Restore copies the backup to a staged file, checks it with the WP-D2
 * pragma assertions, `PRAGMA integrity_check` and a schema-version check, and
 * only then swaps it into place.
 */
import { copyFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, type SqliteDatabase } from './connection';
import { ensurePrivateDir, ensurePrivateFile } from './file-modes';
import { assertSchemaNotNewer, currentSchemaVersion } from './migrations';

/**
 * Suffix of the file a backup is written to before it is verified. It does
 * not end in `.db`, so backup-file retention (`BACKUP_FILE_PATTERN`) never
 * counts a half-written or unverified copy as a backup.
 */
export const BACKUP_PARTIAL_SUFFIX = '.partial';

/**
 * Open `path`, run `integrity_check` and then `extra` on it, and close it
 * whatever happens: a check that throws must not leave the handle holding the
 * file's `-wal` / `-shm` pair.
 */
function verifyDatabaseFile(
  path: string,
  what: string,
  extra: (db: SqliteDatabase) => void = () => undefined,
): void {
  const check = openDatabase(path);
  try {
    const result: unknown = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(`${what} failed integrity_check: ${String(result)}`);
    }
    extra(check);
  } finally {
    check.close();
  }
}

/**
 * Back up an open database to `destPath` (parent directory is created).
 *
 * Atomic and verified (R9 / OPS-3): the pages go to `${destPath}.partial`,
 * which must pass `integrity_check` before it is renamed onto `destPath`. A
 * crash or a failed check therefore never leaves a file under the backup name
 * that `pruneBackupFiles` would count as the newest backup, and an existing
 * `destPath` is untouched until a verified copy replaces it. A failure removes
 * the partial file and its sidecars.
 *
 * The partial file exists as 0600 before the first page lands (R4 / SEC-2):
 * the online backup yields between pages, so a mode set afterwards would leave
 * a readable copy for the whole transfer.
 */
export async function backupDatabase(db: SqliteDatabase, destPath: string): Promise<void> {
  ensurePrivateDir(dirname(destPath));
  const partial = `${destPath}${BACKUP_PARTIAL_SUFFIX}`;
  ensurePrivateFile(partial);
  try {
    await db.backup(partial);
    verifyDatabaseFile(partial, 'Backup');
    renameSync(partial, destPath);
  } catch (err) {
    for (const file of [partial, `${partial}-wal`, `${partial}-shm`]) {
      rmSync(file, { force: true });
    }
    throw err;
  }
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
 * The staged copy must also be an agenthropic database this build can run
 * (R9 / OPS-9): it needs a `schema_version` table, and no migration newer
 * than this build knows. Restoring a newer backup would only move the
 * downgrade refusal from the restore to the next boot.
 *
 * In-place restore (destPath is the live database path) requires the server -
 * every open handle on destPath - to be stopped first: an open WAL connection
 * would keep writing sidecars for the file being replaced underneath it.
 */
export function restoreDatabase(srcBackup: string, destPath: string): SqliteDatabase {
  ensurePrivateDir(dirname(destPath));
  const staged = `${destPath}${RESTORE_STAGING_SUFFIX}`;
  rmSync(`${staged}-wal`, { force: true });
  rmSync(`${staged}-shm`, { force: true });
  // copyFileSync takes the source's mode; openDatabase makes the copy private.
  copyFileSync(srcBackup, staged);
  verifyDatabaseFile(staged, 'Restored database', (check) => {
    if (currentSchemaVersion(check) === 0) {
      throw new Error('Restored database has no schema_version table: not an agenthropic backup');
    }
    assertSchemaNotNewer(check);
  });
  // A leftover `-wal`/`-shm` pair belongs to the database being REPLACED
  // (e.g. after an unclean shutdown). SQLite recovery on open would replay
  // those frames INTO the restored image - silently mixing two database
  // states in exactly the disaster path restores exist for (review M-4).
  rmSync(`${destPath}-wal`, { force: true });
  rmSync(`${destPath}-shm`, { force: true });
  renameSync(staged, destPath);
  return openDatabase(destPath);
}
