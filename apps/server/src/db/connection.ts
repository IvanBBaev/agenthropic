/**
 * WP-D2 - SQLite connection adapter (single driver: better-sqlite3).
 *
 * Every connection runs in WAL mode with foreign keys ON, and both pragmas
 * are ASSERTED after being set - a connection that silently fell back to a
 * weaker mode must never be handed to the rest of the app.
 *
 * R19 adds two tuning pragmas. `synchronous = NORMAL` is the documented safe
 * pairing with WAL: a commit can be lost on power failure, never corrupted,
 * and an fsync per commit is saved on the hot ingest path. `busy_timeout`
 * makes a writer that meets another connection's lock (the restore drill's
 * read-only handle, an operator's `sqlite3` shell) wait instead of failing at
 * once with SQLITE_BUSY.
 */
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ensurePrivateDatabaseFiles, ensurePrivateDir } from './file-modes';

export type SqliteDatabase = Database.Database;

/** How long a statement waits on another connection's lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Open (creating if needed) the SQLite database at `path`, creating the
 * parent directory first. The directory, the database and its sidecars are
 * private (R4 / SEC-2, see file-modes.ts). Asserts WAL journal mode and enforced
 * foreign keys; if setup throws, the handle is closed before the error
 * propagates.
 */
export function openDatabase(path: string): SqliteDatabase {
  // `:memory:` and `''` name no file, so there is nothing to create or protect.
  if (path !== '' && path !== ':memory:') {
    ensurePrivateDir(dirname(path));
    ensurePrivateDatabaseFiles(path);
  }
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    assertConnectionPragmas(
      db.pragma('journal_mode', { simple: true }),
      db.pragma('foreign_keys', { simple: true }),
    );
  } catch (err) {
    // The caller never receives this handle, so nothing else could close it.
    db.close();
    throw err;
  }
  return db;
}

/**
 * Assert the two non-negotiable connection pragmas. Exported separately so
 * both failure branches are directly testable.
 */
export function assertConnectionPragmas(journalMode: unknown, foreignKeys: unknown): void {
  if (journalMode !== 'wal') {
    throw new Error(
      `SQLite connection is not in WAL mode (journal_mode=${String(journalMode)}). ` +
        'WAL is a hard requirement (DESIGN.md section 8); refusing to continue.',
    );
  }
  if (foreignKeys !== 1) {
    throw new Error(
      `SQLite foreign_keys pragma is not enforced (foreign_keys=${String(foreignKeys)}). ` +
        'Referential integrity is a hard requirement; refusing to continue.',
    );
  }
}
