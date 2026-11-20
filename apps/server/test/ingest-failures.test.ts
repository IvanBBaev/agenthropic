/**
 * ARC-5 persisted ingest-failure budget.
 *
 * Before ARC-5 the watcher's retry budget lived only in memory, so a restart
 * read "nothing is excluded" until the first pass had re-failed every broken
 * session, and a quarantined session was re-read MAX_INGEST_ATTEMPTS times
 * again before it was parked. With the failure store wired the budget is a
 * snapshot in `ingest_failures`, restored on the first pass against a root.
 *
 * Two halves, like the checkpoint suite: the store on its own (round trip,
 * replace semantics, scope isolation, degrade-never-crash), then the watcher
 * across a restart on an in-memory fake corpus. A restored session is read
 * once on boot - whatever made it fail may have been fixed while the process
 * was down - and its count carries on from where the previous process left it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PricingEntry, SessionSubstrate } from '@agenthropic/core';
import type { CorpusFs } from '../src/corpus/fs-port';
import type { IngestFn } from '../src/corpus/ingest-corpus';
import {
  createIngestFailureStore,
  type IngestFailureStore,
  type PersistedIngestFailure,
} from '../src/db/ingest-failures';
import { createReplayCheckpointStore } from '../src/db/replay-checkpoints';
import { upsertSession } from '../src/db/sessions';
import {
  MAX_INGEST_ATTEMPTS,
  createCorpusWatcher,
  type CorpusWatcherDeps,
} from '../src/ingest/corpus-watcher';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';
import { createMigratedTempDb, type TempDb } from './helpers';
import { HUGE_WATCHDOG_MS } from './p0/harness';

const ROOT = '/fake/corpus';
const OTHER_ROOT = '/fake/other-corpus';
const SLUG = '-Users-synthetic-failures-project';
const SESSION_A = 'aaaaaaaa-5555-4555-8555-555555555555';
const SESSION_B = 'bbbbbbbb-6666-4666-8666-666666666666';
const MAIN = '{"main":true}\n';
const REASON = 'refusing to price at $0: unknown model id "claude-future-1"';
const RECORDED_AT = '2026-11-20T00:00:00.000Z';
const ROW: PricingEntry = {
  model: 'claude-future-1',
  bucket: 'input',
  usdPerMtok: 3,
  effectiveFrom: '2026-01-01T00:00:00Z',
};

type MutableTree = Record<string, NodeSpec>;
type FsMode = 'ok' | 'gone' | 'unreadable';

function failure(attempts: number, reason = REASON): PersistedIngestFailure {
  return { attempts, reason };
}

function twoSessions(): MutableTree {
  return {
    [`${SESSION_A}.jsonl`]: file(MAIN, { size: 10, mtimeMs: 1 }),
    [`${SESSION_B}.jsonl`]: file(MAIN, { size: 20, mtimeMs: 2 }),
  };
}

/**
 * A fake corpus whose root can vanish (`realpath` ENOENT) or become
 * unreadable (root `readdir` EACCES) between passes of one watcher.
 */
function switchableFs(tree: MutableTree): { fs: CorpusFs; set(mode: FsMode): void } {
  let mode: FsMode = 'ok';
  const current = (): CorpusFs =>
    makeFakeCorpusFs(
      ROOT,
      { [SLUG]: dir(tree) },
      mode === 'gone'
        ? { realpathThrow: 'ENOENT' }
        : mode === 'unreadable'
          ? { rootReaddirCode: 'EACCES' }
          : {},
    );
  const fs: CorpusFs = {
    readDirNames: (abs) => current().readDirNames(abs),
    lstat: (abs) => current().lstat(abs),
    realpath: (abs) => current().realpath(abs),
    readFileConfined: (abs, maxBytes) => current().readFileConfined(abs, maxBytes),
    readFileTailConfined: (abs, fromByte, maxBytes) =>
      current().readFileTailConfined(abs, fromByte, maxBytes),
  };
  return {
    fs,
    set(next) {
      mode = next;
    },
  };
}

/**
 * An ingest stub that writes a session row on success and fails every session
 * in `failing` (read on each call, so a test can fix a session between passes).
 */
function projectingIngest(temp: TempDb, calls: string[], failing: Set<string>): IngestFn {
  return (substrate: SessionSubstrate): IngestOutcome => {
    const rel = substrate.files[0]?.relativePath ?? '<no main>';
    const sessionId = rel.endsWith('.jsonl') ? rel.slice(0, -'.jsonl'.length) : rel;
    calls.push(sessionId);
    const ok = !failing.has(sessionId);
    if (ok) {
      upsertSession(temp.db, {
        id: sessionId,
        projectSlug: SLUG,
        startedAt: '2026-11-19T00:00:00Z',
        lastActivityAt: '2026-11-19T00:00:00Z',
        status: 'working',
      });
    }
    return {
      ok,
      sessionId,
      costUsd: ok ? 0 : null,
      unpricedTokens: ok ? 0 : null,
      agentsUpserted: 0,
      edgesInserted: 0,
      usageRowsInserted: 0,
      statusReconciliations: [],
      crossSessionUsageCollisions: 0,
      error: ok ? null : REASON,
    };
  };
}

describe('ARC-5 ingest failure store', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('round-trips the budget of one scope', () => {
    const store = createIngestFailureStore(temp.db, { now: () => RECORDED_AT });
    expect(
      store.save(
        ROOT,
        new Map([
          [SESSION_B, failure(MAX_INGEST_ATTEMPTS)],
          [SESSION_A, failure(1, 'other reason')],
        ]),
      ),
    ).toBe(true);

    expect([...store.load(ROOT)]).toEqual([
      [SESSION_A, failure(1, 'other reason')],
      [SESSION_B, failure(MAX_INGEST_ATTEMPTS)],
    ]);
    const stamps = temp.db
      .prepare('SELECT DISTINCT recorded_at AS recordedAt FROM ingest_failures')
      .all() as { recordedAt: string }[];
    expect(stamps).toEqual([{ recordedAt: RECORDED_AT }]);
  });

  it('replaces the scope on every save, so a recovered session leaves the table', () => {
    const store = createIngestFailureStore(temp.db);
    store.save(
      ROOT,
      new Map([
        [SESSION_A, failure(1)],
        [SESSION_B, failure(2)],
      ]),
    );
    store.save(ROOT, new Map([[SESSION_B, failure(3)]]));
    expect([...store.load(ROOT)]).toEqual([[SESSION_B, failure(3)]]);

    store.save(ROOT, new Map());
    expect(store.load(ROOT).size).toBe(0);
  });

  it('keeps scopes apart and stores no corpus path', () => {
    const store = createIngestFailureStore(temp.db);
    store.save(ROOT, new Map([[SESSION_A, failure(1)]]));
    store.save(OTHER_ROOT, new Map([[SESSION_B, failure(2)]]));

    expect([...store.load(ROOT)]).toEqual([[SESSION_A, failure(1)]]);
    expect([...store.load(OTHER_ROOT)]).toEqual([[SESSION_B, failure(2)]]);
    // Replacing one scope leaves the other alone.
    store.save(ROOT, new Map());
    expect([...store.load(OTHER_ROOT)]).toEqual([[SESSION_B, failure(2)]]);

    const scopes = temp.db.prepare('SELECT scope FROM ingest_failures').all() as {
      scope: string;
    }[];
    for (const { scope } of scopes) {
      expect(scope).not.toContain('/fake');
    }
  });

  it('stamps rows with wall time by default', () => {
    const store = createIngestFailureStore(temp.db);
    store.save(ROOT, new Map([[SESSION_A, failure(1)]]));
    const row = temp.db.prepare('SELECT recorded_at AS recordedAt FROM ingest_failures').get() as {
      recordedAt: string;
    };
    expect(Number.isNaN(Date.parse(row.recordedAt))).toBe(false);
  });

  it('degrades instead of throwing when the table is gone', () => {
    const store = createIngestFailureStore(temp.db);
    temp.db.exec('DROP TABLE ingest_failures');
    expect(store.load(ROOT).size).toBe(0);
    expect(store.save(ROOT, new Map([[SESSION_A, failure(1)]]))).toBe(false);
  });

  it('rejects a zero attempt count at the schema, so save reports false', () => {
    const store = createIngestFailureStore(temp.db);
    store.save(ROOT, new Map([[SESSION_A, failure(1)]]));
    expect(store.save(ROOT, new Map([[SESSION_B, failure(0)]]))).toBe(false);
    // One transaction: the failed replace left the previous snapshot intact.
    expect([...store.load(ROOT)]).toEqual([[SESSION_A, failure(1)]]);
  });
});

describe('ARC-5 corpus watcher with the failure store wired', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function makeDeps(
    tree: MutableTree,
    overrides: Partial<CorpusWatcherDeps> = {},
  ): CorpusWatcherDeps {
    return {
      db: temp.db,
      pricing: [],
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      intervalMs: 1000,
      watchdogThresholdMs: HUGE_WATCHDOG_MS,
      fs: makeFakeCorpusFs(ROOT, { [SLUG]: dir(tree) }),
      nowMs: () => Date.parse('2026-11-20T00:00:00Z'),
      checkpoints: createReplayCheckpointStore(temp.db),
      failures: createIngestFailureStore(temp.db),
      ...overrides,
    };
  }

  function stored(): Array<[string, PersistedIngestFailure]> {
    return [...createIngestFailureStore(temp.db).load(ROOT)];
  }

  it('a quarantine survives a restart, and the restored session is read once', () => {
    const tree = twoSessions();
    const failing = new Set([SESSION_A]);
    const first = createCorpusWatcher(
      makeDeps(tree, { ingest: projectingIngest(temp, [], failing) }),
    );
    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
      first.tick();
    }
    expect(first.exclusions()).toEqual({ failing: 1, quarantined: 1, stale: 0 });
    expect(stored()).toEqual([[SESSION_A, failure(MAX_INGEST_ATTEMPTS)]]);

    const calls: string[] = [];
    const second = createCorpusWatcher(
      makeDeps(tree, { ingest: projectingIngest(temp, calls, failing) }),
    );
    second.tick();
    // B is checkpointed and skipped; A is read exactly once, fails again and
    // stays quarantined - not MAX_INGEST_ATTEMPTS fresh retries.
    expect(calls).toEqual([SESSION_A]);
    expect(second.exclusions()).toEqual({ failing: 1, quarantined: 1, stale: 0 });
    expect(second.rejectionOf(SESSION_A)).toEqual({ code: 'quarantined', reason: REASON });
    expect(stored()).toEqual([[SESSION_A, failure(MAX_INGEST_ATTEMPTS + 1)]]);

    // Parked again by committing: the unchanged bytes are not re-read.
    expect(second.tick()).toEqual({ kind: 'unchanged' });
    expect(calls).toEqual([SESSION_A]);
  });

  it('a restored session that now succeeds leaves the budget and the table', () => {
    const tree = twoSessions();
    const failing = new Set([SESSION_A]);
    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
      createCorpusWatcher(makeDeps(tree, { ingest: projectingIngest(temp, [], failing) })).tick();
    }
    // Every pass above was a fresh process: the count still reached quarantine.
    expect(stored()).toEqual([[SESSION_A, failure(MAX_INGEST_ATTEMPTS)]]);

    failing.clear();
    const calls: string[] = [];
    const watcher = createCorpusWatcher(
      makeDeps(tree, { ingest: projectingIngest(temp, calls, failing) }),
    );
    watcher.tick();
    expect(calls).toEqual([SESSION_A]);
    expect(watcher.exclusions()).toEqual({ failing: 0, quarantined: 0, stale: 0 });
    expect(watcher.rejectionOf(SESSION_A)).toBeUndefined();
    expect(stored()).toEqual([]);
  });

  it('restores the budget without a checkpoint store, and counts on from it', () => {
    const tree = twoSessions();
    const failing = new Set([SESSION_A]);
    createCorpusWatcher(
      makeDeps(tree, { checkpoints: undefined, ingest: projectingIngest(temp, [], failing) }),
    ).tick();
    expect(stored()).toEqual([[SESSION_A, failure(1)]]);

    const calls: string[] = [];
    const watcher = createCorpusWatcher(
      makeDeps(tree, { checkpoints: undefined, ingest: projectingIngest(temp, calls, failing) }),
    );
    // Before the first pass nothing is hydrated yet.
    expect(watcher.exclusions()).toEqual({ failing: 0, quarantined: 0, stale: 0 });
    watcher.tick();
    // No checkpoints: both sessions are re-read, but A's count carries on.
    expect(calls.sort()).toEqual([SESSION_A, SESSION_B]);
    expect(stored()).toEqual([[SESSION_A, failure(2)]]);
    expect(watcher.rejectionOf(SESSION_A)).toEqual({ code: 'ingest-failing', reason: REASON });
  });

  it('counts a failing session with a row from an earlier pass as stale, not absent', () => {
    const tree = twoSessions();
    const failing = new Set<string>();
    const watcher = createCorpusWatcher(
      makeDeps(tree, { ingest: projectingIngest(temp, [], failing) }),
    );
    watcher.tick(); // both project and get rows

    tree[`${SESSION_A}.jsonl`] = file(MAIN + MAIN, { size: 30, mtimeMs: 9 });
    failing.add(SESSION_A);
    watcher.tick();
    expect(watcher.exclusions()).toEqual({ failing: 1, quarantined: 0, stale: 1 });

    // A broken database reads as "none known stale", never as a throw.
    temp.db.close();
    expect(watcher.exclusions()).toEqual({ failing: 1, quarantined: 0, stale: 0 });
  });

  it('retries a failed save on the next pass, and writes nothing while the budget holds', () => {
    const inner = createIngestFailureStore(temp.db);
    const results = [true, true, false];
    const saves: Array<Map<string, PersistedIngestFailure>> = [];
    const store: IngestFailureStore = {
      load: (root) => inner.load(root),
      save: (root, failures) => {
        saves.push(new Map(failures));
        const ok = results.shift() ?? true;
        return ok && inner.save(root, failures);
      },
    };
    const tree = twoSessions();
    const watcher = createCorpusWatcher(
      makeDeps(tree, { failures: store, ingest: projectingIngest(temp, [], new Set([SESSION_A])) }),
    );
    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
      watcher.tick();
    }
    expect(saves).toHaveLength(MAX_INGEST_ATTEMPTS);
    expect(stored()).toEqual([[SESSION_A, failure(MAX_INGEST_ATTEMPTS - 1)]]);

    // Quarantined and unchanged: the snapshot was never accepted, so this
    // pass writes it again ...
    expect(watcher.tick()).toEqual({ kind: 'unchanged' });
    expect(saves).toHaveLength(MAX_INGEST_ATTEMPTS + 1);
    expect(stored()).toEqual([[SESSION_A, failure(MAX_INGEST_ATTEMPTS)]]);

    // ... and once it is accepted, an unchanged pass writes nothing.
    expect(watcher.tick()).toEqual({ kind: 'unchanged' });
    expect(saves).toHaveLength(MAX_INGEST_ATTEMPTS + 1);
  });

  it('a vanished corpus root clears the persisted budget too', () => {
    const tree = twoSessions();
    const switchable = switchableFs(tree);
    const watcher = createCorpusWatcher(
      makeDeps(tree, {
        fs: switchable.fs,
        ingest: projectingIngest(temp, [], new Set([SESSION_A])),
      }),
    );
    watcher.tick();
    expect(stored()).toEqual([[SESSION_A, failure(1)]]);

    switchable.set('gone');
    expect(watcher.tick()).toEqual({ kind: 'no-corpus-root' });
    expect(stored()).toEqual([]);
    // Still gone: nothing hydrated, nothing to write.
    expect(watcher.tick()).toEqual({ kind: 'no-corpus-root' });
    expect(watcher.exclusions()).toEqual({ failing: 0, quarantined: 0, stale: 0 });
  });

  it('a pricing change re-admits parked sessions in the table even when the root is unreadable', () => {
    const tree = twoSessions();
    const switchable = switchableFs(tree);
    let pricing: readonly PricingEntry[] = [];
    const watcher = createCorpusWatcher(
      makeDeps(tree, {
        fs: switchable.fs,
        pricing: () => pricing,
        ingest: projectingIngest(temp, [], new Set([SESSION_A])),
      }),
    );
    watcher.tick();
    expect(stored()).toEqual([[SESSION_A, failure(1)]]);

    pricing = [ROW];
    switchable.set('unreadable');
    expect(watcher.tick()).toMatchObject({ kind: 'read-error' });
    expect(watcher.exclusions()).toEqual({ failing: 0, quarantined: 0, stale: 0 });
    expect(stored()).toEqual([]);
  });

  it('restores only the budget of its own corpus scope', () => {
    createIngestFailureStore(temp.db).save(OTHER_ROOT, new Map([[SESSION_B, failure(2)]]));
    const tree = twoSessions();
    const watcher = createCorpusWatcher(
      makeDeps(tree, { ingest: projectingIngest(temp, [], new Set([SESSION_A])) }),
    );
    watcher.tick();
    expect(watcher.exclusions()).toEqual({ failing: 1, quarantined: 0, stale: 0 });
    expect(watcher.rejectionOf(SESSION_B)).toBeUndefined();
  });
});
