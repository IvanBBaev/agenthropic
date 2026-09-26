/**
 * A session the enumeration could not LOOK at is not a session that is gone.
 *
 * A slug directory whose listing or probe fails (EACCES, EIO, EMFILE under
 * load), or a main transcript whose probe fails, hides the sessions beneath it
 * for that pass. The watcher used to treat their absence from the enumeration
 * as "left the disk": it pruned their fingerprints and retry budgets, and the
 * checkpoint commit dropped their persisted rows. One transient fault on a busy
 * slug therefore cost a full re-read of every session under it the moment it
 * recovered, and a restart in between replayed them from scratch. The watcher
 * now holds every known session the enumeration reported as unreadable, by
 * the slug it was last seen under, and a session it cannot attribute yet
 * (hydrated from a checkpoint, never enumerated by this process) is held
 * whenever anything at all was unreadable. A session that really vanished is
 * still pruned on the same pass.
 */
import type { SessionSubstrate } from '@agenthropic/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorpusFs } from '../src/corpus/fs-port';
import type { IngestFn } from '../src/corpus/ingest-corpus';
import {
  createReplayCheckpointStore,
  type ReplayCheckpointStore,
} from '../src/db/replay-checkpoints';
import { upsertSession } from '../src/db/sessions';
import { createCorpusWatcher, type CorpusWatcher } from '../src/ingest/corpus-watcher';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';
import { createMigratedTempDb, type TempDb } from './helpers';
import { HUGE_WATCHDOG_MS } from './p0/harness';

const ROOT = '/fake/corpus';
const SLUG_A = '-Users-synthetic-partial-a';
const SLUG_B = '-Users-synthetic-partial-b';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SESSION_C = 'cccccccc-3333-4333-8333-333333333333';
const MAIN = '{"main":true}\n';

interface Faults {
  /** `readDirNames` of slug A throws this code. */
  readonly slugAReaddir?: string;
  /** `lstat` of slug A throws this code. */
  readonly slugALstat?: string;
  /** `lstat` of session A's main transcript throws this code. */
  readonly mainALstat?: string;
  /** Session B is deleted. */
  readonly dropB?: boolean;
  /** Session C's transcript has grown (a new fingerprint). */
  readonly appendC?: boolean;
}

function corpus(f: Faults = {}): Record<string, NodeSpec> {
  const a = dir(
    {
      [`${SESSION_A}.jsonl`]: file(MAIN, {
        size: 14,
        mtimeMs: 1,
        ...(f.mainALstat === undefined ? {} : { throwLstat: f.mainALstat }),
      }),
    },
    {
      ...(f.slugAReaddir === undefined ? {} : { throwReaddir: f.slugAReaddir }),
      ...(f.slugALstat === undefined ? {} : { throwLstat: f.slugALstat }),
    },
  );
  const b = dir({
    ...(f.dropB === true ? {} : { [`${SESSION_B}.jsonl`]: file(MAIN, { size: 14, mtimeMs: 1 }) }),
    [`${SESSION_C}.jsonl`]: file(
      MAIN,
      f.appendC === true ? { size: 28, mtimeMs: 2 } : { size: 14, mtimeMs: 1 },
    ),
  });
  return { [SLUG_A]: a, [SLUG_B]: b };
}

/** One filesystem whose faults switch between passes of one watcher, no restart. */
function switchableFs(initial: Faults = {}): { fs: CorpusFs; set(faults: Faults): void } {
  let current = makeFakeCorpusFs(ROOT, corpus(initial));
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
      current = makeFakeCorpusFs(ROOT, corpus(faults));
    },
  };
}

describe('corpus watcher: an unreadable slug or transcript hides sessions, it does not remove them', () => {
  let temp: TempDb;
  let store: ReplayCheckpointStore;

  beforeEach(() => {
    temp = createMigratedTempDb();
    store = createReplayCheckpointStore(temp.db, { now: () => '2026-07-12T00:00:00.000Z' });
  });

  afterEach(() => {
    temp.cleanup();
  });

  /** Ingest that records which session it was handed and gives it a row. */
  function recordingIngest(seen: string[]): IngestFn {
    return (substrate: SessionSubstrate): IngestOutcome => {
      const main = substrate.files.find((f) => !f.relativePath.includes('/'));
      const sessionId = main === undefined ? 'none' : main.relativePath.replace(/\.jsonl$/, '');
      seen.push(sessionId);
      upsertSession(temp.db, {
        id: sessionId,
        projectSlug: sessionId === SESSION_A ? SLUG_A : SLUG_B,
        startedAt: '2026-07-11T00:00:00Z',
        lastActivityAt: '2026-07-11T00:00:00Z',
        status: 'working',
      });
      return {
        ok: true,
        sessionId,
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

  function watcher(fs: CorpusFs, seen: string[]): CorpusWatcher {
    return createCorpusWatcher({
      db: temp.db,
      pricing: [],
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      intervalMs: 1000,
      watchdogThresholdMs: HUGE_WATCHDOG_MS,
      fs,
      nowMs: () => Date.parse('2026-07-12T00:00:00Z'),
      ingest: recordingIngest(seen),
      checkpoints: store,
    });
  }

  const checkpointed = (): string[] => [...store.load(ROOT).keys()].sort();

  it.each([
    ['listing', { slugAReaddir: 'EACCES' }],
    ['probe', { slugALstat: 'EIO' }],
  ])(
    'holds the sessions under a slug whose %s fails, and does not re-read them once it recovers',
    (_, fault) => {
      const disk = switchableFs();
      const seen: string[] = [];
      const w = watcher(disk.fs, seen);
      expect(w.tick().kind).toBe('ingested');
      expect([...seen].sort()).toEqual([SESSION_A, SESSION_B, SESSION_C]);
      expect(checkpointed()).toEqual([SESSION_A, SESSION_B, SESSION_C]);

      // Slug A is unreadable while C (under the readable slug B) grows, so this
      // pass ingests C and commits: A must survive both the in-memory prune and
      // the persisted one.
      disk.set({ ...fault, appendC: true });
      seen.length = 0;
      expect(w.tick().kind).toBe('ingested');
      expect(seen).toEqual([SESSION_C]);
      expect(checkpointed()).toEqual([SESSION_A, SESSION_B, SESSION_C]);

      // Slug A is back with the same bytes: nothing to read.
      disk.set({ appendC: true });
      seen.length = 0;
      expect(w.tick().kind).toBe('unchanged');
      expect(seen).toEqual([]);
    },
  );

  it('holds a session whose main transcript cannot be probed, by its own path', () => {
    const disk = switchableFs();
    const seen: string[] = [];
    const w = watcher(disk.fs, seen);
    w.tick();

    disk.set({ mainALstat: 'EACCES', appendC: true });
    seen.length = 0;
    expect(w.tick().kind).toBe('ingested');
    expect(seen).toEqual([SESSION_C]);
    expect(checkpointed()).toEqual([SESSION_A, SESSION_B, SESSION_C]);

    disk.set({ appendC: true });
    seen.length = 0;
    expect(w.tick().kind).toBe('unchanged');
    expect(seen).toEqual([]);
  });

  it('holds a hydrated session it cannot attribute yet, when anything was unreadable', () => {
    // A previous process checkpointed all three; this one starts with slug A
    // unreadable, so it has never seen A under any slug.
    const disk = switchableFs();
    watcher(disk.fs, []).tick();
    expect(checkpointed()).toEqual([SESSION_A, SESSION_B, SESSION_C]);

    disk.set({ slugAReaddir: 'EMFILE', appendC: true });
    const seen: string[] = [];
    const w = watcher(disk.fs, seen);
    expect(w.tick().kind).toBe('ingested');
    expect(seen).toEqual([SESSION_C]);
    expect(checkpointed()).toEqual([SESSION_A, SESSION_B, SESSION_C]);

    disk.set({ appendC: true });
    seen.length = 0;
    expect(w.tick().kind).toBe('unchanged');
    expect(seen).toEqual([]);
  });

  it('still prunes a session that really left the disk, on the same pass', () => {
    const disk = switchableFs();
    const seen: string[] = [];
    const w = watcher(disk.fs, seen);
    w.tick();

    // B is deleted under the readable slug B while slug A is unreadable: A is
    // held, B is forgotten, C is read.
    disk.set({ slugAReaddir: 'EACCES', dropB: true, appendC: true });
    seen.length = 0;
    expect(w.tick().kind).toBe('ingested');
    expect(seen).toEqual([SESSION_C]);
    expect(checkpointed()).toEqual([SESSION_A, SESSION_C]);

    // B comes back with its old bytes: it is a new session again and is read.
    disk.set({ appendC: true });
    seen.length = 0;
    expect(w.tick().kind).toBe('ingested');
    expect(seen).toEqual([SESSION_B]);
  });
});
