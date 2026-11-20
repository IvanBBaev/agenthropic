import type { Migration } from '../migrations';

export const migration: Migration = {
  id: 30,
  name: 'ingest-failures',
  up(db) {
    // WHY. ARC-5 (2026-11-20). The watcher's retry budget - which sessions
    // failed their latest ingest pass, how often, and why - lived only in
    // process memory. A restart forgot it: until the first pass ran, /api/health
    // and /api/cost/summary reported zero excluded sessions, a per-session read
    // of a rejected session answered 404 instead of 409, and every quarantined
    // session came back with a fresh budget. One row per session the watcher
    // currently holds a failure against, replaced as a whole after every pass
    // (db/ingest-failures.ts), so the table is a snapshot of the budget and
    // never a log.
    //
    // scope: sha-256 of the resolved corpus root, as in ingest_checkpoints -
    // a failure recorded against one corpus is never loaded for another, and
    // no absolute path is persisted. attempts: consecutive failed passes; a
    // session is quarantined once it reaches MAX_INGEST_ATTEMPTS, which is
    // derived on load rather than stored, so the two can never disagree.
    // reason: the sanitized reason of the latest failed pass (path-free,
    // single-line, length-capped). No transcript content, ever.
    db.exec(`
      CREATE TABLE ingest_failures (
        scope       TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        attempts    INTEGER NOT NULL CHECK (attempts >= 1),
        reason      TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (scope, session_id)
      ) WITHOUT ROWID;
    `);
  },
};
