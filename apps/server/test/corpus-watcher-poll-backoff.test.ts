/**
 * OPS-16: adaptive poll back-off. A synchronous pass blocks the event loop for
 * its whole duration, so after a slow pass the scheduled poll skips intervals
 * until the loop has been idle for POLL_BACKOFF_IDLE_RATIO times that duration,
 * capped at POLL_BACKOFF_MAX_SKIPPED_INTERVALS. A fast pass skips nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestFn } from '../src/corpus/ingest-corpus';
import {
  POLL_BACKOFF_IDLE_RATIO,
  POLL_BACKOFF_MAX_SKIPPED_INTERVALS,
  createCorpusWatcher,
  pollIntervalsToSkip,
  type CorpusWatcherDeps,
  type TickOutcome,
} from '../src/ingest/corpus-watcher';
import { createMigratedTempDb, type TempDb } from './helpers';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-backoff-project';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const MAIN = '{"main":true}\n';
const INTERVAL_MS = 1000;
const NOW_MS = Date.parse('2026-07-12T00:00:00Z');

describe('pollIntervalsToSkip()', () => {
  it('skips nothing for a pass up to half an interval long', () => {
    expect(pollIntervalsToSkip(0, 3000)).toBe(0);
    expect(pollIntervalsToSkip(235, 3000)).toBe(0);
    expect(pollIntervalsToSkip(1500, 3000)).toBe(0);
  });

  it('keeps POLL_BACKOFF_IDLE_RATIO times the pass duration idle before the next pass', () => {
    expect(POLL_BACKOFF_IDLE_RATIO).toBe(2);
    // 1.6 s wants 3.2 s idle: the next interval gives 3 s, one more skip covers it.
    expect(pollIntervalsToSkip(1600, 3000)).toBe(1);
    // 4.5 s wants exactly 9 s idle: three intervals, two of them skipped.
    expect(pollIntervalsToSkip(4500, 3000)).toBe(2);
    for (const durationMs of [1600, 4500, 7000, 12_000]) {
      const idleMs = (pollIntervalsToSkip(durationMs, 3000) + 1) * 3000;
      expect(idleMs).toBeGreaterThanOrEqual(durationMs * POLL_BACKOFF_IDLE_RATIO);
    }
  });

  it('caps the skip, so a very slow pass or a clock jump cannot stall the poll', () => {
    expect(POLL_BACKOFF_MAX_SKIPPED_INTERVALS).toBe(9);
    expect(pollIntervalsToSkip(15_000, 3000)).toBe(9);
    expect(pollIntervalsToSkip(3_600_000, 3000)).toBe(9);
  });

  it('skips nothing when the wall clock stepped back mid-pass', () => {
    expect(pollIntervalsToSkip(-60_000, 3000)).toBe(0);
  });
});

describe('the scheduled poll under back-off', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    temp.cleanup();
  });

  /**
   * A watcher whose ingest costs `costMs.value` of the injected clock on each
   * call, so a pass's duration is exact. The corpus file changes on every
   * interval the test asks for, so every pass that runs ingests.
   */
  function harness(costMs: { value: number }): {
    readonly deps: CorpusWatcherDeps;
    readonly calls: number[];
    touch: () => void;
  } {
    let clockMs = NOW_MS;
    let mtimeMs = 1;
    const slugTree: Record<string, NodeSpec> = {
      [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs }),
    };
    const calls: number[] = [];
    const ingest: IngestFn = () => {
      calls.push(clockMs);
      clockMs += costMs.value;
      return {
        ok: true,
        sessionId: 'stub-session',
        costUsd: 0,
        unpricedTokens: 0,
        agentsUpserted: 0,
        edgesInserted: 0,
        usageRowsInserted: 0,
        statusReconciliations: [],
        crossSessionUsageCollisions: 0,
        error: null,
      };
    };
    return {
      deps: {
        db: temp.db,
        pricing: [],
        env: { CLAUDE_PROJECTS_DIR: ROOT },
        intervalMs: INTERVAL_MS,
        watchdogThresholdMs: 10 * 60_000,
        fs: makeFakeCorpusFs(ROOT, { [SLUG]: dir(slugTree) }),
        nowMs: () => clockMs,
        ingest,
      },
      calls,
      touch: () => {
        mtimeMs += 1;
        slugTree[`${SESSION_A}.jsonl`] = file(MAIN, { mtimeMs });
      },
    };
  }

  /** Advance one interval, changing the corpus first so a pass that runs ingests. */
  function step(h: ReturnType<typeof harness>): void {
    h.touch();
    vi.advanceTimersByTime(INTERVAL_MS);
  }

  it('reports no back-off before any pass and after a fast one, and polls every interval', () => {
    const costMs = { value: 10 };
    const h = harness(costMs);
    const watcher = createCorpusWatcher(h.deps);
    expect(watcher.pollBackoffIntervals()).toBe(0);

    watcher.start();
    for (let i = 0; i < 4; i += 1) {
      step(h);
    }
    expect(h.calls).toHaveLength(4);
    expect(watcher.pollBackoffIntervals()).toBe(0);
    watcher.stop();
  });

  it('skips the intervals a slow pass asks for, reading nothing and reporting nothing', () => {
    const costMs = { value: 1600 }; // 1.6 intervals: wants 3.2 intervals idle
    const h = harness(costMs);
    const outcomes: TickOutcome[] = [];
    const watcher = createCorpusWatcher({ ...h.deps, onTickOutcome: (o) => outcomes.push(o) });

    watcher.start();
    step(h); // pass 1 runs and is slow
    expect(h.calls).toHaveLength(1);
    expect(watcher.pollBackoffIntervals()).toBe(3);

    step(h);
    step(h);
    step(h); // three skipped intervals: no read, no outcome
    expect(h.calls).toHaveLength(1);
    expect(outcomes).toHaveLength(1);

    costMs.value = 10;
    step(h); // the pass after the skips picks up every byte that moved meanwhile
    expect(h.calls).toHaveLength(2);
    expect(outcomes.map((o) => o.kind)).toEqual(['ingested', 'ingested']);
    expect(watcher.pollBackoffIntervals()).toBe(0);

    step(h); // fast again: no skip
    expect(h.calls).toHaveLength(3);
    watcher.stop();
  });

  it('caps the skip at POLL_BACKOFF_MAX_SKIPPED_INTERVALS', () => {
    const costMs = { value: 60 * INTERVAL_MS };
    const h = harness(costMs);
    const watcher = createCorpusWatcher(h.deps);

    watcher.start();
    step(h);
    expect(watcher.pollBackoffIntervals()).toBe(POLL_BACKOFF_MAX_SKIPPED_INTERVALS);
    costMs.value = 10;
    for (let i = 0; i < POLL_BACKOFF_MAX_SKIPPED_INTERVALS; i += 1) {
      step(h);
    }
    expect(h.calls).toHaveLength(1);
    step(h);
    expect(h.calls).toHaveLength(2);
    watcher.stop();
  });

  it('lets a slow manual pass (the startup replay) back off the first scheduled poll', () => {
    const costMs = { value: 2600 }; // wants 5.2 intervals idle: 5 skipped
    const h = harness(costMs);
    const watcher = createCorpusWatcher(h.deps);

    expect(watcher.tick().kind).toBe('ingested');
    expect(watcher.pollBackoffIntervals()).toBe(5);
    costMs.value = 10;
    watcher.start();
    for (let i = 0; i < 5; i += 1) {
      step(h);
    }
    expect(h.calls).toHaveLength(1);
    step(h);
    expect(h.calls).toHaveLength(2);
    watcher.stop();
  });
});
