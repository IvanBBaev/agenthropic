/**
 * WP-IN10 persisted replay checkpoint.
 *
 * The property under test is narrow and absolute: A CHECKPOINT MAY CHANGE HOW
 * MUCH WORK A BOOT DOES, NEVER WHAT THE BOOT RESULTS IN. So the suite has two
 * halves that must both hold, and neither implies the other:
 *
 *  - WORK. A counting {@link CorpusFs} wraps the real `nodeCorpusFs` and tallies
 *    every file read and every byte returned. The measurement is the point: a
 *    second cold start must read ASYMPTOTICALLY LESS than the first, not merely
 *    "still pass". A test that only asserted green would go on passing if the
 *    checkpoint silently did nothing.
 *  - RESULTS. Two databases are built from the same corpus — one with the
 *    checkpoint wired, one without — and their full logical dumps must be equal.
 *
 * Everything else here is the fail-safe direction, one test per way a checkpoint
 * can be wrong: a shrinking file, a vanished session row, a scope change, a
 * revision bump, a missing table, a quarantined session, a session that projects
 * nothing. In every case the required behaviour is the same — RE-INGEST. A
 * checkpoint is a cache, and the only acceptable failure mode of this cache is
 * doing the work again.
 *
 * No test reads or writes the real `~/.claude/projects`: the real-disk half
 * materializes fixtures into a mkdtemp corpus and pins `CLAUDE_PROJECTS_DIR`,
 * the rest drives an in-memory fake.
 */
import { appendFileSync, rmSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSubstrate } from '@agenthropic/core';
import type { CorpusFs } from '../src/corpus/fs-port';
import type { IngestFn } from '../src/corpus/ingest-corpus';
import { nodeCorpusFs } from '../src/corpus/node-corpus-fs';
import { loadPricing } from '../src/db/pricing';
import {
  createReplayCheckpointStore,
  REPLAY_CHECKPOINT_REVISION,
} from '../src/db/replay-checkpoints';
import { upsertSession } from '../src/db/sessions';
import {
  MAX_INGEST_ATTEMPTS,
  createCorpusWatcher,
  tickSummary,
  type CorpusWatcherDeps,
} from '../src/ingest/corpus-watcher';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import { createMigratedTempDb, type TempDb } from './helpers';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';
import {
  FIXED_NOW,
  FIXED_NOW_MS,
  HUGE_WATCHDOG_MS,
  SLUG as P0_SLUG,
  allFixtures,
  corpusEnv,
  dumpAllTables,
  makeTempDir,
  materializeCorpus,
  openSeededDb,
} from './p0/harness';

const ROOT = '/fake/corpus';
const OTHER_ROOT = '/fake/other-corpus';
const SLUG = '-Users-synthetic-checkpoint-project';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SESSION_C = 'cccccccc-3333-4333-8333-333333333333';
const MAIN = '{"main":true}\n';
const REASON_SAMPLE = 'refusing to price at $0: unknown model id "claude-future-1"';

const INTERVAL_MS = 1000;
const NOW_MS = Date.parse('2026-07-12T00:00:00Z');

type MutableTree = Record<string, NodeSpec>;

// --- The work meter ---------------------------------------------------------

interface FsCounters {
  /** Files actually opened and read (the expensive operation). */
  files: number;
  /** Bytes returned by those reads. */
  bytes: number;
  /** Metadata probes — the cost a checkpoint CANNOT remove. */
  lstats: number;
}

function newCounters(): FsCounters {
  return { files: 0, bytes: 0, lstats: 0 };
}

/**
 * Wrap a {@link CorpusFs} and tally what it costs. The seam is deliberately the
 * port and not the ingest function: skipping a session is only worth anything if
 * its BYTES are never read, and `runCorpusIngest` applies `sessionFilter` before
 * `buildSessionSubstrate`, so this wrapper is what proves the saving is real
 * rather than merely a skipped parse of an already-loaded file.
 */
function countingFs(inner: CorpusFs, counters: FsCounters): CorpusFs {
  return {
    readDirNames: (absDir) => inner.readDirNames(absDir),
    realpath: (absPath) => inner.realpath(absPath),
    lstat: (absPath) => {
      counters.lstats += 1;
      return inner.lstat(absPath);
    },
    readFileConfined: (absPath, maxBytes) => {
      const text = inner.readFileConfined(absPath, maxBytes);
      counters.files += 1;
      counters.bytes += Buffer.byteLength(text, 'utf8');
      return text;
    },
    readFileTailConfined: (absPath, fromByte, maxBytes) => {
      const tail = inner.readFileTailConfined(absPath, fromByte, maxBytes);
      counters.files += 1;
      counters.bytes += tail.data.length;
      return tail;
    },
  };
}

// --- Fake-corpus helpers ----------------------------------------------------

function outcome(sessionId: string, overrides: Partial<IngestOutcome> = {}): IngestOutcome {
  return {
    ok: true,
    sessionId,
    costUsd: 0,
    agentsUpserted: 0,
    edgesInserted: 0,
    usageRowsInserted: 0,
    error: null,
    ...overrides,
  };
}

/**
 * An ingest stub that PROJECTS: it writes the session row the checkpoint store
 * later probes for. Without a real row the store would (correctly) refuse to
 * honour its own checkpoint, so a stub that only records calls could never
 * exercise the skip path at all.
 */
function projectingIngest(temp: TempDb, calls: string[], failing = new Set<string>()): IngestFn {
  return (substrate: SessionSubstrate): IngestOutcome => {
    const rel = substrate.files[0]?.relativePath ?? '<no main>';
    const sessionId = rel.endsWith('.jsonl') ? rel.slice(0, -'.jsonl'.length) : rel;
    calls.push(sessionId);
    if (failing.has(sessionId)) {
      return {
        ok: false,
        sessionId,
        costUsd: null,
        agentsUpserted: 0,
        edgesInserted: 0,
        usageRowsInserted: 0,
        error: REASON_SAMPLE,
      };
    }
    upsertSession(temp.db, {
      id: sessionId,
      projectSlug: SLUG,
      startedAt: '2026-07-11T00:00:00Z',
      lastActivityAt: '2026-07-11T00:00:00Z',
      status: 'working',
    });
    return outcome(sessionId);
  };
}

describe('WP-IN10 replay checkpoint', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  // --- The store in isolation ----------------------------------------------

  describe('createReplayCheckpointStore', () => {
    const store = (revision?: number) =>
      createReplayCheckpointStore(temp.db, {
        ...(revision === undefined ? {} : { revision }),
        now: () => '2026-07-12T00:00:00.000Z',
      });

    function seedSession(id: string): void {
      upsertSession(temp.db, {
        id,
        projectSlug: SLUG,
        startedAt: '2026-07-11T00:00:00Z',
        lastActivityAt: '2026-07-11T00:00:00Z',
        status: 'working',
      });
    }

    it('round-trips the fingerprints of sessions that still have a row', () => {
      seedSession(SESSION_A);
      seedSession(SESSION_B);
      const s = store();

      s.commit(
        ROOT,
        new Map([
          [SESSION_A, 'fp-a'],
          [SESSION_B, 'fp-b'],
        ]),
        new Set([SESSION_A, SESSION_B]),
      );

      expect([...s.load(ROOT)]).toEqual([
        [SESSION_A, 'fp-a'],
        [SESSION_B, 'fp-b'],
      ]);
    });

    it('refuses a checkpoint whose session row has vanished (proof of projection)', () => {
      seedSession(SESSION_A);
      seedSession(SESSION_B);
      const s = store();
      s.commit(
        ROOT,
        new Map([
          [SESSION_A, 'fp-a'],
          [SESSION_B, 'fp-b'],
        ]),
        new Set([SESSION_A, SESSION_B]),
      );

      // A restore from an older backup, a retention sweep, a manual delete: the
      // checkpoint row survives but no longer describes anything persisted.
      temp.db.prepare('DELETE FROM sessions WHERE id = ?').run(SESSION_A);

      expect([...s.load(ROOT)]).toEqual([[SESSION_B, 'fp-b']]);
    });

    it('never lets one corpus root answer for another', () => {
      seedSession(SESSION_A);
      const s = store();
      s.commit(ROOT, new Map([[SESSION_A, 'fp-a']]), new Set([SESSION_A]));

      expect(s.load(OTHER_ROOT).size).toBe(0);
      expect(s.load(ROOT).size).toBe(1);
    });

    it('stores no absolute path — only a hashed scope', () => {
      seedSession(SESSION_A);
      store().commit(ROOT, new Map([[SESSION_A, 'fp-a']]), new Set([SESSION_A]));

      const scopes = temp.db.prepare('SELECT DISTINCT scope FROM ingest_checkpoints').all() as {
        scope: string;
      }[];
      expect(scopes).toHaveLength(1);
      expect(scopes[0]?.scope).toMatch(/^[0-9a-f]{64}$/);
      expect(scopes[0]?.scope).not.toContain('/');
    });

    it('invalidates every checkpoint when the ingest revision moves', () => {
      seedSession(SESSION_A);
      store(1).commit(ROOT, new Map([[SESSION_A, 'fp-a']]), new Set([SESSION_A]));

      expect(store(2).load(ROOT).size).toBe(0);
      expect(store(1).load(ROOT).size).toBe(1);
    });

    it('prunes checkpoints for sessions no longer present on disk', () => {
      seedSession(SESSION_A);
      seedSession(SESSION_B);
      const s = store();
      s.commit(
        ROOT,
        new Map([
          [SESSION_A, 'fp-a'],
          [SESSION_B, 'fp-b'],
        ]),
        new Set([SESSION_A, SESSION_B]),
      );

      // B is gone from the corpus. Its checkpoint must go too: were B to
      // reappear byte-identically it would otherwise be skipped on a stale record.
      s.commit(ROOT, new Map([[SESSION_A, 'fp-a']]), new Set([SESSION_A]));

      expect([...s.load(ROOT)]).toEqual([[SESSION_A, 'fp-a']]);
    });

    it('degrades to a full replay when the checkpoint table is unreadable', () => {
      seedSession(SESSION_A);
      const s = store();
      s.commit(ROOT, new Map([[SESSION_A, 'fp-a']]), new Set([SESSION_A]));

      temp.db.exec('DROP TABLE ingest_checkpoints');

      // No throw into the ingest loop: an empty map means "replay everything".
      expect(s.load(ROOT).size).toBe(0);
    });

    it('swallows an uncommittable checkpoint rather than failing the pass', () => {
      seedSession(SESSION_A);
      temp.db.exec('DROP TABLE ingest_checkpoints');

      expect(() => {
        store().commit(ROOT, new Map([[SESSION_A, 'fp-a']]), new Set([SESSION_A]));
      }).not.toThrow();
    });

    it('defaults to the shipped revision and a wall clock', () => {
      seedSession(SESSION_A);
      // No options at all — the production construction.
      createReplayCheckpointStore(temp.db).commit(
        ROOT,
        new Map([[SESSION_A, 'fp-a']]),
        new Set([SESSION_A]),
      );

      const row = temp.db
        .prepare(
          'SELECT ingest_revision AS revision, recorded_at AS recordedAt FROM ingest_checkpoints',
        )
        .get() as { revision: number; recordedAt: string };
      expect(row.revision).toBe(REPLAY_CHECKPOINT_REVISION);
      expect(Number.isNaN(Date.parse(row.recordedAt))).toBe(false);
    });
  });

  // --- The watcher on a fake corpus ----------------------------------------

  describe('corpus watcher hydration', () => {
    function makeDeps(
      slugTree: MutableTree,
      overrides: Partial<CorpusWatcherDeps> = {},
      root = ROOT,
    ): CorpusWatcherDeps {
      return {
        db: temp.db,
        pricing: [],
        env: { CLAUDE_PROJECTS_DIR: root },
        intervalMs: INTERVAL_MS,
        watchdogThresholdMs: HUGE_WATCHDOG_MS,
        fs: makeFakeCorpusFs(root, { [SLUG]: dir(slugTree) }),
        nowMs: () => NOW_MS,
        checkpoints: createReplayCheckpointStore(temp.db, {
          now: () => '2026-07-12T00:00:00.000Z',
        }),
        ...overrides,
      };
    }

    /** Two sessions, each a one-line main transcript. */
    function twoSessions(): MutableTree {
      return {
        [`${SESSION_A}.jsonl`]: file(MAIN, { size: 10, mtimeMs: 1 }),
        [`${SESSION_B}.jsonl`]: file(MAIN, { size: 20, mtimeMs: 2 }),
      };
    }

    it('a restart re-reads nothing when no session changed', () => {
      const tree = twoSessions();
      const first: string[] = [];
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, first) })).tick();
      expect(first.sort()).toEqual([SESSION_A, SESSION_B]);

      // A NEW watcher against the SAME database is a restarted process: its
      // in-memory fingerprint map is empty and can only come from the store.
      const second: string[] = [];
      const summary = createCorpusWatcher(
        makeDeps(tree, { ingest: projectingIngest(temp, second) }),
      ).tick();

      expect(second).toEqual([]);
      // 'unchanged', not a bare "no summary": the restart read nothing BECAUSE
      // every fingerprint it loaded from the store still matched the bytes on
      // disk. That is the claim this test exists to make, and it is a different
      // fact from "there was no corpus root" or "the root could not be read".
      expect(summary).toEqual({ kind: 'unchanged' });
    });

    it('a restart re-reads only the session whose bytes moved', () => {
      const tree = twoSessions();
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, []) })).tick();

      tree[`${SESSION_A}.jsonl`] = file(MAIN + MAIN, { size: 30, mtimeMs: 9 });

      const calls: string[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(tree, { ingest: projectingIngest(temp, calls) }),
      );
      expect(tickSummary(watcher.tick())?.sessionsDiscovered).toBe(1);
      expect(calls).toEqual([SESSION_A]);

      // Second tick on the SAME watcher: already hydrated, nothing changed.
      expect(watcher.tick()).toEqual({ kind: 'unchanged' });
      expect(calls).toEqual([SESSION_A]);
    });

    it('re-ingests a file that SHRANK — a smaller file is never a skip', () => {
      const tree = twoSessions();
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, []) })).tick();

      // Truncation/rotation, still non-empty. mtime is deliberately left alone:
      // SIZE ALONE must be enough to force a re-ingest, or a rewrite that
      // happens to preserve mtime would hide behind the checkpoint forever.
      tree[`${SESSION_A}.jsonl`] = file('{"m":1}\n', { size: 5, mtimeMs: 1 });

      const calls: string[] = [];
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, calls) })).tick();
      expect(calls).toEqual([SESSION_A]);
    });

    it('re-ingests a session whose row is missing from the database', () => {
      const tree = twoSessions();
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, []) })).tick();

      temp.db.prepare('DELETE FROM sessions WHERE id = ?').run(SESSION_B);

      const calls: string[] = [];
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, calls) })).tick();
      expect(calls).toEqual([SESSION_B]);
    });

    it('replays everything when the ingest revision moves', () => {
      const tree = twoSessions();
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, []) })).tick();

      const calls: string[] = [];
      createCorpusWatcher(
        makeDeps(tree, {
          ingest: projectingIngest(temp, calls),
          checkpoints: createReplayCheckpointStore(temp.db, {
            revision: REPLAY_CHECKPOINT_REVISION + 1,
          }),
        }),
      ).tick();
      expect(calls.sort()).toEqual([SESSION_A, SESSION_B]);
    });

    it('replays everything when the corpus root changes', () => {
      const tree = twoSessions();
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, []) })).tick();

      const calls: string[] = [];
      createCorpusWatcher(
        makeDeps(tree, { ingest: projectingIngest(temp, calls) }, OTHER_ROOT),
      ).tick();
      expect(calls.sort()).toEqual([SESSION_A, SESSION_B]);
    });

    it('never checkpoints a quarantined session — a restart gets a fresh budget', () => {
      const tree = twoSessions();
      const failing = new Set([SESSION_A]);
      const first: string[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(tree, { ingest: projectingIngest(temp, first, failing) }),
      );

      for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
        watcher.tick();
      }
      // Quarantined in memory: the retry loop has stopped.
      expect(watcher.tick()).toEqual({ kind: 'unchanged' });
      expect(first.filter((id) => id === SESSION_A)).toHaveLength(MAX_INGEST_ATTEMPTS);

      // A restart must NOT inherit the quarantine — it is a within-process
      // circuit breaker, not a persisted verdict.
      const second: string[] = [];
      createCorpusWatcher(
        makeDeps(tree, { ingest: projectingIngest(temp, second, failing) }),
      ).tick();
      expect(second).toEqual([SESSION_A]);
    });

    it('never checkpoints a session that projected nothing', () => {
      const tree: MutableTree = {
        ...twoSessions(),
        // Zero-byte main, no session directory: enumerated, but it builds no
        // substrate, so nothing was projected and there is no row to back a
        // checkpoint. It must stay admitted on every boot.
        [`${SESSION_C}.jsonl`]: file('', { size: 0, mtimeMs: 3 }),
      };
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, []) })).tick();

      const calls: string[] = [];
      const summary = tickSummary(
        createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, calls) })).tick(),
      );

      expect(calls).toEqual([]); // it never reaches ingest…
      expect(summary?.sessionsDiscovered).toBe(1); // …but it IS re-admitted
      expect(summary?.sessionsSkipped).toBe(1);
    });
  });

  // --- The measurement, on real disk ---------------------------------------

  describe('cold replay cost (real files)', () => {
    let corpusRoot: string;
    let dbDir: string;

    beforeEach(() => {
      corpusRoot = makeTempDir('agenthropic-replay-corpus-');
      dbDir = makeTempDir('agenthropic-replay-db-');
      materializeCorpus(corpusRoot, allFixtures());
    });

    afterEach(() => {
      rmSync(corpusRoot, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    });

    function watcherDeps(
      db: ReturnType<typeof openSeededDb>,
      counters: FsCounters,
      checkpointed: boolean,
    ): CorpusWatcherDeps {
      return {
        db,
        pricing: loadPricing(db),
        env: corpusEnv(corpusRoot, 'checkpoint-proof'),
        intervalMs: INTERVAL_MS,
        watchdogThresholdMs: HUGE_WATCHDOG_MS,
        fs: countingFs(nodeCorpusFs(), counters),
        now: () => FIXED_NOW,
        nowMs: () => FIXED_NOW_MS,
        ...(checkpointed
          ? { checkpoints: createReplayCheckpointStore(db, { now: () => FIXED_NOW }) }
          : {}),
      };
    }

    it('a second cold start reads zero files and zero bytes', () => {
      const db = openSeededDb(join(dbDir, 'checkpointed.db'));
      try {
        const cold = newCounters();
        createCorpusWatcher(watcherDeps(db, cold, true)).tick();

        // A restarted process: new watcher, new counters, same database.
        const warm = newCounters();
        const summary = createCorpusWatcher(watcherDeps(db, warm, true)).tick();

        expect(cold.files).toBeGreaterThan(0);
        expect(cold.bytes).toBeGreaterThan(0);
        // The whole point, and the number that closes the scale risk.
        expect(warm.files).toBe(0);
        expect(warm.bytes).toBe(0);
        // 'unchanged' rather than a bare "no summary": the warm start read
        // nothing BECAUSE every fingerprint matched, which is the claim this
        // test exists to make.
        expect(summary).toEqual({ kind: 'unchanged' });

        // What a checkpoint CANNOT remove, stated rather than hidden: the
        // enumeration still lstats every entry to learn nothing changed.
        expect(warm.lstats).toBeGreaterThan(0);
        // Measured on this fixture corpus at the time of writing: cold read 21
        // files / 14579 bytes over 66 lstats; warm read 0 files / 0 bytes over
        // 36 lstats. The remaining cost is metadata-only and scales with the
        // session count, not with corpus SIZE — which is the term that made a
        // full cold replay ~137 s on the real 12.80 GiB / 1855-session corpus.
      } finally {
        db.close();
      }
    });

    it('an unchecked second start pays the full cost again (the baseline)', () => {
      const db = openSeededDb(join(dbDir, 'unchecked.db'));
      try {
        const cold = newCounters();
        createCorpusWatcher(watcherDeps(db, cold, false)).tick();

        const again = newCounters();
        createCorpusWatcher(watcherDeps(db, again, false)).tick();

        // Today's behaviour, measured: every byte read a second time.
        expect(again.files).toBe(cold.files);
        expect(again.bytes).toBe(cold.bytes);
      } finally {
        db.close();
      }
    });

    it('produces a database identical to an unchecked replay', () => {
      const checkpointed = openSeededDb(join(dbDir, 'a.db'));
      const unchecked = openSeededDb(join(dbDir, 'b.db'));
      try {
        for (let pass = 0; pass < 2; pass += 1) {
          createCorpusWatcher(watcherDeps(checkpointed, newCounters(), true)).tick();
          createCorpusWatcher(watcherDeps(unchecked, newCounters(), false)).tick();
        }

        const withCheckpoint = dumpAllTables(checkpointed);
        const without = dumpAllTables(unchecked);

        // Two tables are excluded, and both exclusions are about the DATABASE
        // rather than about ingest:
        //  - `ingest_checkpoints` IS the cache under test — it is the one row
        //    set that exists only in the checkpointed database, by design;
        //  - `schema_version.applied_at` is the wall-clock instant each
        //    migration ran, and these are two files created milliseconds apart.
        // Everything the dashboard actually reads is compared row for row.
        expect(withCheckpoint['ingest_checkpoints']).not.toHaveLength(0);
        expect(without['ingest_checkpoints']).toHaveLength(0);
        for (const table of ['ingest_checkpoints', 'schema_version']) {
          delete withCheckpoint[table];
          delete without[table];
        }
        expect(Object.keys(withCheckpoint)).toContain('token_usage');
        expect(withCheckpoint).toEqual(without);
      } finally {
        checkpointed.close();
        unchecked.close();
      }
    });

    it('re-reads only the appended session after a restart', () => {
      const db = openSeededDb(join(dbDir, 'append.db'));
      try {
        createCorpusWatcher(watcherDeps(db, newCounters(), true)).tick();

        const [firstFixture] = allFixtures();
        const target = firstFixture?.name ?? '';
        expect(target).not.toBe('');
        const sessionId = (
          db.prepare('SELECT id FROM sessions ORDER BY id LIMIT 1').get() as { id: string }
        ).id;
        appendFileSync(join(corpusRoot, P0_SLUG, `${sessionId}.jsonl`), `${MAIN}`);

        const warm = newCounters();
        const summary = tickSummary(createCorpusWatcher(watcherDeps(db, warm, true)).tick());

        expect(summary?.sessionsDiscovered).toBe(1);
        expect(warm.files).toBeGreaterThan(0);
        expect(warm.files).toBeLessThan(allFixtures().length);
      } finally {
        db.close();
      }
    });

    it('re-reads a truncated session after a restart', () => {
      const db = openSeededDb(join(dbDir, 'shrink.db'));
      try {
        createCorpusWatcher(watcherDeps(db, newCounters(), true)).tick();

        const sessionId = (
          db.prepare('SELECT id FROM sessions ORDER BY id LIMIT 1').get() as { id: string }
        ).id;
        truncateSync(join(corpusRoot, P0_SLUG, `${sessionId}.jsonl`), 0);

        const warm = newCounters();
        const summary = tickSummary(createCorpusWatcher(watcherDeps(db, warm, true)).tick());

        expect(summary?.sessionsDiscovered).toBe(1);
      } finally {
        db.close();
      }
    });
  });
});
