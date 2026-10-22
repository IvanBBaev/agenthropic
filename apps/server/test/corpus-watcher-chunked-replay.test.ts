/**
 * Chunked passes (`tick({ maxSessions })`) and the per-session rejection
 * accessor (`rejectionOf`).
 *
 * The startup replay used to be ONE synchronous pass: over a large corpus the
 * event loop was held for the whole read, so /api/health could not even answer
 * 'replaying'. The replay now runs as capped passes with an event-loop turn
 * between them. The passes that drain one capped working set - a SWEEP - must
 * count as ONE pass for the retry budget and the backoff clock, or chunking
 * would change which sessions get quarantined rather than only when the event
 * loop breathes. These tests pin that equivalence.
 */
import { peekSubstrateSessionId, type SessionSubstrate } from '@agenthropic/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorpusFs } from '../src/corpus/fs-port';
import {
  createCorpusWatcher,
  MAX_INGEST_ATTEMPTS,
  REPLAY_MAX_SESSIONS_PER_PASS,
  type IngestFailureReport,
  type TickOutcome,
} from '../src/ingest/corpus-watcher';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';
import { createMigratedTempDb, type TempDb } from './helpers';
import { HUGE_WATCHDOG_MS } from './p0/harness';

const ROOT = '/fake/corpus';
const OTHER_ROOT = '/fake/other-corpus';
const SLUG = '-Users-synthetic-chunked-project';
const REASON = 'refusing to price at $0: unknown model id "claude-future-1"';

function sessionId(n: number): string {
  return `cccccccc-5555-4555-8555-${String(n).padStart(12, '0')}`;
}

function ingestedIds(outcome: TickOutcome): number {
  return outcome.kind === 'ingested' ? outcome.summary.sessionsDiscovered : -1;
}

describe('corpus watcher: chunked passes and rejectionOf', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  /**
   * One watcher over `count` sessions in one project directory. `reads` lists
   * the session ids ingest was run for, in order; `failing` holds the ids whose
   * ingest fails. `touch(id)` grows a transcript, as Claude Code does.
   */
  function harness(count: number, options: { checkpoints?: boolean } = {}) {
    const sizes = new Map<string, number>();
    const tree: Record<string, NodeSpec> = {};
    const place = (id: string): void => {
      const size = sizes.get(id) ?? 10;
      tree[`${id}.jsonl`] = file(`{"sessionId":"${id}"}\n`, { size, mtimeMs: size });
    };
    for (let n = 0; n < count; n += 1) {
      place(sessionId(n));
    }
    const roots = new Map<string, CorpusFs>([
      [ROOT, makeFakeCorpusFs(ROOT, { [SLUG]: dir(tree) })],
      [OTHER_ROOT, makeFakeCorpusFs(OTHER_ROOT, { [SLUG]: dir(tree) })],
    ]);
    let rootFault: 'ENOENT' | 'EACCES' | null = null;
    // Armed by `failRealpathOnCall`: the Nth realpath call from now throws
    // EACCES once; the calls before and after it resolve normally.
    let realpathFault: { readonly call: number; seen: number } | null = null;
    const env: Record<string, string | undefined> = { CLAUDE_PROJECTS_DIR: ROOT };
    const current = (): CorpusFs => roots.get(env['CLAUDE_PROJECTS_DIR'] ?? ROOT) as CorpusFs;
    const fs = new Proxy({} as CorpusFs, {
      get(_target, key: keyof CorpusFs) {
        if (key === 'realpath' && rootFault !== null) {
          const code = rootFault;
          return () => {
            throw Object.assign(new Error('realpath failed'), { code });
          };
        }
        if (key === 'realpath' && realpathFault !== null) {
          return (absPath: string): string => {
            const fault = realpathFault as { readonly call: number; seen: number };
            fault.seen += 1;
            if (fault.seen === fault.call) {
              realpathFault = null;
              throw Object.assign(new Error('realpath failed'), { code: 'EACCES' });
            }
            return current().realpath(absPath);
          };
        }
        const delegate = current();
        const value = delegate[key];
        return typeof value === 'function' ? value.bind(delegate) : value;
      },
    });
    const failing = new Set<string>();
    const reads: string[] = [];
    const failures: IngestFailureReport[] = [];
    const watcher = createCorpusWatcher({
      db: temp.db,
      pricing: [],
      env,
      intervalMs: 1000,
      watchdogThresholdMs: HUGE_WATCHDOG_MS,
      fs,
      nowMs: () => Date.parse('2026-07-12T00:00:00Z'),
      checkpoints:
        options.checkpoints === true ? { load: () => new Map(), commit: () => {} } : undefined,
      ingest: (substrate: SessionSubstrate): IngestOutcome => {
        const id = peekSubstrateSessionId(substrate) as string;
        reads.push(id);
        const fails = failing.has(id);
        return {
          ok: !fails,
          sessionId: fails ? null : id,
          costUsd: fails ? null : 0,
          agentsUpserted: 0,
          edgesInserted: 0,
          usageRowsInserted: 0,
          statusReconciliations: [],
          crossSessionUsageCollisions: 0,
          error: fails ? `${REASON} in /Users/someone/.claude/projects/x.jsonl\nmore` : null,
        };
      },
      onIngestFailure: (report) => failures.push(report),
    });
    return {
      watcher,
      reads,
      failures,
      failing,
      env,
      touch(id: string): void {
        sizes.set(id, (sizes.get(id) ?? 10) + 1);
        place(id);
      },
      remove(id: string): void {
        delete tree[`${id}.jsonl`];
      },
      setRootGone(gone: boolean): void {
        rootFault = gone ? 'ENOENT' : null;
      },
      /** The root is there but cannot be resolved: a pass ends in 'read-error'. */
      setRootUnreadable(unreadable: boolean): void {
        rootFault = unreadable ? 'EACCES' : null;
      },
      /**
       * Fail the Nth realpath call from now, once. A pass resolves the root
       * TWICE - the watcher for its own enumeration, then the runner before it
       * reads - so `2` is a throw in the middle of a pass, after the cap has
       * admitted its chunk and before any of it is read.
       */
      failRealpathOnCall(call: number): void {
        realpathFault = { call, seen: 0 };
      },
    };
  }

  it('defaults to a positive per-pass cap', () => {
    expect(Number.isInteger(REPLAY_MAX_SESSIONS_PER_PASS)).toBe(true);
    expect(REPLAY_MAX_SESSIONS_PER_PASS).toBeGreaterThan(0);
  });

  it('an uncapped tick admits every changed session and reports nothing pending', () => {
    const corpus = harness(5);
    const outcome = corpus.watcher.tick();

    expect(outcome).toMatchObject({ kind: 'ingested', pending: false });
    expect(ingestedIds(outcome)).toBe(5);
  });

  it('a capped sweep reads every session exactly once, in chunks, then settles', () => {
    const corpus = harness(5);
    const outcomes = [
      corpus.watcher.tick({ maxSessions: 2 }),
      corpus.watcher.tick({ maxSessions: 2 }),
      corpus.watcher.tick({ maxSessions: 2 }),
    ];

    expect(outcomes.map((o) => (o.kind === 'ingested' ? o.pending : null))).toEqual([
      true,
      true,
      false,
    ]);
    expect(outcomes.map(ingestedIds)).toEqual([2, 2, 1]);
    expect(corpus.reads).toEqual([0, 1, 2, 3, 4].map(sessionId));
    expect(corpus.watcher.tick({ maxSessions: 2 })).toEqual({ kind: 'unchanged' });
  });

  it('a cap at or above the changed count is a plain pass', () => {
    const corpus = harness(3);
    expect(corpus.watcher.tick({ maxSessions: 3 })).toMatchObject({ pending: false });
    expect(corpus.reads).toHaveLength(3);
  });

  it('an uncapped tick that continues a pending sweep stays capped', () => {
    // The scheduled poll passes no cap. When a replay is cut short it inherits
    // the remainder, and admitting all of it at once would be the single
    // synchronous pass the chunking exists to avoid.
    const corpus = harness(4);
    expect(corpus.watcher.tick({ maxSessions: 1 })).toMatchObject({ pending: true });

    expect(corpus.watcher.tick()).toMatchObject({ kind: 'ingested', pending: true });
    expect(corpus.reads).toEqual([0, 1].map(sessionId));
    expect(corpus.watcher.tick()).toMatchObject({ kind: 'ingested', pending: true });
    expect(corpus.watcher.tick()).toMatchObject({ kind: 'ingested', pending: false });
    expect(corpus.reads).toEqual([0, 1, 2, 3].map(sessionId));

    // The cap ends with the sweep: the next uncapped pass is a plain one.
    for (const n of [0, 1, 2, 3]) {
      corpus.touch(sessionId(n));
    }
    const plain = corpus.watcher.tick();
    expect(plain).toMatchObject({ kind: 'ingested', pending: false });
    expect(ingestedIds(plain)).toBe(4);
  });

  it('an explicit cap wins over the one a sweep carries', () => {
    const corpus = harness(4);
    expect(corpus.watcher.tick({ maxSessions: 1 })).toMatchObject({ pending: true });
    expect(corpus.watcher.tick({ maxSessions: 2 })).toMatchObject({ pending: true });
    expect(corpus.reads).toEqual([0, 1, 2].map(sessionId));
  });

  it.each([
    ['without a checkpoint store', false],
    // Production wiring. The retry is then also the first pass to hydrate the
    // store, and adopting a root for the first time abandons no sweep.
    ['with a checkpoint store', true],
  ])(
    'a capped pass that could not read the corpus keeps its cap for the retry (%s)',
    (_, store) => {
      // The replay's first pass fails before any sweep exists. The retry comes
      // from the scheduled poll, uncapped, and must not become the whole replay
      // in one pass.
      const corpus = harness(3, { checkpoints: store });
      corpus.setRootUnreadable(true);
      expect(corpus.watcher.tick({ maxSessions: 1 })).toMatchObject({ kind: 'read-error' });
      corpus.setRootUnreadable(false);

      expect(corpus.watcher.tick()).toMatchObject({ kind: 'ingested', pending: true });
      expect(corpus.reads).toEqual([sessionId(0)]);
    },
  );

  it('a read error in the middle of a sweep keeps the sweep and its cap', () => {
    const corpus = harness(3);
    expect(corpus.watcher.tick({ maxSessions: 1 })).toMatchObject({ pending: true });
    corpus.setRootUnreadable(true);
    expect(corpus.watcher.tick()).toMatchObject({ kind: 'read-error' });
    corpus.setRootUnreadable(false);

    expect(corpus.watcher.tick()).toMatchObject({ kind: 'ingested', pending: true });
    expect(corpus.watcher.tick()).toMatchObject({ kind: 'ingested', pending: false });
    // Nothing the sweep read before the fault is read again after it.
    expect(corpus.reads).toEqual([0, 1, 2].map(sessionId));
  });

  it('a session that fails early in a sweep is not retried by the same sweep', () => {
    // Uncapped, a failing session is read once per pass. Chunked, it must
    // still be read once per SWEEP - not once per chunk, which would burn its
    // budget (and quarantine it) inside a single replay.
    const corpus = harness(3);
    corpus.failing.add(sessionId(0));
    corpus.watcher.tick({ maxSessions: 1 });
    corpus.watcher.tick({ maxSessions: 1 });
    const last = corpus.watcher.tick({ maxSessions: 1 });

    expect(last).toMatchObject({ kind: 'ingested', pending: false });
    expect(corpus.reads).toEqual([0, 1, 2].map(sessionId));
    expect(corpus.failures.map((f) => f.attempt)).toEqual([1]);
    expect(corpus.watcher.rejectionOf(sessionId(0))?.code).toBe('ingest-failing');

    // The next sweep retries it, as the next uncapped pass would.
    expect(corpus.watcher.tick({ maxSessions: 1 })).toMatchObject({ pending: false });
    expect(corpus.failures.map((f) => f.attempt)).toEqual([1, 2]);
  });

  it('a sweep advances the backoff clock once, however many chunks it takes', () => {
    const corpus = harness(1);
    const parked = sessionId(0);
    corpus.failing.add(parked);
    // Burn the budget (passes 1-3), then the first re-read (pass 4) fails too:
    // the gap doubles to 2, so the next re-read is due on pass 6.
    for (let pass = 1; pass <= MAX_INGEST_ATTEMPTS + 1; pass += 1) {
      corpus.touch(parked);
      corpus.watcher.tick();
    }
    expect(corpus.reads).toHaveLength(MAX_INGEST_ATTEMPTS + 1);
    expect(corpus.watcher.rejectionOf(parked)?.code).toBe('quarantined');

    // Pass 5 is one sweep of three chunks over three new sessions. Were each
    // chunk its own pass, the clock would reach 6 inside the sweep and the
    // parked session would be re-read early.
    corpus.touch(parked);
    for (const n of [1, 2, 3]) {
      corpus.touch(sessionId(n));
    }
    let outcome: TickOutcome;
    do {
      outcome = corpus.watcher.tick({ maxSessions: 1 });
    } while (outcome.kind === 'ingested' && outcome.pending);
    expect(corpus.reads.slice(MAX_INGEST_ATTEMPTS + 1)).toEqual([1, 2, 3].map(sessionId));

    // Pass 6: now it is due.
    corpus.watcher.tick();
    expect(corpus.reads.at(-1)).toBe(parked);
  });

  it('a vanished corpus root ends the sweep in progress', () => {
    const corpus = harness(3);
    expect(corpus.watcher.tick({ maxSessions: 1 })).toMatchObject({ pending: true });
    corpus.setRootGone(true);
    expect(corpus.watcher.tick({ maxSessions: 1 })).toEqual({ kind: 'no-corpus-root' });
    corpus.setRootGone(false);

    // A fresh replay from scratch: the session the abandoned sweep read is
    // read again, not skipped as "already read in this sweep".
    corpus.watcher.tick();
    expect(corpus.reads).toEqual([0, 0, 1, 2].map(sessionId));
  });

  it('a pass that throws after admitting its chunk does not count the chunk as read', () => {
    const corpus = harness(4);
    corpus.failRealpathOnCall(2);
    expect(corpus.watcher.tick({ maxSessions: 2 })).toMatchObject({ kind: 'read-error' });
    expect(corpus.reads).toEqual([]);

    // The retry admits the SAME chunk: nothing of it was read. Before
    // 2026-10-08 the sweep was recorded before the runner ran, so the retry
    // skipped the unread chunk as "done in this sweep", reported the sweep
    // drained with two sessions still unread, and only a later plain pass
    // (their fingerprints never settled) read them - after health said 'ok'.
    expect(corpus.watcher.tick()).toMatchObject({ kind: 'ingested', pending: true });
    expect(corpus.reads).toEqual([0, 1].map(sessionId));
    expect(corpus.watcher.tick()).toMatchObject({ kind: 'ingested', pending: false });
    expect(corpus.reads).toEqual([0, 1, 2, 3].map(sessionId));
  });

  it('adopting a different root ends the sweep in progress', () => {
    const corpus = harness(3, { checkpoints: true });
    expect(corpus.watcher.tick({ maxSessions: 1 })).toMatchObject({ pending: true });
    corpus.env['CLAUDE_PROJECTS_DIR'] = OTHER_ROOT;

    corpus.watcher.tick();
    expect(corpus.reads).toEqual([0, 0, 1, 2].map(sessionId));
  });

  describe('rejectionOf', () => {
    it('is undefined for a session ingest holds nothing against', () => {
      const corpus = harness(1);
      expect(corpus.watcher.rejectionOf(sessionId(0))).toBeUndefined();
      corpus.watcher.tick();
      expect(corpus.watcher.rejectionOf(sessionId(0))).toBeUndefined();
      expect(corpus.watcher.rejectionOf('not-a-session')).toBeUndefined();
    });

    it('says ingest-failing while the budget lasts, quarantined once it is spent', () => {
      const corpus = harness(1);
      const id = sessionId(0);
      corpus.failing.add(id);
      for (let pass = 1; pass < MAX_INGEST_ATTEMPTS; pass += 1) {
        corpus.watcher.tick();
        expect(corpus.watcher.rejectionOf(id)?.code).toBe('ingest-failing');
      }
      corpus.watcher.tick();
      expect(corpus.watcher.rejectionOf(id)?.code).toBe('quarantined');
      expect(corpus.watcher.exclusions()).toEqual({ failing: 1, quarantined: 1 });
    });

    it('carries the sanitized reason: no path, one line', () => {
      const corpus = harness(1);
      corpus.failing.add(sessionId(0));
      corpus.watcher.tick();

      expect(corpus.watcher.rejectionOf(sessionId(0))).toEqual({
        code: 'ingest-failing',
        reason: `${REASON} in <path> more`,
      });
    });

    it('clears the moment the session ingests', () => {
      const corpus = harness(1);
      const id = sessionId(0);
      corpus.failing.add(id);
      corpus.watcher.tick();
      corpus.failing.delete(id);
      corpus.watcher.tick();

      expect(corpus.watcher.rejectionOf(id)).toBeUndefined();
    });

    it('clears when the session leaves the disk', () => {
      const corpus = harness(2);
      const id = sessionId(0);
      corpus.failing.add(id);
      corpus.watcher.tick();
      corpus.remove(id);
      corpus.watcher.tick();

      expect(corpus.watcher.rejectionOf(id)).toBeUndefined();
    });
  });
});
