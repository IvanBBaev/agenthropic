/**
 * In-process "ledger epoch": a per-connection counter that moves whenever
 * this process deletes ledger rows.
 *
 * WHY IT EXISTS. Incremental read caches (the aggregate delegation-savings
 * cache in `api/queries.ts`) key each session's cached figure on
 * `sessions.ingest_seq`, which migration 22's triggers bump on every INSERT
 * and every value-changing UPDATE of a session's rows - but deliberately NOT
 * on DELETE (see that migration's note). A retention prune that removes usage
 * rows would therefore leave such a cache serving dollars for rows that no
 * longer exist. Deletes on THIS handle bump the epoch; deletes by any OTHER
 * connection are already visible to readers through `PRAGMA data_version`.
 *
 * A WeakMap keyed by the connection handle, like the read caches it guards:
 * test suites with many temp databases cannot leak an epoch into each other,
 * and the entry dies with its connection. A bump that turns out to be
 * unnecessary (an events-only prune, a rolled-back delete) only costs one
 * cache recompute - the counter errs in the never-stale direction.
 */
import type { SqliteDatabase } from './connection';

const epochs = new WeakMap<SqliteDatabase, number>();

/** The current epoch of `db` (0 until the first bump). */
export function ledgerEpoch(db: SqliteDatabase): number {
  return epochs.get(db) ?? 0;
}

/** Record that ledger rows may have been deleted through `db`. */
export function bumpLedgerEpoch(db: SqliteDatabase): void {
  epochs.set(db, ledgerEpoch(db) + 1);
}
