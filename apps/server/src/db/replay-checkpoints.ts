/**
 * WP-IN10 replay checkpoint store — the persisted half of the tail-follow
 * watcher's change detection.
 *
 * PROBLEM. Replay-on-startup re-reads the WHOLE corpus on every boot: the
 * watcher's fingerprint map lives in process memory, so a restart starts blank
 * and every session is "changed". That is correct and idempotent, but on the
 * measured corpus (12.80 GiB / 1855 sessions) a full cold replay projects to
 * ~137 s of boot-time work — paid again on every restart, for sessions whose
 * bytes have not moved in months.
 *
 * SHAPE. This store persists exactly what the watcher already computes in
 * memory: sessionId -> {@link fingerprintSession} string. On the next boot the
 * watcher hydrates its map from here, so an unchanged session is not merely
 * ingested-and-ignored — it is never READ from disk at all, because
 * `runCorpusIngest` applies its `sessionFilter` before `buildSessionSubstrate`.
 *
 * A CHECKPOINT MAY CHANGE INGEST WORK, NEVER INGEST RESULTS. Everything here is
 * built to fail in the safe direction — a doubtful checkpoint is dropped and
 * the session is re-ingested:
 *
 *  - SCOPE. Checkpoints are keyed by a sha-256 of the resolved corpus root. A
 *    different root cannot be mistaken for the same corpus, and no absolute
 *    path (which encodes the user's home directory) is ever persisted.
 *  - REVISION. {@link REPLAY_CHECKPOINT_REVISION} stamps the ingest semantics
 *    that produced the projection. Bump it whenever the parser, the cost engine
 *    or the projected schema changes: every checkpoint is invalidated at once
 *    and the corpus is re-read, instead of a code change silently leaving stale
 *    rows in place.
 *  - PROOF OF PROJECTION. A checkpoint is honored only while its session STILL
 *    HAS A ROW in `sessions`. A checkpoint therefore cannot hide a session that
 *    is missing from the database — if the row is gone (restore from an older
 *    backup, a manual delete; retention can never remove `sessions` rows, see
 *    RETENTION_PROTECTED_TABLES), the session re-ingests exactly as it does
 *    today.
 *  - DEGRADE, NEVER CRASH. Every statement is wrapped: an absent, corrupt or
 *    unwritable checkpoint table yields an empty map (a full replay), never an
 *    exception into the ingest loop. The store is a cache, and a cache that
 *    breaks a boot is worse than no cache.
 *
 * What is deliberately NOT trusted: the fingerprint alone. It is written by the
 * watcher only for a session that was successfully ingested in that pass; a
 * failed or quarantined session is never checkpointed, so a restart always
 * gives it a fresh retry budget, exactly like today.
 */
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './connection';

/**
 * Ingest-semantics stamp carried by every checkpoint row.
 *
 * BUMP THIS whenever a change makes an already-ingested session's projection
 * out of date: parser output, cost attribution, or the shape of the rows the
 * projection writes. Forgetting to bump is the one way this cache can go stale,
 * so it is a constant in code (reviewable in a diff) rather than a value
 * derived at runtime from something that only looks related.
 */
export const REPLAY_CHECKPOINT_REVISION = 1;

export interface ReplayCheckpointStore {
  /**
   * Fingerprints that may be trusted to skip work for `corpusRoot`: current
   * revision, matching scope, and a session row still present. Returns an empty
   * map on ANY problem — the caller then replays the whole corpus.
   */
  load(corpusRoot: string): Map<string, string>;
  /**
   * Record the fingerprints of the sessions that were successfully projected in
   * this pass and drop the rows of sessions that are no longer on disk.
   * Best-effort: a failure here costs a future replay, never the current pass.
   */
  commit(
    corpusRoot: string,
    projected: ReadonlyMap<string, string>,
    present: ReadonlySet<string>,
  ): void;
}

export interface ReplayCheckpointStoreOptions {
  /** Override the semantics stamp (tests drive invalidation with it). */
  readonly revision?: number;
  /** ISO clock for `recorded_at`; defaults to wall time. */
  readonly now?: () => string;
}

/**
 * Stable, path-free identity for a corpus root. sha-256 rather than the raw
 * path: the value is persisted, and an absolute path here would put the user's
 * home directory and project names into the database for no benefit.
 */
function scopeKeyOf(corpusRoot: string): string {
  return createHash('sha256').update(corpusRoot).digest('hex');
}

export function createReplayCheckpointStore(
  db: SqliteDatabase,
  options: ReplayCheckpointStoreOptions = {},
): ReplayCheckpointStore {
  const revision = options.revision ?? REPLAY_CHECKPOINT_REVISION;
  const now = options.now ?? ((): string => new Date().toISOString());

  function load(corpusRoot: string): Map<string, string> {
    const trusted = new Map<string, string>();
    try {
      const rows = db
        .prepare(
          `SELECT session_id AS sessionId, fingerprint AS fingerprint
             FROM ingest_checkpoints c
            WHERE c.scope = ?
              AND c.ingest_revision = ?
              AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = c.session_id)`,
        )
        .all(scopeKeyOf(corpusRoot), revision) as Array<{
        sessionId: string;
        fingerprint: string;
      }>;
      for (const row of rows) {
        trusted.set(row.sessionId, row.fingerprint);
      }
    } catch {
      // No table, unreadable table, schema drift: forget everything and let the
      // caller do the full, always-correct replay.
      return new Map();
    }
    return trusted;
  }

  function commit(
    corpusRoot: string,
    projected: ReadonlyMap<string, string>,
    present: ReadonlySet<string>,
  ): void {
    const scope = scopeKeyOf(corpusRoot);
    const recordedAt = now();
    try {
      db.transaction((): void => {
        const upsert = db.prepare(
          `INSERT INTO ingest_checkpoints (scope, session_id, fingerprint, ingest_revision, recorded_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scope, session_id) DO UPDATE SET
             fingerprint     = excluded.fingerprint,
             ingest_revision = excluded.ingest_revision,
             recorded_at     = excluded.recorded_at`,
        );
        for (const [sessionId, fingerprint] of projected) {
          upsert.run(scope, sessionId, fingerprint, revision, recordedAt);
        }
        // Prune what is no longer on disk. A vanished session's checkpoint must
        // not survive: were it to reappear byte-identically it would otherwise
        // be skipped on the strength of a stale record.
        const remove = db.prepare(
          'DELETE FROM ingest_checkpoints WHERE scope = ? AND session_id = ?',
        );
        const known = db
          .prepare('SELECT session_id AS sessionId FROM ingest_checkpoints WHERE scope = ?')
          .all(scope) as Array<{ sessionId: string }>;
        for (const row of known) {
          if (!present.has(row.sessionId)) {
            remove.run(scope, row.sessionId);
          }
        }
      })();
    } catch {
      // Best effort by design (see the module doc): an uncommittable checkpoint
      // means the next boot replays more, which is the safe direction.
    }
  }

  return { load, commit };
}
