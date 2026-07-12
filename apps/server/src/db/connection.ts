/**
 * WP-D2 - SQLite connection adapter (single driver: better-sqlite3).
 *
 * Every connection runs in WAL mode with foreign keys ON, and both pragmas
 * are ASSERTED after being set - a connection that silently fell back to a
 * weaker mode must never be handed to the rest of the app.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

/**
 * Open (creating if needed) the SQLite database at `path`, creating the
 * parent directory first. Asserts WAL journal mode and enforced foreign keys.
 */
export function openDatabase(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  assertConnectionPragmas(
    db.pragma('journal_mode', { simple: true }),
    db.pragma('foreign_keys', { simple: true }),
  );
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
