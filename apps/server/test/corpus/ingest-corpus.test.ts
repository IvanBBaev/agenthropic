/**
 * WP-IN5 corpus ingest runner ({@link runCorpusIngest}) — tested in two layers.
 *
 * LAYER A drives the FOLD with an injected `ingest` stub over the in-memory
 * {@link CorpusFs} fake, so every accumulator arm, `??` fallback and isolation
 * guarantee is exercised without the real parser, the real corpus or a single
 * priced token. The stub also captures the {@link IngestDeps} it is handed,
 * which is how identity / clock / projectSlug forwarding is asserted.
 *
 * LAYER B is ONE end-to-end pass with the REAL {@link ingestSession} and a real
 * migrated database, driven off a fake corpus materialized from a synthetic
 * fixture — the proof that the runner's seams compose into persisted rows and
 * that a re-run over an unchanged corpus writes nothing new.
 */
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSession, type PricingEntry, type SessionSubstrate } from '@agenthropic/core';
import { getFixture, type Fixture } from '@agenthropic/test-fixtures';
import { ContainmentError, type CorpusFs, type SkippedFile } from '../../src/corpus/fs-port';
import {
  runCorpusIngest,
  type CorpusIngestDeps,
  type CorpusIngestSummary,
  type IngestFn,
} from '../../src/corpus/ingest-corpus';
import { loadPricing } from '../../src/db/pricing';
import type { AgentStatusChangedEvent, SessionIngestedEvent } from '../../src/ingest/ingest-events';
import type { IngestDeps, IngestOutcome } from '../../src/ingest/ingest-session';
import { createMigratedTempDb, type TempDb } from '../helpers';
import {
  dir,
  file,
  makeFakeCorpusFs,
  symlink,
  type NodeSpec,
  type TreeSpec,
} from './fake-corpus-fs';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-project-alpha';
const SLUG_B = '-Users-synthetic-project-beta';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const FIXED_NOW = '2026-07-11T00:00:00.000Z';

/** Any non-empty main transcript body — Layer A's stub never parses it. */
const MAIN = '{"main":true}\n';

const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

/** Prices for the synthetic corpus models, effective well before every fixture timestamp. */
const SYNTHETIC_PRICING: readonly PricingEntry[] = [
  'synthetic-model-a',
  'synthetic-model-b',
].flatMap((model): PricingEntry[] =>
  BUCKETS.map((bucket) => ({ model, bucket, usdPerMtok: 1, effectiveFrom: '2020-01-01' })),
);

function count(temp: TempDb, sql: string, ...params: readonly string[]): number {
  const row = temp.db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

// --- Layer A stub plumbing --------------------------------------------------

/** One recorded call into the injected ingest stub. */
interface StubCall {
  readonly substrate: SessionSubstrate;
  readonly deps: IngestDeps;
}

/** An ok outcome with every counter zeroed; spread over with per-test values. */
function outcome(overrides: Partial<IngestOutcome> = {}): IngestOutcome {
  return {
    ok: true,
    sessionId: 'stub-session',
    costUsd: 0,
    agentsUpserted: 0,
    edgesInserted: 0,
    usageRowsInserted: 0,
    statusReconciliations: [],
    crossSessionUsageCollisions: 0,
    error: null,
    ...overrides,
  };
}

/**
 * An {@link IngestFn} stub that records every call into `calls` and answers via
 * `respond` (which may itself throw, to exercise the runner's per-session catch).
 */
function recorder(
  calls: StubCall[],
  respond: (call: StubCall, index: number) => IngestOutcome = () => outcome(),
): IngestFn {
  return (substrate, deps): IngestOutcome => {
    const call: StubCall = { substrate, deps };
    const index = calls.length;
    calls.push(call);
    return respond(call, index);
  };
}

/** The main transcript's relative path — Producer 1 always pushes it first. */
function mainPathOf(call: StubCall): string | undefined {
  return call.substrate.files[0]?.relativePath;
}

/** A slug directory holding exactly one session's bare `<uuid>.jsonl` main. */
function soleSession(sessionId: string): TreeSpec {
  return { [`${sessionId}.jsonl`]: file(MAIN) };
}

describe('runCorpusIngest (WP-IN5)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function makeDeps(overrides: Partial<CorpusIngestDeps> = {}): CorpusIngestDeps {
    return {
      db: temp.db,
      pricing: [],
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      now: () => FIXED_NOW,
      ...overrides,
    };
  }

  // --- Layer A: the fold, over an injected ingest stub -----------------------

  describe('corpus root resolution', () => {
    it('returns an all-zero summary and never ingests when the root does not exist', () => {
      // The tree HOLDS a session: proving the null root short-circuits before enumeration.
      const fs = makeFakeCorpusFs(
        ROOT,
        { [SLUG]: dir(soleSession(SESSION_A)) },
        {
          realpathThrow: 'ENOENT',
        },
      );
      const calls: StubCall[] = [];

      const summary = runCorpusIngest(makeDeps({ fs, ingest: recorder(calls) }));

      expect(summary).toEqual({
        sessionsDiscovered: 0,
        sessionsOk: 0,
        sessionsFailed: 0,
        sessionsSkipped: 0,
        agentsUpserted: 0,
        edgesInserted: 0,
        usageRowsInserted: 0,
        filesSkipped: 0,
        totalCostUsd: 0,
        failures: [],
      });
      expect(calls).toHaveLength(0);
    });

    it('defaults to the real node fs port when none is injected', () => {
      // No `fs` override → the production `nodeCorpusFs()` resolves a guaranteed
      // absent directory to ENOENT → null root. Zero dependency on a real corpus.
      const calls: StubCall[] = [];

      const summary = runCorpusIngest(
        makeDeps({
          env: { CLAUDE_PROJECTS_DIR: join(temp.dir, 'no-such-corpus') },
          ingest: recorder(calls),
        }),
      );

      expect(summary.sessionsDiscovered).toBe(0);
      expect(summary.failures).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('derives the root from the injected homedir when CLAUDE_PROJECTS_DIR is unset', () => {
      const home = '/fake/home';
      const fs = makeFakeCorpusFs(join(home, '.claude', 'projects'), {
        [SLUG]: dir(soleSession(SESSION_A)),
      });
      const calls: StubCall[] = [];

      const summary = runCorpusIngest(
        makeDeps({ env: {}, fs, homedir: () => home, ingest: recorder(calls) }),
      );

      expect(summary.sessionsDiscovered).toBe(1);
      expect(summary.sessionsOk).toBe(1);
      expect(calls).toHaveLength(1);
    });
  });

  describe('the outcome fold', () => {
    it('sums every ok outcome across the discovered sessions', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir(soleSession(SESSION_A)),
        [SLUG_B]: dir(soleSession(SESSION_B)),
      });
      const outcomes = [
        outcome({ agentsUpserted: 3, edgesInserted: 1, usageRowsInserted: 5, costUsd: 0.5 }),
        outcome({ agentsUpserted: 2, edgesInserted: 4, usageRowsInserted: 7, costUsd: 0.25 }),
      ];
      const calls: StubCall[] = [];

      const summary = runCorpusIngest(
        makeDeps({ fs, ingest: recorder(calls, (_call, index) => outcomes[index]!) }),
      );

      expect(summary).toEqual({
        sessionsDiscovered: 2,
        sessionsOk: 2,
        sessionsFailed: 0,
        sessionsSkipped: 0,
        agentsUpserted: 5,
        edgesInserted: 5,
        usageRowsInserted: 12,
        filesSkipped: 0,
        totalCostUsd: 0.75,
        failures: [],
      });
    });

    it('treats a null costUsd on an ok outcome as a zero contribution', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir(soleSession(SESSION_A)),
        [SLUG_B]: dir(soleSession(SESSION_B)),
      });
      const outcomes = [outcome({ costUsd: null }), outcome({ costUsd: 1.5 })];

      const summary = runCorpusIngest(
        makeDeps({ fs, ingest: recorder([], (_call, index) => outcomes[index]!) }),
      );

      expect(summary.sessionsOk).toBe(2);
      expect(summary.totalCostUsd).toBe(1.5);
    });

    it('skips a session whose substrate cannot be built, and still ingests the others', () => {
      // An unreadable main with no agent files → the build reports no-substrate.
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir({
          [`${SESSION_A}.jsonl`]: file(MAIN, { throwCode: 'EACCES' }),
          [`${SESSION_B}.jsonl`]: file(MAIN),
        }),
      });
      const calls: StubCall[] = [];
      const warnings: SkippedFile[] = [];

      const summary = runCorpusIngest(
        makeDeps({ fs, ingest: recorder(calls), onWarning: (skipped) => warnings.push(skipped) }),
      );

      expect(summary.sessionsDiscovered).toBe(2);
      expect(summary.sessionsSkipped).toBe(1);
      expect(summary.sessionsOk).toBe(1);
      // The session is dropped whole, but WHY it was dropped still reaches the
      // operator. This used to report `filesSkipped: 0` and warn about nothing:
      // the same EACCES that IS announced when a sibling agent transcript
      // survives alongside it was swallowed precisely when it was the only
      // thing there was to say. The total loss reported less than the partial.
      expect(summary.filesSkipped).toBe(1);
      expect(warnings).toEqual([
        { relativePath: `${SESSION_A}.jsonl`, reason: 'unreadable', code: 'EACCES' },
      ]);
      expect(calls.map(mainPathOf)).toEqual([`${SESSION_B}.jsonl`]);
    });

    it('records a failure from a not-ok outcome using its own sessionId and error', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: () =>
            outcome({ ok: false, sessionId: 'outcome-session', error: 'parse blew up' }),
        }),
      );

      expect(summary.sessionsOk).toBe(0);
      expect(summary.sessionsFailed).toBe(1);
      expect(summary.failures).toEqual([
        { sessionId: 'outcome-session', projectSlug: SLUG, error: 'parse blew up' },
      ]);
    });

    it('falls back to the ref sessionId and a generic error when the outcome carries neither', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });

      const summary = runCorpusIngest(
        makeDeps({ fs, ingest: () => outcome({ ok: false, sessionId: null, error: null }) }),
      );

      expect(summary.sessionsFailed).toBe(1);
      expect(summary.failures).toEqual([
        { sessionId: SESSION_A, projectSlug: SLUG, error: 'unknown ingest failure' },
      ]);
    });

    it('does not count a failed session as agents / edges / usage / cost', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          // A not-ok outcome carrying counters: the fold must ignore them.
          ingest: () =>
            outcome({
              ok: false,
              error: 'nope',
              agentsUpserted: 9,
              edgesInserted: 9,
              usageRowsInserted: 9,
              costUsd: 9,
            }),
        }),
      );

      expect(summary.agentsUpserted).toBe(0);
      expect(summary.edgesInserted).toBe(0);
      expect(summary.usageRowsInserted).toBe(0);
      expect(summary.totalCostUsd).toBe(0);
    });
  });

  describe('per-session isolation', () => {
    it('isolates a throwing ingest to its own session and continues the loop', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir({
          [`${SESSION_A}.jsonl`]: file(MAIN),
          [`${SESSION_B}.jsonl`]: file(MAIN),
        }),
      });
      const calls: StubCall[] = [];

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: recorder(calls, (call) => {
            if (mainPathOf(call) === `${SESSION_A}.jsonl`) {
              throw new Error('stub exploded');
            }
            return outcome({ agentsUpserted: 2 });
          }),
        }),
      );

      expect(calls).toHaveLength(2); // the loop reached the second session
      expect(summary.sessionsDiscovered).toBe(2);
      expect(summary.sessionsFailed).toBe(1);
      expect(summary.sessionsOk).toBe(1);
      expect(summary.agentsUpserted).toBe(2);
      expect(summary.failures).toEqual([
        { sessionId: SESSION_A, projectSlug: SLUG, error: 'stub exploded' },
      ]);
    });

    it('stringifies a non-Error throw from ingest', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: () => {
            throw 'boom';
          },
        }),
      );

      expect(summary.sessionsFailed).toBe(1);
      expect(summary.failures).toEqual([
        { sessionId: SESSION_A, projectSlug: SLUG, error: 'boom' },
      ]);
    });
  });

  describe('sessionFilter (the tail-follow admission seam)', () => {
    it('ingests only the admitted refs and counts ONLY them as discovered', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir(soleSession(SESSION_A)),
        [SLUG_B]: dir(soleSession(SESSION_B)),
      });
      const calls: StubCall[] = [];

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: recorder(calls),
          sessionFilter: (ref) => ref.sessionId === SESSION_B,
        }),
      );

      expect(calls.map(mainPathOf)).toEqual([`${SESSION_B}.jsonl`]);
      expect(summary.sessionsDiscovered).toBe(1);
      expect(summary.sessionsOk).toBe(1);
    });

    it('a filter admitting nothing yields the all-zero summary', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const calls: StubCall[] = [];

      const summary = runCorpusIngest(
        makeDeps({ fs, ingest: recorder(calls), sessionFilter: () => false }),
      );

      expect(calls).toHaveLength(0);
      expect(summary.sessionsDiscovered).toBe(0);
      expect(summary.failures).toEqual([]);
    });
  });

  describe('onSessionIngested (the live-loop event seam)', () => {
    it('fires once per ok session with the outcome counters and the verbatim slug', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const events: SessionIngestedEvent[] = [];

      runCorpusIngest(
        makeDeps({
          fs,
          ingest: () =>
            outcome({
              sessionId: 'outcome-session',
              agentsUpserted: 3,
              edgesInserted: 2,
              usageRowsInserted: 10,
              costUsd: 0.5,
            }),
          onSessionIngested: (event) => events.push(event),
        }),
      );

      expect(events).toEqual([
        {
          type: 'session-ingested',
          sessionId: 'outcome-session',
          projectSlug: SLUG,
          agentsUpserted: 3,
          edgesInserted: 2,
          usageRowsInserted: 10,
          costUsd: 0.5,
        },
      ]);
    });

    it('falls back to the ref sessionId when the ok outcome carries none', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const events: SessionIngestedEvent[] = [];

      runCorpusIngest(
        makeDeps({
          fs,
          ingest: () => outcome({ sessionId: null, costUsd: null }),
          onSessionIngested: (event) => events.push(event),
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0]?.sessionId).toBe(SESSION_A);
      expect(events[0]?.costUsd).toBe(null);
    });

    it('never fires for a failed or throwing session', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir(soleSession(SESSION_A)),
        [SLUG_B]: dir(soleSession(SESSION_B)),
      });
      const events: SessionIngestedEvent[] = [];

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: recorder([], (call) => {
            if (mainPathOf(call) === `${SESSION_A}.jsonl`) {
              throw new Error('boom');
            }
            return outcome({ ok: false, error: 'parse failed' });
          }),
          onSessionIngested: (event) => events.push(event),
        }),
      );

      expect(summary.sessionsFailed).toBe(2);
      expect(events).toEqual([]);
    });
  });

  describe('onStatusReconciled (M-17: the hook-before-row replay seam)', () => {
    function reconciliation(agentId: string): AgentStatusChangedEvent {
      return {
        type: 'agent-status-changed',
        agentId,
        sessionId: SESSION_A,
        oldStatus: null,
        newStatus: 'completed',
      };
    }

    it('fires once per reconciliation, in order, AFTER the session-ingested event', () => {
      // The ordering is the contract, not an accident: a client must learn that
      // the agent exists before it is told the agent's status settled.
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const seen: string[] = [];

      runCorpusIngest(
        makeDeps({
          fs,
          ingest: () =>
            outcome({
              statusReconciliations: [reconciliation('agent-c0ffee'), reconciliation('agent-dead')],
            }),
          onSessionIngested: (event) => seen.push(event.type),
          onStatusReconciled: (event) => seen.push(`${event.type}:${event.agentId}`),
        }),
      );

      expect(seen).toEqual([
        'session-ingested',
        'agent-status-changed:agent-c0ffee',
        'agent-status-changed:agent-dead',
      ]);
    });

    it('hands the event over verbatim', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const events: AgentStatusChangedEvent[] = [];
      const replayed = reconciliation('agent-beef');

      runCorpusIngest(
        makeDeps({
          fs,
          ingest: () => outcome({ statusReconciliations: [replayed] }),
          onStatusReconciled: (event) => events.push(event),
        }),
      );

      expect(events).toEqual([replayed]);
    });

    it('never fires for a failed session that still carries reconciliations', () => {
      // A rolled-back transaction changed no status, so announcing one would be
      // a lie the UI could not undo.
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const events: AgentStatusChangedEvent[] = [];

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: () =>
            outcome({
              ok: false,
              error: 'rolled back',
              statusReconciliations: [reconciliation('agent-c0ffee')],
            }),
          onStatusReconciled: (event) => events.push(event),
        }),
      );

      expect(summary.sessionsFailed).toBe(1);
      expect(events).toEqual([]);
    });

    it('replays without a sink wired', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: () => outcome({ statusReconciliations: [reconciliation('agent-c0ffee')] }),
        }),
      );

      expect(summary.sessionsOk).toBe(1);
    });
  });

  describe('onUsageCollisions (M-18: the cross-session ownership counter)', () => {
    it('fires once per session, with the count of messages that session skipped', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir(soleSession(SESSION_A)),
        [SLUG_B]: dir(soleSession(SESSION_B)),
      });
      const outcomes = [
        outcome({ crossSessionUsageCollisions: 4 }),
        outcome({ crossSessionUsageCollisions: 7 }),
      ];
      const collisions: number[] = [];

      runCorpusIngest(
        makeDeps({
          fs,
          ingest: recorder([], (_call, index) => outcomes[index]!),
          onUsageCollisions: (n) => collisions.push(n),
        }),
      );

      expect(collisions).toEqual([4, 7]);
    });

    it('stays silent for a session that collided with nothing', () => {
      // Zero is not news: firing on it would turn the health counter's own
      // "seam present" signal into noise the operator has to filter.
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const collisions: number[] = [];

      runCorpusIngest(
        makeDeps({
          fs,
          ingest: () => outcome({ crossSessionUsageCollisions: 0 }),
          onUsageCollisions: (n) => collisions.push(n),
        }),
      );

      expect(collisions).toEqual([]);
    });

    it('never fires for a failed session that still carries a collision count', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const collisions: number[] = [];

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: () =>
            outcome({ ok: false, error: 'rolled back', crossSessionUsageCollisions: 9 }),
          onUsageCollisions: (n) => collisions.push(n),
        }),
      );

      expect(summary.sessionsFailed).toBe(1);
      expect(collisions).toEqual([]);
    });

    it('counts collisions without a sink wired', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });

      const summary = runCorpusIngest(
        makeDeps({ fs, ingest: () => outcome({ crossSessionUsageCollisions: 3 }) }),
      );

      expect(summary.sessionsOk).toBe(1);
    });
  });

  describe('per-file skip diagnostics', () => {
    /** A session with a readable main and two unusable artifacts under `subagents/`. */
    function corpusWithTwoSkips(): TreeSpec {
      return {
        [SLUG]: dir({
          [`${SESSION_A}.jsonl`]: file(MAIN),
          [SESSION_A]: dir({
            subagents: dir({
              'agent-c0ffee.jsonl': symlink(),
              'notes.txt': file('not a section-2 artifact'),
            }),
          }),
        }),
      };
    }

    it('counts every skipped file and reports each one to onWarning', () => {
      const fs = makeFakeCorpusFs(ROOT, corpusWithTwoSkips());
      const warnings: SkippedFile[] = [];

      const summary = runCorpusIngest(
        makeDeps({ fs, ingest: recorder([]), onWarning: (skipped) => warnings.push(skipped) }),
      );

      expect(summary.sessionsOk).toBe(1);
      expect(summary.filesSkipped).toBe(2);
      expect(warnings).toEqual([
        { relativePath: 'subagents/agent-c0ffee.jsonl', reason: 'symlink' },
        { relativePath: 'subagents/notes.txt', reason: 'non-artifact' },
      ]);
    });

    it('counts skipped files without an onWarning sink', () => {
      const fs = makeFakeCorpusFs(ROOT, corpusWithTwoSkips());
      const run = (): CorpusIngestSummary =>
        runCorpusIngest(makeDeps({ fs, ingest: recorder([]) }));

      expect(run).not.toThrow();
      expect(run().filesSkipped).toBe(2);
    });
  });

  describe('enumeration-level duplicates (M-14)', () => {
    /** The same session uuid under both slugs — alpha wins (lexicographically smallest). */
    function duplicatedCorpus(): TreeSpec {
      return {
        [SLUG]: dir(soleSession(SESSION_A)),
        [SLUG_B]: dir(soleSession(SESSION_A)),
      };
    }

    it('ingests only the winning copy and reports the loser as duplicate-session', () => {
      const fs = makeFakeCorpusFs(ROOT, duplicatedCorpus());
      const calls: StubCall[] = [];
      const warnings: SkippedFile[] = [];

      const summary = runCorpusIngest(
        makeDeps({ fs, ingest: recorder(calls), onWarning: (skipped) => warnings.push(skipped) }),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.deps.projectSlug).toBe(SLUG);
      expect(summary.sessionsDiscovered).toBe(1);
      expect(summary.sessionsOk).toBe(1);
      expect(summary.filesSkipped).toBe(1);
      expect(warnings).toEqual([
        { relativePath: `${SLUG_B}/${SESSION_A}.jsonl`, reason: 'duplicate-session' },
      ]);
    });

    it('reports the duplicate even when the sessionFilter admits nothing', () => {
      // A shadowed copy is a corpus-level fact, not a property of any admitted
      // ref — a watcher pass that admits zero changed sessions must still count it.
      const fs = makeFakeCorpusFs(ROOT, duplicatedCorpus());
      const warnings: SkippedFile[] = [];

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: recorder([]),
          sessionFilter: () => false,
          onWarning: (skipped) => warnings.push(skipped),
        }),
      );

      expect(summary.sessionsDiscovered).toBe(0);
      expect(summary.filesSkipped).toBe(1);
      expect(warnings.map((w) => w.reason)).toEqual(['duplicate-session']);
    });
  });

  describe('containment is the one hard stop', () => {
    it('aborts the whole run when a crafted slug name escapes the corpus root', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir(soleSession(SESSION_A)),
        '..': dir({}),
      });
      const calls: StubCall[] = [];

      expect(() => runCorpusIngest(makeDeps({ fs, ingest: recorder(calls) }))).toThrow(
        ContainmentError,
      );
      expect(calls).toHaveLength(0); // enumeration throws before any session is ingested
    });

    it('aborts mid-run when a crafted artifact name escapes the session directory', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir({
          // Discovery order: B (clean, ingests) then A (crafted, aborts the run).
          [`${SESSION_B}.jsonl`]: file(MAIN),
          [`${SESSION_A}.jsonl`]: file(MAIN),
          [SESSION_A]: dir({ subagents: dir({ '..': dir({}) }) }),
        }),
      });
      const calls: StubCall[] = [];

      expect(() => runCorpusIngest(makeDeps({ fs, ingest: recorder(calls) }))).toThrow(
        ContainmentError,
      );
      // The build-time ContainmentError is NOT swallowed by the per-session catch:
      // no summary is ever returned, even though a session had already ingested.
      expect(calls).toHaveLength(1);
    });
  });

  describe('an unreadable corpus root aborts the run', () => {
    // The all-zero summary is reserved for facts ("the root is absent", "the
    // corpus is empty"). A root that EXISTS but could not be read is neither —
    // reporting zeros would claim an empty corpus nobody has actually seen.
    it('throws with the errno instead of reporting an all-zero summary', () => {
      const fs = makeFakeCorpusFs(
        ROOT,
        { [SLUG]: dir(soleSession(SESSION_A)) },
        { rootReaddirCode: 'EACCES' },
      );
      const calls: StubCall[] = [];

      expect(() => runCorpusIngest(makeDeps({ fs, ingest: recorder(calls) }))).toThrow(
        'corpus root unreadable (EACCES)',
      );
      expect(calls).toHaveLength(0);
    });

    it('names the code `unknown` when the root failure carries no errno', () => {
      const base = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const hostile: CorpusFs = {
        ...base,
        readDirNames(absDir: string): string[] {
          if (absDir === ROOT) throw new Error('boom without a code');
          return base.readDirNames(absDir);
        },
      };

      expect(() => runCorpusIngest(makeDeps({ fs: hostile, ingest: recorder([]) }))).toThrow(
        'corpus root unreadable (unknown)',
      );
    });

    it('treats a root that vanished mid-run (ENOENT) as an empty corpus, not an error', () => {
      const fs = makeFakeCorpusFs(
        ROOT,
        { [SLUG]: dir(soleSession(SESSION_A)) },
        { rootReaddirCode: 'ENOENT' },
      );

      const summary = runCorpusIngest(makeDeps({ fs, ingest: recorder([]) }));

      expect(summary.sessionsDiscovered).toBe(0);
      expect(summary.failures).toEqual([]);
    });
  });

  describe('deps forwarded to ingestSession', () => {
    function captureDeps(overrides: Partial<CorpusIngestDeps> = {}): IngestDeps {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const calls: StubCall[] = [];
      runCorpusIngest(makeDeps({ fs, ingest: recorder(calls), ...overrides }));
      return calls[0]!.deps;
    }

    it('uses DASHBOARD_INSTANCE as the instance and the OS hostname as the host id', () => {
      const deps = captureDeps({
        env: { CLAUDE_PROJECTS_DIR: ROOT, DASHBOARD_INSTANCE: 'dash-2' },
      });

      expect(deps.instance).toBe('dash-2');
      expect(deps.hostId).toBe(hostname());
    });

    it('mirrors the hostname into the instance when DASHBOARD_INSTANCE is unset', () => {
      const deps = captureDeps();

      expect(deps.hostId).toBe(hostname());
      expect(deps.instance).toBe(hostname());
      expect(deps.instance).toBe(deps.hostId);
    });

    it('passes the corpus directory name through as the projectSlug, verbatim', () => {
      const fs = makeFakeCorpusFs(ROOT, { [SLUG]: dir(soleSession(SESSION_A)) });
      const calls: StubCall[] = [];

      runCorpusIngest(makeDeps({ fs, ingest: recorder(calls) }));

      expect(calls[0]!.deps.projectSlug).toBe(SLUG);
    });

    it('forwards the injected clock', () => {
      expect(captureDeps().now!()).toBe(FIXED_NOW);
    });

    it('forwards a wall-clock default when no clock is injected', () => {
      const stamp = captureDeps({ now: undefined }).now!();

      expect(Number.isNaN(Date.parse(stamp))).toBe(false);
    });

    it('hands over the db and pricing untouched', () => {
      const pricing = SYNTHETIC_PRICING;
      const deps = captureDeps({ pricing });

      expect(deps.db).toBe(temp.db);
      expect(deps.pricing).toBe(pricing);
    });
  });

  describe('read limits', () => {
    it('merges a partial limits override over the defaults', () => {
      const fs = makeFakeCorpusFs(ROOT, {
        [SLUG]: dir({
          [`${SESSION_A}.jsonl`]: file(MAIN),
          [SESSION_A]: dir({
            subagents: dir({
              'agent-dead.jsonl': file('{"big":true}\n', { size: 5000 }),
              workflows: dir({ wf_1: dir({ 'agent-beef.jsonl': file('{"nested":true}\n') }) }),
            }),
          }),
        }),
      });
      const calls: StubCall[] = [];
      const warnings: SkippedFile[] = [];

      const summary = runCorpusIngest(
        makeDeps({
          fs,
          ingest: recorder(calls),
          limits: { maxFileBytes: 1000 },
          onWarning: (skipped) => warnings.push(skipped),
        }),
      );

      // The override bites: 5000 bytes is over the overridden 1000-byte cap.
      expect(summary.filesSkipped).toBe(1);
      expect(warnings).toEqual([
        { relativePath: 'subagents/agent-dead.jsonl', reason: 'oversize', code: undefined },
      ]);
      // ...while the un-overridden maxDepth keeps its default, so the depth-3
      // artifact is still walked and read.
      expect(calls[0]!.substrate.files.map((f) => f.relativePath)).toEqual([
        `${SESSION_A}.jsonl`,
        'subagents/workflows/wf_1/agent-beef.jsonl',
      ]);
    });
  });

  // --- Layer B: end-to-end, over the REAL ingestSession ----------------------

  describe('end-to-end over the real ingestSession', () => {
    const E2E_SLUG = '-Users-synthetic-e2e-project';
    const JSONL_SUFFIX = '.jsonl';

    type MutableTree = Record<string, NodeSpec>;

    /** Insert one file at `segments` (creating intermediate `dir` nodes) into `tree`. */
    function addFile(tree: MutableTree, segments: readonly string[], content: string): void {
      const head = segments[0]!;
      if (segments.length === 1) {
        tree[head] = file(content);
        return;
      }
      let node = tree[head];
      if (node === undefined || node.type !== 'dir') {
        node = dir({});
        tree[head] = node;
      }
      addFile(node.children as MutableTree, segments.slice(1), content);
    }

    /** The bare no-slash `<uuid>.jsonl` main is the only file enumeration keys on. */
    function mainSessionIdOf(fixture: Fixture): string {
      const main = fixture.files.find((f) => !f.relativePath.includes('/'));
      return main!.relativePath.slice(0, -JSONL_SUFFIX.length);
    }

    /**
     * Lay a fixture out the way Claude Code does on disk: the main transcript at
     * the slug root, every artifact under the sibling `<uuid>/` session dir.
     */
    function fixtureCorpus(fixture: Fixture, sessionId: string): TreeSpec {
      const slug: MutableTree = {};
      for (const f of fixture.files) {
        const segments = f.relativePath.includes('/')
          ? [sessionId, ...f.relativePath.split('/')]
          : [f.relativePath];
        addFile(slug, segments, f.lines.join('\n') + '\n');
      }
      return { [E2E_SLUG]: dir(slug) };
    }

    it('ingests a fixture corpus into real rows and is idempotent on re-run', () => {
      // `flat-tool-use` is main-ful. NOT `usage-dedup`: it is main-less by design,
      // so enumerateSessions cannot discover it — that is the contract, not a bug.
      const fixture = getFixture('flat-tool-use');
      const sessionId = mainSessionIdOf(fixture);
      const expected = parseSession(fixture);
      expect(sessionId).toBe(expected.sessionId);

      const deps: CorpusIngestDeps = {
        db: temp.db,
        pricing: [...loadPricing(temp.db), ...SYNTHETIC_PRICING],
        env: { CLAUDE_PROJECTS_DIR: ROOT },
        fs: makeFakeCorpusFs(ROOT, fixtureCorpus(fixture, sessionId)),
        now: () => FIXED_NOW,
      };

      const first = runCorpusIngest(deps);

      expect(first.failures).toEqual([]);
      expect(first.sessionsDiscovered).toBe(1);
      expect(first.sessionsOk).toBe(1);
      expect(first.sessionsFailed).toBe(0);
      expect(first.sessionsSkipped).toBe(0);
      expect(first.filesSkipped).toBe(0);
      expect(first.agentsUpserted).toBe(expected.agents.length);
      expect(first.edgesInserted).toBe(expected.edges.length);
      expect(first.usageRowsInserted).toBe(expected.usage.length * 5);
      expect(first.edgesInserted).toBeGreaterThan(0);
      expect(first.usageRowsInserted).toBeGreaterThan(0);
      expect(first.totalCostUsd).toBeGreaterThan(0);

      // The rows really landed, under the verbatim slug.
      const sid = expected.sessionId;
      expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions WHERE id = ?', sid)).toBe(1);
      expect(count(temp, 'SELECT COUNT(*) AS n FROM agents WHERE session_id = ?', sid)).toBe(
        expected.agents.length,
      );
      expect(
        count(temp, 'SELECT COUNT(*) AS n FROM orchestration_edges WHERE session_id = ?', sid),
      ).toBe(expected.edges.length);
      expect(count(temp, 'SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ?', sid)).toBe(
        expected.usage.length * 5,
      );
      const session = temp.db
        .prepare('SELECT project_slug AS slug FROM sessions WHERE id = ?')
        .get(sid) as { slug: string | null };
      expect(session.slug).toBe(E2E_SLUG);

      // IDEMPOTENCE: the same corpus re-ingests ok, writing no new edges or usage.
      const second = runCorpusIngest(deps);

      expect(second.sessionsOk).toBe(1);
      expect(second.sessionsFailed).toBe(0);
      expect(second.edgesInserted).toBe(0);
      expect(second.usageRowsInserted).toBe(0);
      expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1);
      expect(count(temp, 'SELECT COUNT(*) AS n FROM agents WHERE session_id = ?', sid)).toBe(
        expected.agents.length,
      );
      expect(
        count(temp, 'SELECT COUNT(*) AS n FROM orchestration_edges WHERE session_id = ?', sid),
      ).toBe(expected.edges.length);
      expect(count(temp, 'SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ?', sid)).toBe(
        expected.usage.length * 5,
      );
    });
  });
});
