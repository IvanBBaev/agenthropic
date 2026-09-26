/**
 * A session that keeps failing while its bytes keep moving must not be
 * re-parsed on every poll.
 *
 * The retry budget used to be keyed on the fingerprint: three failures against
 * the SAME size:mtime quarantined a session, and any byte change handed it a
 * fresh budget. A live transcript that Claude Code appends to every few
 * seconds therefore never reached quarantine: each poll saw new bytes, reset
 * the count to 1, re-read the whole file and failed again (observed
 * 2026-09-26 against a real corpus: 17 s and 9 s ticks re-parsing one
 * transcript the halt gate refused on every pass, reported as "attempt 1/3,
 * will retry" forever). The budget now counts consecutive failed passes
 * whatever the bytes did, and a quarantined session whose bytes move is
 * re-read at a doubling cadence, 1, 2, 4... up to REREAD_BACKOFF_CAP_PASSES
 * passes apart, until a read succeeds. A success, a vanished session and a
 * pricing-table change still reset everything, exactly as before.
 */
import type { PricingEntry } from '@agenthropic/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCorpusWatcher,
  MAX_INGEST_ATTEMPTS,
  REREAD_BACKOFF_CAP_PASSES,
  type IngestFailureReport,
  type TickOutcome,
} from '../src/ingest/corpus-watcher';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';
import { createMigratedTempDb, type TempDb } from './helpers';
import { HUGE_WATCHDOG_MS } from './p0/harness';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-backoff-project';
const SESSION = 'dddddddd-4444-4444-8444-444444444444';
const MAIN = `${SESSION}.jsonl`;
const REASON = 'refusing to price at $0: unknown model id "claude-future-1"';
const ROW: PricingEntry = {
  model: 'claude-future-1',
  bucket: 'input',
  usdPerMtok: 3,
  effectiveFrom: '2026-01-01T00:00:00Z',
};

/** The passes a permanently failing live session is read on: the budget, then the backoff. */
function expectedReads(passes: number): number[] {
  const reads: number[] = [];
  for (let pass = 1; pass <= MAX_INGEST_ATTEMPTS; pass += 1) {
    reads.push(pass);
  }
  let at = MAX_INGEST_ATTEMPTS;
  let gap = 1;
  while (at + gap <= passes) {
    at += gap;
    reads.push(at);
    gap = Math.min(gap * 2, REREAD_BACKOFF_CAP_PASSES);
  }
  return reads;
}

describe('corpus watcher: a failing session whose bytes keep moving backs off', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  /**
   * One watcher over one live session. `tick(true)` appends to the transcript
   * first, as Claude Code does between polls; `tick(false)` leaves the bytes
   * alone. `reads` lists the 1-based passes on which ingest was actually run.
   */
  function harness(pricing?: () => readonly PricingEntry[]) {
    let bytes = 10;
    const tree: Record<string, NodeSpec> = {};
    const place = (): void => {
      tree[MAIN] = file('{"main":true}\n', { size: bytes, mtimeMs: bytes });
    };
    place();
    let failing = true;
    let pass = 0;
    const reads: number[] = [];
    const failures: IngestFailureReport[] = [];
    const watcher = createCorpusWatcher({
      db: temp.db,
      pricing: pricing ?? [],
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      intervalMs: 1000,
      watchdogThresholdMs: HUGE_WATCHDOG_MS,
      fs: makeFakeCorpusFs(ROOT, { [SLUG]: dir(tree) }),
      nowMs: () => Date.parse('2026-07-12T00:00:00Z'),
      ingest: (): IngestOutcome => {
        reads.push(pass);
        return {
          ok: !failing,
          sessionId: failing ? null : SESSION,
          costUsd: failing ? null : 0,
          agentsUpserted: 0,
          edgesInserted: 0,
          usageRowsInserted: 0,
          statusReconciliations: [],
          crossSessionUsageCollisions: 0,
          error: failing ? REASON : null,
        };
      },
      onIngestFailure: (report) => failures.push(report),
    });
    return {
      reads,
      failures,
      tick(append: boolean): TickOutcome {
        pass += 1;
        if (append) {
          bytes += 1;
          place();
        }
        return watcher.tick();
      },
      heal(): void {
        failing = false;
      },
      breakAgain(): void {
        failing = true;
      },
      exclusions: () => watcher.exclusions(),
    };
  }

  it('reads a permanently failing live session at a doubling cadence, not on every poll', () => {
    const live = harness();
    const passes = 130;
    for (let i = 0; i < passes; i += 1) {
      live.tick(true);
    }

    // 1, 2, 3 burn the budget; then gaps of 1, 2, 4, 8, 16, 32, 32: 11 reads
    // out of 130 polls, and the last two gaps are the cap.
    const reads = expectedReads(passes);
    expect(reads).toEqual([1, 2, 3, 4, 6, 10, 18, 34, 66, 98, 130]);
    expect(live.reads).toEqual(reads);
    expect(reads.at(-1)! - reads.at(-2)!).toBe(REREAD_BACKOFF_CAP_PASSES);

    // Every re-read that fails is reported, as the same spent budget: the
    // count never restarts on new bytes, and willRetry never flips back.
    expect(live.failures.map((f) => f.attempt)).toEqual([
      ...[1, 2, 3],
      ...new Array<number>(reads.length - 3).fill(MAX_INGEST_ATTEMPTS),
    ]);
    expect(live.failures.map((f) => f.willRetry)).toEqual([
      true,
      true,
      ...new Array<boolean>(reads.length - 2).fill(false),
    ]);
    expect(live.exclusions()).toEqual({ failing: 1, quarantined: 1 });
  });

  it('leaves a quarantined session alone while its bytes stay put, whatever the schedule says', () => {
    const live = harness();
    for (let i = 0; i < MAX_INGEST_ATTEMPTS + 1; i += 1) {
      live.tick(true); // budget spent on 3, re-read on 4 (gap 1), next due at 6
    }
    expect(live.reads).toEqual([1, 2, 3, 4]);

    for (let i = 0; i < 3; i += 1) {
      expect(live.tick(false).kind).toBe('unchanged'); // passes 5, 6, 7: no new bytes
    }
    expect(live.reads).toEqual([1, 2, 3, 4]);
    expect(live.exclusions()).toEqual({ failing: 1, quarantined: 1 });

    // The gap (2) has long elapsed, so the next append is read at once.
    expect(live.tick(true).kind).toBe('ingested');
    expect(live.reads).toEqual([1, 2, 3, 4, 8]);
  });

  it('a re-read that succeeds clears the quarantine, the backoff and the budget', () => {
    const live = harness();
    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
      live.tick(true);
    }
    expect(live.exclusions()).toEqual({ failing: 1, quarantined: 1 });

    live.heal();
    expect(live.tick(true).kind).toBe('ingested'); // pass 4: gap 1, read, ok
    expect(live.reads).toEqual([1, 2, 3, 4]);
    expect(live.exclusions()).toEqual({ failing: 0, quarantined: 0 });
    expect(live.tick(false).kind).toBe('unchanged');

    // Failing again afterwards starts from attempt 1, and the backoff from 1.
    live.breakAgain();
    live.failures.length = 0;
    for (let i = 0; i < 6; i += 1) {
      live.tick(true); // passes 6..11
    }
    expect(live.reads).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 11]);
    expect(live.failures.map((f) => [f.attempt, f.willRetry])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [3, false],
      [3, false],
    ]);
  });

  it('a pricing-table change re-admits a quarantined live session with a fresh budget and backoff', () => {
    let pricing: readonly PricingEntry[] = [];
    const live = harness(() => pricing);
    for (let i = 0; i < 34; i += 1) {
      live.tick(true);
    }
    expect(live.reads).toEqual([1, 2, 3, 4, 6, 10, 18, 34]); // gap now 16, next due at 50

    // The canonical cure arrives, but the session still fails (say, a second
    // missing model): it gets the full budget again, then backs off again.
    pricing = [ROW];
    live.failures.length = 0;
    for (let i = 0; i < 6; i += 1) {
      live.tick(true); // passes 35..40
    }
    expect(live.reads.slice(8)).toEqual([35, 36, 37, 38, 40]);
    expect(live.failures.map((f) => f.attempt)).toEqual([1, 2, 3, 3, 3]);
  });
});
