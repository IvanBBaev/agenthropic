/**
 * OPS-13: a database that cannot be written stops the pass; it never charges
 * the sessions it would have failed a retry. Before this, a full disk (or a
 * read-only file, or an I/O error) failed every session of every pass, and
 * three such polls quarantined the whole corpus - after which an idle session
 * (no new bytes) stayed out of every dollar total until a restart.
 *
 * `PRAGMA query_only` is the real fault here: better-sqlite3 then throws a
 * genuine `SqliteError` with code `SQLITE_READONLY` from the real writer, so
 * the classification is tested against the driver, not against a guess at it.
 */
import type { SessionSubstrate } from '@agenthropic/core';
import { getFixture } from '@agenthropic/test-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorpusFs } from '../src/corpus/fs-port';
import { runCorpusIngest, type IngestFn } from '../src/corpus/ingest-corpus';
import type { SqliteDatabase } from '../src/db/connection';
import {
  DATABASE_UNAVAILABLE_CODES,
  DatabaseUnavailableError,
  databaseUnavailableCode,
} from '../src/db/sqlite-errors';
import {
  createCorpusWatcher,
  MAX_INGEST_ATTEMPTS,
  type CorpusWatcherDeps,
} from '../src/ingest/corpus-watcher';
import type { IngestEvent } from '../src/ingest/ingest-events';
import { ingestSession, type IngestDeps, type IngestOutcome } from '../src/ingest/ingest-session';
import { dir, file, makeFakeCorpusFs } from './corpus/fake-corpus-fs';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';
import { HUGE_WATCHDOG_MS } from './p0/harness';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-ops13-project';
const SESSION_A = 'aaaaaaaa-1313-4313-8313-131313131313';
const SESSION_B = 'bbbbbbbb-1313-4313-8313-131313131313';
const NOW_MS = Date.parse('2026-11-19T00:00:00Z');

/** Two sessions on disk; their bytes never matter, the injected ingest decides. */
function twoSessionFs(): CorpusFs {
  return makeFakeCorpusFs(ROOT, {
    [SLUG]: dir({
      [`${SESSION_A}.jsonl`]: file('{"main":true}\n', { size: 14, mtimeMs: 1 }),
      [`${SESSION_B}.jsonl`]: file('{"main":true}\n', { size: 14, mtimeMs: 2 }),
    }),
  });
}

function okOutcome(sessionId: string): IngestOutcome {
  return {
    ok: true,
    sessionId,
    costUsd: 0,
    unpricedTokens: 0,
    agentsUpserted: 0,
    edgesInserted: 0,
    usageRowsInserted: 0,
    statusReconciliations: [],
    crossSessionUsageCollisions: 0,
    error: null,
  };
}

function failedOutcome(overrides: Partial<IngestOutcome>): IngestOutcome {
  return { ...okOutcome(''), ok: false, sessionId: null, error: 'x', ...overrides };
}

describe('databaseUnavailableCode (OPS-13)', () => {
  it('matches every base code and its extended codes', () => {
    for (const base of DATABASE_UNAVAILABLE_CODES) {
      expect(databaseUnavailableCode({ code: base })).toBe(base);
      expect(databaseUnavailableCode({ code: `${base}_SOMETHING` })).toBe(`${base}_SOMETHING`);
    }
    expect(databaseUnavailableCode({ code: 'SQLITE_IOERR_WRITE' })).toBe('SQLITE_IOERR_WRITE');
    expect(databaseUnavailableCode({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe('SQLITE_BUSY_SNAPSHOT');
  });

  it('leaves content faults and lookalike codes to the per-session path', () => {
    // A constraint failure is the row, not the database.
    expect(databaseUnavailableCode({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBeNull();
    expect(databaseUnavailableCode({ code: 'SQLITE_ERROR' })).toBeNull();
    // A prefix that is not a whole base code does not match.
    expect(databaseUnavailableCode({ code: 'SQLITE_FULLNESS' })).toBeNull();
    // A filesystem errno is the corpus's business (read-error), not the database's.
    expect(databaseUnavailableCode({ code: 'EACCES' })).toBeNull();
  });

  it('answers null for anything without a string code', () => {
    expect(databaseUnavailableCode(new Error('plain'))).toBeNull();
    expect(databaseUnavailableCode('SQLITE_FULL')).toBeNull();
    expect(databaseUnavailableCode(null)).toBeNull();
    expect(databaseUnavailableCode(undefined)).toBeNull();
    expect(databaseUnavailableCode({ code: 13 })).toBeNull();
  });

  it('classifies its own error, so a rethrow up the stack is still recognized', () => {
    const error = new DatabaseUnavailableError('SQLITE_FULL', 'database or disk is full');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DatabaseUnavailableError');
    expect(error.message).toBe('database or disk is full');
    expect(databaseUnavailableCode(error)).toBe('SQLITE_FULL');
  });
});

describe('database outages during ingest (OPS-13)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.db.pragma('query_only = OFF');
    temp.cleanup();
  });

  function ingestDeps(): IngestDeps {
    return { db: temp.db, pricing: [], instance: 'test', hostId: 'host' };
  }

  describe('ingestSession', () => {
    it('marks a real driver write failure as database-unavailable', () => {
      temp.db.pragma('query_only = ON');
      const outcome = ingestSession(getFixture('flat-tool-use'), ingestDeps());
      expect(outcome.ok).toBe(false);
      expect(outcome.databaseUnavailable).toBe('SQLITE_READONLY');
      expect(outcome.error).toBe('attempt to write a readonly database');
    });

    it('leaves a content failure unmarked', () => {
      const substrate = { files: [{ relativePath: 'session.jsonl', lines: ['not json {'] }] };
      const outcome = ingestSession(substrate, ingestDeps());
      expect(outcome.ok).toBe(false);
      expect('databaseUnavailable' in outcome).toBe(false);
    });
  });

  describe('runCorpusIngest', () => {
    function run(ingest: IngestFn): ReturnType<typeof runCorpusIngest> {
      return runCorpusIngest({
        db: temp.db,
        pricing: [],
        env: { CLAUDE_PROJECTS_DIR: ROOT },
        fs: twoSessionFs(),
        ingest,
      });
    }

    it('ends the pass on a database-unavailable outcome instead of reading on', () => {
      const seen: string[] = [];
      const ingest: IngestFn = (substrate) => {
        seen.push(substrate.files[0]!.relativePath);
        return failedOutcome({
          error: 'database or disk is full',
          databaseUnavailable: 'SQLITE_FULL',
        });
      };
      let thrown: unknown;
      try {
        run(ingest);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DatabaseUnavailableError);
      expect(thrown).toMatchObject({ code: 'SQLITE_FULL', message: 'database or disk is full' });
      // The second session was never handed to the writer.
      expect(seen).toHaveLength(1);
    });

    it('names an outcome that carries no message', () => {
      expect(() =>
        run(() => failedOutcome({ error: null, databaseUnavailable: 'SQLITE_IOERR_WRITE' })),
      ).toThrow(
        expect.objectContaining({ code: 'SQLITE_IOERR_WRITE', message: 'unknown ingest failure' }),
      );
    });

    it('ends the pass on a database fault an ingest throws', () => {
      const fault = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      expect(() =>
        run(() => {
          throw fault;
        }),
      ).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY', message: 'database is locked' }));
    });

    it('still folds a content failure into failures and reads on', () => {
      const summary = run(() => failedOutcome({ error: 'bad line' }));
      expect(summary.sessionsFailed).toBe(2);
      expect(summary.failures.map((f) => f.error)).toEqual(['bad line', 'bad line']);
    });
  });

  describe('corpus watcher', () => {
    function watcherDeps(overrides: Partial<CorpusWatcherDeps>): CorpusWatcherDeps {
      return {
        db: temp.db,
        pricing: [],
        env: { CLAUDE_PROJECTS_DIR: ROOT },
        intervalMs: 1000,
        watchdogThresholdMs: HUGE_WATCHDOG_MS,
        fs: twoSessionFs(),
        nowMs: () => NOW_MS,
        ...overrides,
      };
    }

    /**
     * The real writer under a real fault: the stub hands the REAL ingestSession
     * a parseable fixture (the fake corpus bytes are only there to be
     * enumerated), so the SQLITE_READONLY comes out of better-sqlite3 itself.
     */
    function realWriter(seen: string[]): IngestFn {
      return (substrate: SessionSubstrate, deps): IngestOutcome => {
        seen.push(substrate.files[0]!.relativePath);
        return ingestSession(getFixture('flat-tool-use'), deps);
      };
    }

    it('quarantines nothing however long the database refuses writes, then recovers', () => {
      const seen: string[] = [];
      const watcher = createCorpusWatcher(watcherDeps({ ingest: realWriter(seen) }));

      temp.db.pragma('query_only = ON');
      for (let pass = 0; pass < MAX_INGEST_ATTEMPTS + 2; pass += 1) {
        expect(watcher.tick()).toEqual({
          kind: 'db-unavailable',
          code: 'SQLITE_READONLY',
          reason: 'attempt to write a readonly database',
        });
      }
      // No session was charged a retry: none is failing, none is quarantined,
      // and none carries a rejection the dashboard would show.
      expect(watcher.exclusions()).toEqual({ failing: 0, quarantined: 0, stale: 0 });
      expect(watcher.rejectionOf(SESSION_A)).toBeUndefined();
      expect(watcher.rejectionOf(SESSION_B)).toBeUndefined();
      // Each pass stopped at the first session rather than failing the second.
      expect(seen).toHaveLength(MAX_INGEST_ATTEMPTS + 2);

      temp.db.pragma('query_only = OFF');
      const recovered = watcher.tick();
      expect(recovered.kind).toBe('ingested');
      expect(recovered.kind === 'ingested' && recovered.summary.sessionsOk).toBe(2);
      expect(watcher.tick().kind).toBe('unchanged');
    });

    it('reports a database fault the watchdog hits instead of crashing the poll', () => {
      insertSession(temp.db, 'session-1');
      insertAgent(temp.db, 'a-stale', 'session-1', null, 'working');
      const events: IngestEvent[] = [];
      const watcher = createCorpusWatcher(
        watcherDeps({
          fs: makeFakeCorpusFs(ROOT, {}),
          watchdogThresholdMs: 1,
          onIngestEvent: (event) => events.push(event),
        }),
      );

      temp.db.pragma('query_only = ON');
      expect(watcher.tick()).toEqual({
        kind: 'db-unavailable',
        code: 'SQLITE_READONLY',
        reason: 'attempt to write a readonly database',
      });
      expect(events).toEqual([]);

      temp.db.pragma('query_only = OFF');
      expect(watcher.tick().kind).toBe('unchanged');
      expect(events).toHaveLength(1);
    });

    it('still lets a watchdog bug that is not a database fault escape', () => {
      insertSession(temp.db, 'session-1');
      insertAgent(temp.db, 'a-stale', 'session-1', null, 'working');
      const real = temp.db;
      const broken = new Proxy(real, {
        get(target, property) {
          if (property === 'transaction') {
            return () => {
              throw new Error('watchdog bug');
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as SqliteDatabase;
      const watcher = createCorpusWatcher(
        watcherDeps({ db: broken, fs: makeFakeCorpusFs(ROOT, {}), watchdogThresholdMs: 1 }),
      );
      expect(() => watcher.tick()).toThrow('watchdog bug');
    });
  });
});
