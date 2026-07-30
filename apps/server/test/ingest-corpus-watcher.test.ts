/**
 * WP-IN5/IN10/IN12 corpus watcher tests. The fake {@link CorpusFs} resolves
 * against a LIVE tree object, so mutating the tree between ticks simulates
 * appends, new sessions and a vanishing corpus without any real I/O. The
 * ingest seam is the same recorder stub the runner tests use, which keeps
 * these tests about the WATCHER's contract: replay-on-first-tick, fingerprint
 * diffing, overlap protection, containment self-stop, transient resilience,
 * and the poll loop's start/stop lifecycle.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSubstrate } from '@agenthropic/core';
import { ContainmentError } from '../src/corpus/fs-port';
import type { IngestFn } from '../src/corpus/ingest-corpus';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import { createCorpusWatcher, type CorpusWatcherDeps } from '../src/ingest/corpus-watcher';
import type { IngestEvent } from '../src/ingest/ingest-events';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-watched-project';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SESSION_C = 'cccccccc-3333-4333-8333-333333333333';
const MAIN = '{"main":true}\n';

const INTERVAL_MS = 1000;
const THRESHOLD_MS = 10 * 60_000;
/** Fixed "now", a full day after the helpers' fixed 2026-07-11T00:00:00Z stamps. */
const NOW_MS = Date.parse('2026-07-12T00:00:00Z');

type MutableTree = Record<string, NodeSpec>;

/** An ok outcome with every counter zeroed; spread over with per-test values. */
function outcome(overrides: Partial<IngestOutcome> = {}): IngestOutcome {
  return {
    ok: true,
    sessionId: 'stub-session',
    costUsd: 0,
    agentsUpserted: 0,
    edgesInserted: 0,
    usageRowsInserted: 0,
    error: null,
    ...overrides,
  };
}

/** Records the main relative path of every ingest call; answers via `respond`. */
function recorder(calls: string[], respond: () => IngestOutcome = () => outcome()): IngestFn {
  return (substrate: SessionSubstrate): IngestOutcome => {
    calls.push(substrate.files[0]?.relativePath ?? '<no main>');
    return respond();
  };
}

function statusOf(temp: TempDb, id: string): string | null {
  const row = temp.db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as {
    status: string | null;
  };
  return row.status;
}

describe('createCorpusWatcher', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    vi.useRealTimers();
    temp.cleanup();
  });

  function makeDeps(
    slugTree: MutableTree,
    overrides: Partial<CorpusWatcherDeps> = {},
  ): CorpusWatcherDeps {
    return {
      db: temp.db,
      pricing: [],
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      intervalMs: INTERVAL_MS,
      watchdogThresholdMs: THRESHOLD_MS,
      fs: makeFakeCorpusFs(ROOT, { [SLUG]: dir(slugTree) }),
      nowMs: () => NOW_MS,
      ...overrides,
    };
  }

  describe('replay and fingerprint diffing', () => {
    it('first tick replays the whole corpus and fires a session-ingested event per session', () => {
      const slugTree: MutableTree = {
        [`${SESSION_A}.jsonl`]: file(MAIN, { size: 10, mtimeMs: 1 }),
        [`${SESSION_B}.jsonl`]: file(MAIN, { size: 20, mtimeMs: 2 }),
      };
      const calls: string[] = [];
      const events: IngestEvent[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: recorder(calls, () =>
            outcome({
              sessionId: null, // forces the event's ref-sessionId fallback
              agentsUpserted: 2,
              edgesInserted: 1,
              usageRowsInserted: 5,
              costUsd: 0.25,
            }),
          ),
          onIngestEvent: (event) => events.push(event),
        }),
      );

      const summary = watcher.tick();

      expect(calls.sort()).toEqual([`${SESSION_A}.jsonl`, `${SESSION_B}.jsonl`]);
      expect(summary?.sessionsDiscovered).toBe(2);
      expect(summary?.sessionsOk).toBe(2);
      expect(events).toHaveLength(2);
      expect(
        events.find((e) => e.type === 'session-ingested' && e.sessionId === SESSION_A),
      ).toEqual({
        type: 'session-ingested',
        sessionId: SESSION_A,
        projectSlug: SLUG,
        agentsUpserted: 2,
        edgesInserted: 1,
        usageRowsInserted: 5,
        costUsd: 0.25,
      });
    });

    it('an unchanged second tick ingests nothing and returns null', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(makeDeps(slugTree, { ingest: recorder(calls) }));

      expect(watcher.tick()).not.toBeNull();
      expect(watcher.tick()).toBeNull();
      expect(calls).toEqual([`${SESSION_A}.jsonl`]);
    });

    it('re-ingests ONLY the session whose file changed', () => {
      const slugTree: MutableTree = {
        [`${SESSION_A}.jsonl`]: file(MAIN, { size: 10, mtimeMs: 1 }),
        [`${SESSION_B}.jsonl`]: file(MAIN, { size: 20, mtimeMs: 2 }),
      };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(makeDeps(slugTree, { ingest: recorder(calls) }));
      watcher.tick();
      calls.length = 0;

      // An append: same file, bigger and newer.
      slugTree[`${SESSION_A}.jsonl`] = file(MAIN + MAIN, { size: 24, mtimeMs: 9 });
      const summary = watcher.tick();

      expect(calls).toEqual([`${SESSION_A}.jsonl`]);
      // sessionsDiscovered counts ADMITTED refs — the filter ran before the fold.
      expect(summary?.sessionsDiscovered).toBe(1);
      expect(summary?.sessionsOk).toBe(1);
    });

    it('picks up a brand-new session on a later tick', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(makeDeps(slugTree, { ingest: recorder(calls) }));
      watcher.tick();
      calls.length = 0;

      slugTree[`${SESSION_C}.jsonl`] = file(MAIN, { mtimeMs: 5 });
      const summary = watcher.tick();

      expect(calls).toEqual([`${SESSION_C}.jsonl`]);
      expect(summary?.sessionsOk).toBe(1);
    });

    it('a vanished corpus root ticks to null and a reappearing one replays from scratch', () => {
      const slugTree: MutableTree = {
        [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }),
        [`${SESSION_B}.jsonl`]: file(MAIN, { mtimeMs: 2 }),
      };
      // The corpus lives one level down so the ROOT-mounted holder can lose it.
      const holder: MutableTree = { projects: dir({ [SLUG]: dir(slugTree) }) };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          env: { CLAUDE_PROJECTS_DIR: join(ROOT, 'projects') },
          fs: makeFakeCorpusFs(ROOT, holder),
          ingest: recorder(calls),
        }),
      );
      watcher.tick();
      expect(calls).toHaveLength(2);
      calls.length = 0;

      const projects = holder['projects'];
      delete holder['projects'];
      expect(watcher.tick()).toBeNull(); // ENOENT root: a normal empty condition
      expect(calls).toHaveLength(0);

      // Reappearance: the fingerprints were cleared, so EVERYTHING re-ingests
      // (idempotence makes over-ingesting safe; staleness would lose data).
      holder['projects'] = projects!;
      const summary = watcher.tick();
      expect(calls.sort()).toEqual([`${SESSION_A}.jsonl`, `${SESSION_B}.jsonl`]);
      expect(summary?.sessionsOk).toBe(2);
    });
  });

  describe('overlap protection', () => {
    it('a re-entrant tick() from inside onIngestEvent is a no-op', () => {
      const slugTree: MutableTree = {
        [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }),
        [`${SESSION_B}.jsonl`]: file(MAIN, { mtimeMs: 2 }),
      };
      const calls: string[] = [];
      const innerResults: unknown[] = [];
      const holder: { watcher?: ReturnType<typeof createCorpusWatcher> } = {};
      holder.watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: recorder(calls),
          onIngestEvent: () => {
            innerResults.push(holder.watcher!.tick());
          },
        }),
      );

      const summary = holder.watcher.tick();

      expect(summary?.sessionsOk).toBe(2);
      expect(calls).toHaveLength(2); // the re-entrant calls ingested NOTHING
      expect(innerResults).toEqual([null, null]);
    });
  });

  describe('containment is fatal', () => {
    it('stops itself permanently and reports through onFatal', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const tree: MutableTree = { [SLUG]: dir(slugTree), '..': dir({}) };
      const calls: string[] = [];
      const fatal = vi.fn();
      insertSession(temp.db, 'session-1');
      insertAgent(temp.db, 'a-stale', 'session-1', null, 'working');
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          fs: makeFakeCorpusFs(ROOT, tree),
          ingest: recorder(calls),
          onFatal: fatal,
        }),
      );

      expect(watcher.tick()).toBeNull();
      expect(fatal).toHaveBeenCalledTimes(1);
      expect(fatal.mock.calls[0]?.[0]).toBeInstanceOf(ContainmentError);
      expect(calls).toHaveLength(0);

      // Even a now-healed corpus never revives a containment-stopped watcher,
      // and the watchdog no longer runs either: the stale agent stays put.
      delete tree['..'];
      expect(watcher.tick()).toBeNull();
      expect(calls).toHaveLength(0);
      expect(statusOf(temp, 'a-stale')).toBe('working');
      expect(() => {
        watcher.stop();
        watcher.stop();
      }).not.toThrow();
    });

    it('does not throw when no onFatal handler is wired', () => {
      const watcher = createCorpusWatcher(
        makeDeps({}, { fs: makeFakeCorpusFs(ROOT, { '..': dir({}) }) }),
      );

      expect(() => watcher.tick()).not.toThrow();
      expect(watcher.tick()).toBeNull();
    });
  });

  describe('transient errors and the watchdog', () => {
    it('skips the pass on a transient root error but still sweeps the watchdog', () => {
      insertSession(temp.db, 'session-1');
      insertAgent(temp.db, 'a-stale', 'session-1', null, 'working');
      const events: IngestEvent[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(
          {},
          {
            fs: makeFakeCorpusFs(ROOT, {}, { realpathThrow: 'EACCES' }),
            onIngestEvent: (event) => events.push(event),
          },
        ),
      );

      expect(watcher.tick()).toBeNull();
      expect(statusOf(temp, 'a-stale')).toBe('unknown');
      expect(events).toEqual([
        {
          type: 'agent-status-changed',
          agentId: 'a-stale',
          sessionId: 'session-1',
          oldStatus: 'working',
          newStatus: 'unknown',
        },
      ]);
      // The error was transient: the NEXT tick tries again (and sweeps to silence).
      expect(watcher.tick()).toBeNull();
      expect(events).toHaveLength(1);
    });

    it('flips a stale agent on an otherwise-quiet healthy tick', () => {
      insertSession(temp.db, 'session-1');
      insertAgent(temp.db, 'a-stale', 'session-1', null, 'waiting');
      const events: IngestEvent[] = [];
      const watcher = createCorpusWatcher(
        makeDeps({}, { onIngestEvent: (event) => events.push(event) }),
      );

      expect(watcher.tick()).toBeNull(); // empty corpus: nothing to ingest
      expect(events.map((e) => e.type)).toEqual(['agent-status-changed']);
      expect(statusOf(temp, 'a-stale')).toBe('unknown');
    });
  });

  describe('poll loop lifecycle', () => {
    it('start() polls every interval, stop() halts it, double-start is safe', () => {
      vi.useFakeTimers();
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(makeDeps(slugTree, { ingest: recorder(calls) }));

      watcher.start();
      watcher.start(); // idempotent: must NOT stack a second interval
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(calls).toEqual([`${SESSION_A}.jsonl`]); // exactly one replay, not two

      vi.advanceTimersByTime(5 * INTERVAL_MS); // unchanged corpus: quiet ticks
      expect(calls).toHaveLength(1);

      slugTree[`${SESSION_A}.jsonl`] = file(MAIN, { mtimeMs: 2 });
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(calls).toHaveLength(2);

      watcher.stop();
      slugTree[`${SESSION_A}.jsonl`] = file(MAIN, { mtimeMs: 3 });
      vi.advanceTimersByTime(10 * INTERVAL_MS);
      expect(calls).toHaveLength(2); // stopped: the change is never observed

      watcher.start(); // a stopped watcher stays stopped
      vi.advanceTimersByTime(10 * INTERVAL_MS);
      expect(calls).toHaveLength(2);
    });
  });

  describe('production defaults', () => {
    it('runs on the real fs port and wall clock when neither is injected', () => {
      // No `fs` → the production nodeCorpusFs resolves a guaranteed-absent
      // directory to ENOENT (null root, null tick) — never the real corpus.
      // No `nowMs` → Date.now: the helpers' fixed 2026-07-11 stamps are long
      // stale against wall time, so the sweep still flips the agent.
      insertSession(temp.db, 'session-1');
      insertAgent(temp.db, 'a-stale', 'session-1', null, 'working');
      const watcher = createCorpusWatcher({
        db: temp.db,
        pricing: [],
        env: { CLAUDE_PROJECTS_DIR: join(temp.dir, 'no-such-corpus') },
        intervalMs: INTERVAL_MS,
        watchdogThresholdMs: THRESHOLD_MS,
      });

      expect(watcher.tick()).toBeNull();
      expect(statusOf(temp, 'a-stale')).toBe('unknown');
    });
  });
});
