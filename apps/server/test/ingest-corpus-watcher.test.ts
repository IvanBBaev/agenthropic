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
import { ContainmentError, type CorpusFs } from '../src/corpus/fs-port';
import type { IngestFn } from '../src/corpus/ingest-corpus';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import type { CorpusIngestSummary } from '../src/corpus/ingest-corpus';
import {
  MAX_INGEST_ATTEMPTS,
  createCorpusWatcher,
  sanitizeFailureReason,
  tickSummary,
  type CorpusWatcherDeps,
  type IngestFailureReport,
  type TickOutcome,
} from '../src/ingest/corpus-watcher';
import type { IngestEvent } from '../src/ingest/ingest-events';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-watched-project';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SESSION_C = 'cccccccc-3333-4333-8333-333333333333';
const MAIN = '{"main":true}\n';
/** A realistic halt-gate refusal: no path, no payload - must survive verbatim. */
const REASON_SAMPLE = 'refusing to price at $0: unknown model id "claude-future-1"';

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

/**
 * Unwrap a pass that must have ingested. Every assertion below names the
 * outcome it expects rather than testing for "not null": the whole point of
 * {@link TickOutcome} is that 'unchanged', 'no-corpus-root' and 'read-error'
 * are different facts, so a test that accepts any of them tests nothing.
 */
function ingested(pass: TickOutcome): CorpusIngestSummary {
  if (pass.kind !== 'ingested') {
    throw new Error(`expected an ingesting pass, got '${pass.kind}'`);
  }
  return pass.summary;
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

      const summary = ingested(watcher.tick());

      expect(calls.sort()).toEqual([`${SESSION_A}.jsonl`, `${SESSION_B}.jsonl`]);
      expect(summary.sessionsDiscovered).toBe(2);
      expect(summary.sessionsOk).toBe(2);
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

    it("an unchanged second tick ingests nothing and reports 'unchanged'", () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(makeDeps(slugTree, { ingest: recorder(calls) }));

      expect(watcher.tick().kind).toBe('ingested');
      // Not merely "no summary": a quiet corpus is a DIFFERENT fact from a
      // missing one, and the caller is entitled to tell them apart.
      expect(watcher.tick()).toEqual({ kind: 'unchanged' });
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
      const summary = ingested(watcher.tick());

      expect(calls).toEqual([`${SESSION_A}.jsonl`]);
      // sessionsDiscovered counts ADMITTED refs — the filter ran before the fold.
      expect(summary.sessionsDiscovered).toBe(1);
      expect(summary.sessionsOk).toBe(1);
    });

    it('picks up a brand-new session on a later tick', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(makeDeps(slugTree, { ingest: recorder(calls) }));
      watcher.tick();
      calls.length = 0;

      slugTree[`${SESSION_C}.jsonl`] = file(MAIN, { mtimeMs: 5 });
      const summary = ingested(watcher.tick());

      expect(calls).toEqual([`${SESSION_C}.jsonl`]);
      expect(summary.sessionsOk).toBe(1);
    });

    it("a vanished corpus root reports 'no-corpus-root' and a reappearing one replays from scratch", () => {
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
      // ENOENT root: a normal empty condition, and named as such - it must not
      // read the same as "the corpus is quiet".
      expect(watcher.tick()).toEqual({ kind: 'no-corpus-root' });
      expect(calls).toHaveLength(0);

      // Reappearance: the fingerprints were cleared, so EVERYTHING re-ingests
      // (idempotence makes over-ingesting safe; staleness would lose data).
      holder['projects'] = projects!;
      const summary = ingested(watcher.tick());
      expect(calls.sort()).toEqual([`${SESSION_A}.jsonl`, `${SESSION_B}.jsonl`]);
      expect(summary.sessionsOk).toBe(2);
    });
  });

  /**
   * WP-IN5 failure posture. A session that fails to ingest (the commonest real
   * cause: a model id absent from the pricing table, which the halt gate turns
   * into a refusal rather than a silent $0) must NOT have its fingerprint
   * advanced - otherwise it is retried only if the file changes again, and
   * never once the session ends, so the dashboard silently shows nothing.
   * Retries are bounded so a permanently unparseable file cannot spin.
   */
  describe('failed sessions are retried, reported and eventually quarantined', () => {
    const REASON = 'refusing to price at $0: unknown model id';

    /** Ingest stub that fails for the listed session ids and succeeds otherwise. */
    function failingFor(failing: readonly string[], calls: string[]): IngestFn {
      return (substrate: SessionSubstrate): IngestOutcome => {
        const relativePath = substrate.files[0]?.relativePath ?? '<no main>';
        calls.push(relativePath);
        return failing.some((id) => relativePath.startsWith(id))
          ? outcome({ ok: false, sessionId: null, costUsd: null, error: REASON })
          : outcome();
      };
    }

    it('re-ingests a failed session on the next tick although nothing changed', () => {
      const slugTree: MutableTree = {
        [`${SESSION_A}.jsonl`]: file(MAIN, { size: 10, mtimeMs: 1 }),
        [`${SESSION_B}.jsonl`]: file(MAIN, { size: 20, mtimeMs: 2 }),
      };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, { ingest: failingFor([SESSION_A], calls) }),
      );

      expect(ingested(watcher.tick()).sessionsFailed).toBe(1);
      calls.length = 0;

      // No file changed: the healthy session stays put, the failed one retries.
      const second = ingested(watcher.tick());
      expect(calls).toEqual([`${SESSION_A}.jsonl`]);
      expect(second.sessionsFailed).toBe(1);
    });

    it('reports every failure with session id, reason, attempt and willRetry', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const failures: IngestFailureReport[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: failingFor([SESSION_A], calls),
          onIngestFailure: (report) => failures.push(report),
        }),
      );

      watcher.tick();
      watcher.tick();

      expect(failures).toEqual([
        { sessionId: SESSION_A, reason: REASON, attempt: 1, willRetry: true },
        { sessionId: SESSION_A, reason: REASON, attempt: 2, willRetry: true },
      ]);
      // The report is liveness diagnostics only - never the substrate.
      expect(Object.keys(failures[0] as object).sort()).toEqual([
        'attempt',
        'reason',
        'sessionId',
        'willRetry',
      ]);
    });

    it('quarantines a permanently failing session after MAX_INGEST_ATTEMPTS', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const failures: IngestFailureReport[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: failingFor([SESSION_A], calls),
          onIngestFailure: (report) => failures.push(report),
        }),
      );

      for (let i = 0; i < MAX_INGEST_ATTEMPTS + 5; i += 1) {
        watcher.tick();
      }

      // Bounded: no hot retry loop against an unchanged, unparseable file.
      expect(calls).toHaveLength(MAX_INGEST_ATTEMPTS);
      expect(failures).toHaveLength(MAX_INGEST_ATTEMPTS);
      expect(failures.at(-1)).toEqual({
        sessionId: SESSION_A,
        reason: REASON,
        attempt: MAX_INGEST_ATTEMPTS,
        willRetry: false,
      });
    });

    it('re-admits a quarantined session once its file changes', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const failures: IngestFailureReport[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: failingFor([SESSION_A], calls),
          onIngestFailure: (report) => failures.push(report),
        }),
      );
      for (let i = 0; i < MAX_INGEST_ATTEMPTS + 1; i += 1) {
        watcher.tick();
      }
      calls.length = 0;
      failures.length = 0;

      // New content deserves a fresh budget: the attempt counter restarts.
      slugTree[`${SESSION_A}.jsonl`] = file(MAIN + MAIN, { size: 99, mtimeMs: 42 });
      watcher.tick();

      expect(calls).toEqual([`${SESSION_A}.jsonl`]);
      expect(failures).toEqual([
        { sessionId: SESSION_A, reason: REASON, attempt: 1, willRetry: true },
      ]);
    });

    it('advances the fingerprint once a retry finally succeeds', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      let failNext = true;
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: (substrate: SessionSubstrate): IngestOutcome => {
            calls.push(substrate.files[0]?.relativePath ?? '<no main>');
            const failed = failNext;
            failNext = false;
            return failed ? outcome({ ok: false, sessionId: null, error: REASON }) : outcome();
          },
        }),
      );

      expect(ingested(watcher.tick()).sessionsFailed).toBe(1);
      expect(ingested(watcher.tick()).sessionsOk).toBe(1); // the retry
      expect(watcher.tick()).toEqual({ kind: 'unchanged' }); // committed: quiet now
      expect(calls).toHaveLength(2);
    });

    it('forgets retry bookkeeping when the corpus root disappears', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const holder: MutableTree = { projects: dir({ [SLUG]: dir(slugTree) }) };
      const calls: string[] = [];
      const failures: IngestFailureReport[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          env: { CLAUDE_PROJECTS_DIR: join(ROOT, 'projects') },
          fs: makeFakeCorpusFs(ROOT, holder),
          ingest: failingFor([SESSION_A], calls),
          onIngestFailure: (report) => failures.push(report),
        }),
      );
      for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
        watcher.tick();
      }
      expect(watcher.tick()).toEqual({ kind: 'unchanged' }); // quarantined

      const projects = holder['projects'];
      delete holder['projects'];
      expect(watcher.tick()).toEqual({ kind: 'no-corpus-root' });
      holder['projects'] = projects!;
      failures.length = 0;

      // A reappearing corpus starts from scratch, quarantine included.
      watcher.tick();
      expect(failures).toEqual([
        { sessionId: SESSION_A, reason: REASON, attempt: 1, willRetry: true },
      ]);
    });

    it('drops retry bookkeeping for a session that vanishes from the corpus', () => {
      const slugTree: MutableTree = {
        [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }),
        [`${SESSION_B}.jsonl`]: file(MAIN, { mtimeMs: 2 }),
      };
      const calls: string[] = [];
      const failures: IngestFailureReport[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: failingFor([SESSION_A], calls),
          onIngestFailure: (report) => failures.push(report),
        }),
      );
      watcher.tick();
      watcher.tick();
      expect(failures.at(-1)?.attempt).toBe(2);

      delete slugTree[`${SESSION_A}.jsonl`];
      watcher.tick();
      failures.length = 0;

      // Same content, but a fresh identity to the watcher: attempts restart.
      slugTree[`${SESSION_A}.jsonl`] = file(MAIN, { mtimeMs: 1 });
      watcher.tick();
      expect(failures).toEqual([
        { sessionId: SESSION_A, reason: REASON, attempt: 1, willRetry: true },
      ]);
    });

    it('does not throw when no onIngestFailure handler is wired', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, { ingest: failingFor([SESSION_A], calls) }),
      );
      expect(() => watcher.tick()).not.toThrow();
      expect(ingested(watcher.tick()).sessionsFailed).toBe(1);
    });
  });

  describe('sanitizeFailureReason', () => {
    it('strips absolute paths so no user data reaches a log or an SSE frame', () => {
      const failures: IngestFailureReport[] = [];
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: (): IngestOutcome =>
            outcome({
              ok: false,
              sessionId: null,
              error: '/Users/real-person/.claude/projects/-Users-real-person/x.jsonl: bad line',
            }),
          onIngestFailure: (report) => failures.push(report),
        }),
      );
      watcher.tick();

      expect(failures[0]?.reason).toBe('<path>: bad line');
      expect(failures[0]?.reason).not.toContain('real-person');
    });

    it('collapses newlines so a reason can never forge a second log line', () => {
      expect(sanitizeFailureReason('bad line\nFATAL: fake')).toBe('bad line FATAL: fake');
      expect(sanitizeFailureReason('a\r\n\tb')).toBe('a b');
    });

    it('caps the length so a huge message cannot flood the log', () => {
      const reason = sanitizeFailureReason('x'.repeat(5_000));
      expect(reason.length).toBeLessThanOrEqual(300);
      expect(reason.endsWith('...')).toBe(true);
    });

    it('leaves an ordinary pricing refusal untouched', () => {
      expect(sanitizeFailureReason(REASON_SAMPLE)).toBe(REASON_SAMPLE);
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

      const summary = ingested(holder.watcher.tick());

      expect(summary.sessionsOk).toBe(2);
      expect(calls).toHaveLength(2); // the re-entrant calls ingested NOTHING
      // 'overlapped', not 'unchanged': the inner call never looked at the
      // corpus at all, and saying "nothing changed" would be a claim about
      // disk state that this pass has no standing to make.
      expect(innerResults).toEqual([{ kind: 'overlapped' }, { kind: 'overlapped' }]);
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

      expect(watcher.tick()).toEqual({ kind: 'containment-halt' });
      expect(fatal).toHaveBeenCalledTimes(1);
      expect(fatal.mock.calls[0]?.[0]).toBeInstanceOf(ContainmentError);
      expect(calls).toHaveLength(0);

      // Even a now-healed corpus never revives a containment-stopped watcher,
      // and the watchdog no longer runs either: the stale agent stays put. The
      // second pass says 'stopped', not 'containment-halt' - the halt already
      // happened, and repeating it would double-count one fatal event.
      delete tree['..'];
      expect(watcher.tick()).toEqual({ kind: 'stopped' });
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
      expect(watcher.tick()).toEqual({ kind: 'stopped' });
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

      // The reason travels with the outcome, already sanitized: the fake's
      // `realpath failed: /fake/corpus` loses its path before it can leak.
      expect(watcher.tick()).toEqual({ kind: 'read-error', reason: 'realpath failed: <path>' });
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
      // The error was transient: the NEXT tick tries again (and sweeps to
      // silence). It still fails, and still says so - a retryable read error is
      // never quietly downgraded to "nothing changed".
      expect(watcher.tick()).toEqual({ kind: 'read-error', reason: 'realpath failed: <path>' });
      expect(events).toHaveLength(1);
    });

    it('reports an unreadable root with its errno and prunes NOTHING', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const base = makeFakeCorpusFs(ROOT, { [SLUG]: dir(slugTree) });
      let failRoot = false;
      const fs: CorpusFs = {
        ...base,
        readDirNames(absDir: string): string[] {
          if (failRoot && absDir === ROOT) {
            throw Object.assign(new Error(`readdir root: ${absDir}`), { code: 'EACCES' });
          }
          return base.readDirNames(absDir);
        },
      };
      const calls: string[] = [];
      const watcher = createCorpusWatcher(makeDeps(slugTree, { fs, ingest: recorder(calls) }));
      expect(watcher.tick().kind).toBe('ingested');
      calls.length = 0;

      failRoot = true;
      expect(watcher.tick()).toEqual({
        kind: 'read-error',
        reason: 'corpus root unreadable (EACCES)',
      });
      expect(calls).toHaveLength(0);

      // The failed listing proved nothing about which sessions are gone, so the
      // fingerprint map survived intact: a healed root finds the unchanged
      // session already committed. A replay here would mean the guard pruned.
      failRoot = false;
      expect(watcher.tick()).toEqual({ kind: 'unchanged' });
      expect(calls).toHaveLength(0);
    });

    it('names the code `unknown` when the root listing fails without an errno', () => {
      const base = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir({ [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) }),
      });
      const hostile: CorpusFs = {
        ...base,
        readDirNames(absDir: string): string[] {
          if (absDir === ROOT) {
            throw new Error('boom without a code');
          }
          return base.readDirNames(absDir);
        },
      };
      const watcher = createCorpusWatcher(makeDeps({}, { fs: hostile }));

      expect(watcher.tick()).toEqual({
        kind: 'read-error',
        reason: 'corpus root unreadable (unknown)',
      });
    });

    it('stringifies a non-Error throw instead of crashing the reason', () => {
      // JS lets code throw anything. A primitive has no `.message`, so the
      // outcome falls back to String(error) - still sanitized, never empty.
      const base = makeFakeCorpusFs(ROOT, {});
      const hostile: CorpusFs = {
        ...base,
        realpath(): string {
          throw 'not even an Error';
        },
      };
      const watcher = createCorpusWatcher(makeDeps({}, { fs: hostile }));

      expect(watcher.tick()).toEqual({
        kind: 'read-error',
        reason: 'not even an Error',
      });
    });

    it('flips a stale agent on an otherwise-quiet healthy tick', () => {
      insertSession(temp.db, 'session-1');
      insertAgent(temp.db, 'a-stale', 'session-1', null, 'waiting');
      const events: IngestEvent[] = [];
      const watcher = createCorpusWatcher(
        makeDeps({}, { onIngestEvent: (event) => events.push(event) }),
      );

      expect(watcher.tick()).toEqual({ kind: 'unchanged' }); // empty corpus
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

    it('hands every SCHEDULED pass outcome to onTickOutcome, never a manual tick', () => {
      vi.useFakeTimers();
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const outcomes: TickOutcome[] = [];
      const watcher = createCorpusWatcher(
        makeDeps(slugTree, {
          ingest: recorder([]),
          onTickOutcome: (pass) => outcomes.push(pass),
        }),
      );

      // A manual tick hands its outcome to the CALLER — routing it through the
      // seam as well would double-report every boot replay.
      expect(watcher.tick().kind).toBe('ingested');
      expect(outcomes).toHaveLength(0);

      watcher.start();
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(outcomes).toEqual([{ kind: 'unchanged' }]);

      slugTree[`${SESSION_A}.jsonl`] = file(MAIN, { mtimeMs: 2 });
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(outcomes).toHaveLength(2);
      expect(outcomes[1]?.kind).toBe('ingested');

      watcher.stop();
    });
  });

  describe('production defaults', () => {
    it('runs on the real fs port and wall clock when neither is injected', () => {
      // No `fs` → the production nodeCorpusFs resolves a guaranteed-absent
      // directory to ENOENT ('no-corpus-root') — never the real corpus.
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

      expect(watcher.tick()).toEqual({ kind: 'no-corpus-root' });
      expect(statusOf(temp, 'a-stale')).toBe('unknown');
    });
  });

  /**
   * The narrowing helper every OTHER caller uses when it only wants the
   * summary. It exists so that dropping the outcome kind is an explicit act at
   * the call site rather than the default shape of the API.
   */
  describe('tickSummary', () => {
    it('hands back the summary of an ingesting pass and null for every other kind', () => {
      const slugTree: MutableTree = { [`${SESSION_A}.jsonl`]: file(MAIN, { mtimeMs: 1 }) };
      const watcher = createCorpusWatcher(makeDeps(slugTree, { ingest: recorder([]) }));

      expect(tickSummary(watcher.tick())?.sessionsOk).toBe(1);
      for (const pass of [
        { kind: 'unchanged' },
        { kind: 'no-corpus-root' },
        { kind: 'overlapped' },
        { kind: 'stopped' },
        { kind: 'read-error', reason: 'corpus root unreadable (EACCES)' },
        { kind: 'containment-halt' },
      ] as const) {
        expect(tickSummary(pass)).toBeNull();
      }
    });
  });
});
