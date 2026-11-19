/**
 * OPS-13 (2026-11-19) - tell a database that cannot be written from a
 * transcript that cannot be ingested.
 *
 * Ingest used to fold every throw into a per-session failure, and three of
 * those in a row quarantine the session. That is right for a content fault (a
 * half-written line, a session-id mismatch): the next pass sees the same bytes
 * and fails the same way. It is wrong for an infrastructure fault. A full disk
 * or an I/O error fails EVERY session that pass, so a disk-full window of three
 * polls quarantined healthy sessions, and an idle session (no new bytes) then
 * stayed out of every dollar total until a restart.
 *
 * The codes below are the ones that describe the database or the disk under
 * it, never the row being written. better-sqlite3 reports extended codes
 * (`SQLITE_IOERR_WRITE`, `SQLITE_BUSY_SNAPSHOT`), so a code matches its base
 * code and every extension of it. A constraint failure (`SQLITE_CONSTRAINT*`)
 * stays a content fault: it is the row, not the database.
 */

/** Base result codes that mean the database, not the data, is the problem. */
export const DATABASE_UNAVAILABLE_CODES: readonly string[] = [
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_NOTADB',
];

/**
 * The SQLite code of `error` when it is a database-unavailable fault, else
 * null. Duck-typed on `code` rather than `instanceof SqliteError`: the code is
 * the contract, and a test double need not load the native driver.
 */
export function databaseUnavailableCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const { code } = error;
  if (typeof code !== 'string') {
    return null;
  }
  return DATABASE_UNAVAILABLE_CODES.some((base) => code === base || code.startsWith(`${base}_`))
    ? code
    : null;
}

/**
 * Thrown by the corpus runner to end a pass on a database-unavailable fault.
 * Every later session would fail the same way, and counting those against
 * their retry budgets is exactly what this error exists to prevent.
 */
export class DatabaseUnavailableError extends Error {
  override readonly name = 'DatabaseUnavailableError';

  constructor(
    /** The SQLite code, e.g. `SQLITE_FULL` or `SQLITE_IOERR_WRITE`. */
    readonly code: string,
    /** The driver's own message, e.g. `database or disk is full`. */
    message: string,
  ) {
    super(message);
  }
}
