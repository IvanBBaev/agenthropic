/**
 * A transient read failure must be retried by the NEXT poll, not by the next
 * restart. The change fingerprint lstat()s files and never reads them, so a
 * file that was unreadable (EACCES, EIO, EMFILE...) and then becomes readable
 * again, with the same bytes, size and mtime, produces the SAME fingerprint
 * on both passes. If the watcher committed that fingerprint after the failed
 * read, change detection alone would never re-read the session, and the lost
 * content would stay lost until a restart replayed the corpus.
 */
import type { SessionSubstrate } from '@agenthropic/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorpusFs } from '../src/corpus/fs-port';
import type { IngestFn } from '../src/corpus/ingest-corpus';
import { createReplayCheckpointStore } from '../src/db/replay-checkpoints';
import { upsertSession } from '../src/db/sessions';
import {
  createCorpusWatcher,
  MAX_INGEST_ATTEMPTS,
  REREAD_BACKOFF_CAP_PASSES,
  type CorpusWatcherDeps,
} from '../src/ingest/corpus-watcher';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';
import { createMigratedTempDb, type TempDb } from './helpers';
import { HUGE_WATCHDOG_MS } from './p0/harness';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-lane-u-project';
const SESSION = 'cccccccc-2222-4222-8222-222222222222';
const MAIN = `${SESSION}.jsonl`;
const AGENT = 'subagents/agent-def456.jsonl';

interface TreeFaults {
  readonly main?: string;
  readonly agent?: string;
  /** Moves the main transcript's mtime: a byte change lstat CAN see. */
  readonly mainMtimeMs?: number;
}

/**
 * The same session on every call: identical content, size and mtime unless
 * `mainMtimeMs` says otherwise. Only the read fault differs, which is exactly
 * what lstat cannot see.
 */
function tree(faults: TreeFaults = {}): Record<string, NodeSpec> {
  return {
    [MAIN]: file('{"main":true}\n', {
      size: 14,
      mtimeMs: faults.mainMtimeMs ?? 1,
      ...(faults.main === undefined ? {} : { throwCode: faults.main }),
    }),
    [SESSION]: dir({
      subagents: dir({
        'agent-def456.jsonl': file('{"a":1}\n', {
          size: 8,
          mtimeMs: 5,
          ...(faults.agent === undefined ? {} : { throwCode: faults.agent }),
        }),
      }),
    }),
  };
}

/**
 * A filesystem whose read faults can be switched between passes of ONE
 * watcher, so no restart is involved. Every call is delegated to a fake built
 * from the current faults.
 */
function switchableFs(initial: TreeFaults): { fs: CorpusFs; set(faults: TreeFaults): void } {
  let current = makeFakeCorpusFs(ROOT, { [SLUG]: dir(tree(initial)) });
  const fs: CorpusFs = {
    readDirNames: (abs) => current.readDirNames(abs),
    lstat: (abs) => current.lstat(abs),
    realpath: (abs) => current.realpath(abs),
    readFileConfined: (abs, maxBytes) => current.readFileConfined(abs, maxBytes),
    readFileTailConfined: (abs, fromByte, maxBytes) =>
      current.readFileTailConfined(abs, fromByte, maxBytes),
  };
  return {
    fs,
    set(faults) {
      current = makeFakeCorpusFs(ROOT, { [SLUG]: dir(tree(faults)) });
    },
  };
}

describe('corpus watcher: a transient read failure is retried on the next poll', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  /** Records the files of every substrate it is handed and projects the session row. */
  function recordingIngest(seen: string[][], fail = false): IngestFn {
    return (substrate: SessionSubstrate): IngestOutcome => {
      seen.push(substrate.files.map((f) => f.relativePath));
      if (fail) {
        return {
          ok: false,
          sessionId: SESSION,
          costUsd: 0,
          agentsUpserted: 0,
          edgesInserted: 0,
          usageRowsInserted: 0,
          statusReconciliations: [],
          crossSessionUsageCollisions: 0,
          error: 'synthetic halt',
        };
      }
      upsertSession(temp.db, {
        id: SESSION,
        projectSlug: SLUG,
        startedAt: '2026-07-11T00:00:00Z',
        lastActivityAt: '2026-07-11T00:00:00Z',
        status: 'working',
      });
      return {
        ok: true,
        sessionId: SESSION,
        costUsd: 0,
        agentsUpserted: 0,
        edgesInserted: 0,
        usageRowsInserted: 0,
        statusReconciliations: [],
        crossSessionUsageCollisions: 0,
        error: null,
      };
    };
  }

  function deps(fs: CorpusFs, ingest: IngestFn, withCheckpoints = false): CorpusWatcherDeps {
    return {
      db: temp.db,
      pricing: [],
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      intervalMs: 1000,
      watchdogThresholdMs: HUGE_WATCHDOG_MS,
      fs,
      nowMs: () => Date.parse('2026-07-12T00:00:00Z'),
      ingest,
      ...(withCheckpoints
        ? {
            checkpoints: createReplayCheckpointStore(temp.db, {
              now: () => '2026-07-12T00:00:00.000Z',
            }),
          }
        : {}),
    };
  }

  it('re-reads a session whose subagent file recovers, then settles and checkpoints it', () => {
    const disk = switchableFs({ agent: 'EACCES' });
    const seen: string[][] = [];
    const watcher = createCorpusWatcher(deps(disk.fs, recordingIngest(seen), true));

    expect(watcher.tick().kind).toBe('ingested');
    expect(seen).toEqual([[MAIN]]); // the agent file was lost this pass

    disk.set({}); // same bytes, size and mtime; the read now works
    expect(watcher.tick().kind).toBe('ingested');
    expect(seen).toEqual([[MAIN], [MAIN, AGENT]]);

    // A clean read clears the mark: the session is not re-read forever.
    expect(watcher.tick().kind).toBe('unchanged');
    expect(seen).toHaveLength(2);

    // And the clean pass is the one that checkpoints: a restart skips it.
    const afterRestart: string[][] = [];
    expect(
      createCorpusWatcher(deps(disk.fs, recordingIngest(afterRestart), true)).tick().kind,
    ).toBe('unchanged');
    expect(afterRestart).toEqual([]);
  });

  it('re-reads a session whose main transcript was unreadable (no substrate at all)', () => {
    const disk = switchableFs({ main: 'EACCES', agent: 'EACCES' });
    const seen: string[][] = [];
    const watcher = createCorpusWatcher(deps(disk.fs, recordingIngest(seen)));

    expect(watcher.tick().kind).toBe('ingested');
    expect(seen).toEqual([]); // withheld: nothing readable to build from

    disk.set({});
    expect(watcher.tick().kind).toBe('ingested');
    expect(seen).toEqual([[MAIN, AGENT]]);
  });

  /** Ticks the watcher `passes` times; returns the 1-based passes that read the session. */
  function readingPasses(seen: string[][], tick: () => unknown, passes: number): number[] {
    const reads: number[] = [];
    for (let pass = 1; pass <= passes; pass += 1) {
      const before = seen.length;
      tick();
      if (seen.length > before) {
        reads.push(pass);
      }
    }
    return reads;
  }

  it('backs off 1, 2, 4, 8... passes while the file stays unreadable, then recovers', () => {
    const disk = switchableFs({ agent: 'EIO' });
    const seen: string[][] = [];
    const watcher = createCorpusWatcher(deps(disk.fs, recordingIngest(seen)));

    // Pass 1 is the first read; each re-read doubles the distance to the next.
    expect(readingPasses(seen, () => watcher.tick(), 20)).toEqual([1, 2, 4, 8, 16]);
    expect(seen.every((files) => files.length === 1 && files[0] === MAIN)).toBe(true);

    // Never gives up: the next scheduled pass (32) picks up the recovered file.
    disk.set({});
    expect(readingPasses(seen, () => watcher.tick(), 12)).toEqual([12]);
    expect(seen.at(-1)).toEqual([MAIN, AGENT]);
  });

  it('caps the backoff gap and keeps re-reading at the cap', () => {
    const disk = switchableFs({ agent: 'EIO' });
    const seen: string[][] = [];
    const watcher = createCorpusWatcher(deps(disk.fs, recordingIngest(seen)));

    const cap = REREAD_BACKOFF_CAP_PASSES;
    expect(cap).toBe(32);
    expect(readingPasses(seen, () => watcher.tick(), 4 * cap + 1)).toEqual([
      1,
      2,
      4,
      8,
      16,
      32,
      32 + cap,
      32 + 2 * cap,
      32 + 3 * cap,
    ]);
  });

  it('re-reads at once when the bytes change during a backoff gap', () => {
    const disk = switchableFs({ agent: 'EIO' });
    const seen: string[][] = [];
    const watcher = createCorpusWatcher(deps(disk.fs, recordingIngest(seen)));

    expect(readingPasses(seen, () => watcher.tick(), 5)).toEqual([1, 2, 4]); // next due: 8

    disk.set({ agent: 'EIO', mainMtimeMs: 2 }); // an append the fingerprint sees
    expect(readingPasses(seen, () => watcher.tick(), 1)).toEqual([1]); // pass 6, not 8

    // Still unreadable, so the schedule resumes rather than re-reading every pass.
    expect(readingPasses(seen, () => watcher.tick(), 3)).toEqual([]);
  });

  it('leaves a failing unreadable session to the retry budget, so quarantine still ends the loop', () => {
    const disk = switchableFs({ agent: 'EACCES' });
    const seen: string[][] = [];
    const watcher = createCorpusWatcher(deps(disk.fs, recordingIngest(seen, true)));

    for (let pass = 0; pass < MAX_INGEST_ATTEMPTS; pass += 1) {
      expect(watcher.tick().kind).toBe('ingested');
    }
    expect(seen).toHaveLength(MAX_INGEST_ATTEMPTS);
    expect(watcher.exclusions()).toEqual({ failing: 1, quarantined: 1 });

    // Quarantined: the read mark must not reopen the hot loop it closed.
    expect(watcher.tick().kind).toBe('unchanged');
    expect(seen).toHaveLength(MAX_INGEST_ATTEMPTS);
  });
});
