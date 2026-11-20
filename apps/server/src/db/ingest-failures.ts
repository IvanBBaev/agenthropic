/**
 * ARC-5 - the persisted half of the corpus watcher's retry budget.
 *
 * The watcher holds, per session, how many consecutive passes failed and the
 * sanitized reason of the latest one. That map drives three disclosures: the
 * `sessionsExcluded` / `sessionsQuarantined` counts on /api/health and
 * /api/cost/summary, and the 409 a per-session read answers for a session
 * ingest refused. Held only in memory, all three reset on every restart, and
 * read "nothing is missing" until the first pass had re-failed every session.
 *
 * SHAPE. One row per session the watcher currently holds a failure against,
 * keyed by the same path-free corpus scope as `ingest_checkpoints`. `save`
 * REPLACES the scope's rows with the watcher's map, so the table is a
 * snapshot of the budget rather than a log that would have to mirror every
 * transition (success, prune, pricing re-admit) one by one.
 *
 * DEGRADE, NEVER CRASH. Like the checkpoint store, both halves swallow their
 * errors: a failed `load` boots with an empty budget (the pre-ARC-5
 * behaviour), and a failed `save` reports false so the watcher tries again
 * after its next pass. A restart is then no worse than it was before this
 * table existed.
 */
import type { SqliteDatabase } from './connection';
import { scopeKeyOf } from './replay-checkpoints';

/** One persisted entry of the retry budget. */
export interface PersistedIngestFailure {
  /** Consecutive failed passes, at least 1. */
  readonly attempts: number;
  /** Sanitized reason of the latest failed pass. */
  readonly reason: string;
}

export interface IngestFailureStore {
  /** The budget recorded for `corpusRoot`; empty on any problem. */
  load(corpusRoot: string): Map<string, PersistedIngestFailure>;
  /**
   * Replace the budget recorded for `corpusRoot` with `failures`. Returns false
   * when the write failed (nothing changed: the replace is one transaction).
   */
  save(corpusRoot: string, failures: ReadonlyMap<string, PersistedIngestFailure>): boolean;
}

export interface IngestFailureStoreOptions {
  /** ISO clock for `recorded_at`; defaults to wall time. */
  readonly now?: () => string;
}

export function createIngestFailureStore(
  db: SqliteDatabase,
  options: IngestFailureStoreOptions = {},
): IngestFailureStore {
  const now = options.now ?? ((): string => new Date().toISOString());

  function load(corpusRoot: string): Map<string, PersistedIngestFailure> {
    const loaded = new Map<string, PersistedIngestFailure>();
    try {
      const rows = db
        .prepare(
          `SELECT session_id AS sessionId, attempts, reason
             FROM ingest_failures
            WHERE scope = ?
            ORDER BY session_id`,
        )
        .all(scopeKeyOf(corpusRoot)) as Array<{
        sessionId: string;
        attempts: number;
        reason: string;
      }>;
      for (const row of rows) {
        loaded.set(row.sessionId, { attempts: row.attempts, reason: row.reason });
      }
    } catch {
      return new Map();
    }
    return loaded;
  }

  function save(
    corpusRoot: string,
    failures: ReadonlyMap<string, PersistedIngestFailure>,
  ): boolean {
    const scope = scopeKeyOf(corpusRoot);
    const recordedAt = now();
    try {
      db.transaction((): void => {
        db.prepare('DELETE FROM ingest_failures WHERE scope = ?').run(scope);
        const insert = db.prepare(
          `INSERT INTO ingest_failures (scope, session_id, attempts, reason, recorded_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const [sessionId, failure] of failures) {
          insert.run(scope, sessionId, failure.attempts, failure.reason, recordedAt);
        }
      })();
    } catch {
      return false;
    }
    return true;
  }

  return { load, save };
}
