/**
 * M-9 — the EQUIVALENCE proof behind the aggregate's chosen source.
 *
 * `getAggregateDelegationSavings` answers the WP-C5 counterfactual from STORED
 * ROWS, while `/api/sessions/:id/cost-analysis` answers the same question for
 * one session by parsing the JSONL SUBSTRATE. The user can click from the
 * aggregate through to a per-session figure, so if the two disagreed the
 * dashboard would be quoting two different dollar amounts for the same work.
 * Reconstructing a session out of the database is only defensible if it is
 * provably the same reconstruction — that proof is this file.
 *
 * Method: materialize real fixtures on disk, run the REAL corpus ingest, then
 * compute savings BOTH ways over the same corpus and compare in integer
 * micro-dollars (`costUsd` is a float; the two paths sum in different row
 * orders, so exact `===` on doubles would be testing IEEE-754, not equality).
 *
 * Read-side rates deliberately differ per model, so a subagent repriced at its
 * ancestor's model MOVES the number. With one flat rate for everything the
 * hypothetical would equal the actual and the whole comparison would be
 * `0 === 0` — the assertions at the end of each test guard against exactly that.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeDelegationSavings,
  type DelegationSavingsResult,
  type PricingEntry,
} from '@agenthropic/core';
import { getFixture, type Fixture, type FixtureName } from '@agenthropic/test-fixtures';
import { getAggregateDelegationSavings } from '../src/api/queries';
import { createSubstrateProvider } from '../src/api/substrate-provider';
import { runCorpusIngest } from '../src/corpus/ingest-corpus';
import { createMigratedTempDb, type TempDb } from './helpers';

const SLUG = '-Users-synthetic-equivalence-project';
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

/**
 * Fixtures with a bare `<uuid>.jsonl` main transcript — one session each — and
 * the delegation shape each one must produce. The table is not decoration: it
 * pins that this corpus exercises BOTH accounting arms (three fixtures with
 * priced subagents, one whose subagent has no derivable top-tier model and is
 * therefore skipped), so a fixture that quietly lost its subagent tree would
 * fail here instead of turning the equivalence proof into `0 === 0`.
 */
const FIXTURES = {
  'flat-tool-use': { priced: 1, skipped: 0 },
  'nested-workflow': { priced: 2, skipped: 0 },
  'depth-2-sync': { priced: 2, skipped: 0 },
  'task-notification-recovery': { priced: 0, skipped: 1 },
} as const;

const FIXTURE_NAMES = Object.keys(FIXTURES) as ReadonlyArray<keyof typeof FIXTURES>;

/** Ingest-side gate: every fixture model must have a price or the session halts. */
const INGEST_PRICING: PricingEntry[] = ['synthetic-model-a', 'synthetic-model-b'].flatMap((model) =>
  BUCKETS.map((bucket) => ({
    model,
    bucket,
    usdPerMtok: 1,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  })),
);

/** Read-side rates: model A is five times model B in every bucket. */
const READ_PRICING: PricingEntry[] = [
  ['synthetic-model-a', 5],
  ['synthetic-model-b', 1],
].flatMap(([model, rate]) =>
  BUCKETS.map((bucket) => ({
    model: model as string,
    bucket,
    usdPerMtok: rate as number,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  })),
);

/** Integer micro-dollars — the only honest way to compare two float sums. */
function micro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function mainSessionIdOf(fixture: Fixture): string {
  const main = fixture.files.find((f) => !f.relativePath.includes('/'));
  if (main === undefined) {
    throw new Error(`fixture ${fixture.name} has no main transcript; update this test`);
  }
  return main.relativePath.slice(0, -'.jsonl'.length);
}

/** Lay a fixture out on REAL disk the way Claude Code does (main + `<uuid>/`). */
function materializeFixture(corpusRoot: string, fixture: Fixture, sessionId: string): void {
  for (const f of fixture.files) {
    const rel = f.relativePath.includes('/')
      ? join(sessionId, ...f.relativePath.split('/'))
      : f.relativePath;
    const abs = join(corpusRoot, SLUG, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.lines.join('\n') + '\n');
  }
}

describe('aggregate delegation savings equals the substrate parse (M-9)', () => {
  const dirs: string[] = [];
  const temps: TempDb[] = [];

  afterEach(() => {
    for (const temp of temps.splice(0)) temp.cleanup();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Ingest the named fixtures through the real runner into a fresh database. */
  function ingest(names: readonly FixtureName[]): {
    readonly temp: TempDb;
    readonly corpusRoot: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-savings-equivalence-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    const temp = createMigratedTempDb();
    temps.push(temp);
    for (const name of names) {
      const fixture = getFixture(name);
      materializeFixture(corpusRoot, fixture, mainSessionIdOf(fixture));
    }
    const result = runCorpusIngest({
      db: temp.db,
      pricing: INGEST_PRICING,
      env: { CLAUDE_PROJECTS_DIR: corpusRoot },
    });
    expect(result.sessionsOk).toBe(names.length);
    return { temp, corpusRoot };
  }

  /** The oracle: parse one session off disk exactly as the per-session route does. */
  function substrateSavings(
    corpusRoot: string,
    sessionId: string,
    topTierModel?: string,
  ): DelegationSavingsResult {
    const lookup = createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: corpusRoot },
    }).loadSession(sessionId);
    if (lookup.kind !== 'resolved') {
      throw new Error(`fixture session ${sessionId} did not resolve: ${lookup.kind}`);
    }
    return computeDelegationSavings(
      lookup.substrate.session,
      READ_PRICING,
      topTierModel === undefined ? {} : { topTierModel },
    );
  }

  for (const name of FIXTURE_NAMES) {
    it(`reconstructs ${name} from stored rows to the micro-dollar`, () => {
      const { temp, corpusRoot } = ingest([name]);
      const sessionId = mainSessionIdOf(getFixture(name));
      const oracle = substrateSavings(corpusRoot, sessionId);
      const aggregate = getAggregateDelegationSavings(temp.db, READ_PRICING);

      expect(micro(aggregate.actualUsd)).toBe(micro(oracle.actualUsd));
      expect(micro(aggregate.hypotheticalUsd)).toBe(micro(oracle.hypotheticalUsd));
      expect(micro(aggregate.savingsUsd)).toBe(micro(oracle.savingsUsd));
      // Not just the dollars: the same agents must have been priced and the
      // same ones skipped, or the two figures agree by coincidence.
      expect(aggregate.subagentsPriced).toBe(oracle.perAgent.length);
      expect(aggregate.subagentsSkipped).toBe(oracle.skippedAgentIds.length);
      expect(aggregate.hypotheticalModels).toEqual(
        [...new Set(oracle.perAgent.map((agent) => agent.hypotheticalModel))].sort(),
      );
      // Scope, stated: this corpus is one session, it delegates, it priced.
      expect(aggregate.sessionsTotal).toBe(1);
      expect(aggregate.sessionsWithSubagents).toBe(1);
      expect(aggregate.sessionsPriced).toBe(1);
      expect(aggregate.skippedSessionCount).toBe(0);
      expect(aggregate.untypedAgents).toBe(0);
      // Guard the guard: an empty tree would satisfy everything above, so the
      // expected delegation shape is pinned per fixture.
      expect({ priced: aggregate.subagentsPriced, skipped: aggregate.subagentsSkipped }).toEqual(
        FIXTURES[name],
      );
    });
  }

  it('sums the whole corpus to the sum of its per-session figures', () => {
    const { temp, corpusRoot } = ingest(FIXTURE_NAMES);
    const oracles = FIXTURE_NAMES.map((name) =>
      substrateSavings(corpusRoot, mainSessionIdOf(getFixture(name))),
    );
    const sumOf = (pick: (r: DelegationSavingsResult) => number): number =>
      oracles.reduce((total, oracle) => total + pick(oracle), 0);
    const aggregate = getAggregateDelegationSavings(temp.db, READ_PRICING);

    // THE claim on screen: the corpus KPI is the sum of the per-session
    // numbers the reader can click through to.
    expect(micro(aggregate.actualUsd)).toBe(micro(sumOf((r) => r.actualUsd)));
    expect(micro(aggregate.hypotheticalUsd)).toBe(micro(sumOf((r) => r.hypotheticalUsd)));
    expect(micro(aggregate.savingsUsd)).toBe(micro(sumOf((r) => r.savingsUsd)));
    expect(aggregate.subagentsPriced).toBe(sumOf((r) => r.perAgent.length));
    expect(aggregate.subagentsSkipped).toBe(sumOf((r) => r.skippedAgentIds.length));
    expect(aggregate.sessionsTotal).toBe(FIXTURE_NAMES.length);
    expect(aggregate.sessionsPriced).toBe(aggregate.sessionsWithSubagents);
    expect(aggregate.savingsUsd).toBeGreaterThan(0);
  });

  it('keeps agreeing when the routing alternative is named explicitly', () => {
    // The `topTierModel` arm bypasses ancestor derivation, so it exercises the
    // repricing path against a model no fixture agent ran on.
    const { temp, corpusRoot } = ingest(FIXTURE_NAMES);
    const oracles = FIXTURE_NAMES.map((name) =>
      substrateSavings(corpusRoot, mainSessionIdOf(getFixture(name)), 'synthetic-model-a'),
    );
    const aggregate = getAggregateDelegationSavings(temp.db, READ_PRICING, {
      topTierModel: 'synthetic-model-a',
    });
    expect(micro(aggregate.hypotheticalUsd)).toBe(
      micro(oracles.reduce((total, oracle) => total + oracle.hypotheticalUsd, 0)),
    );
    expect(micro(aggregate.savingsUsd)).toBe(
      micro(oracles.reduce((total, oracle) => total + oracle.savingsUsd, 0)),
    );
    expect(aggregate.hypotheticalModels).toEqual(['synthetic-model-a']);
    expect(aggregate.savingsUsd).toBeGreaterThan(0);
  });

  it('a second replay of the same bytes changes no dollar of the aggregate', () => {
    const { temp, corpusRoot } = ingest(FIXTURE_NAMES);
    const before = getAggregateDelegationSavings(temp.db, READ_PRICING);
    const replay = runCorpusIngest({
      db: temp.db,
      pricing: INGEST_PRICING,
      env: { CLAUDE_PROJECTS_DIR: corpusRoot },
    });
    expect(replay.sessionsOk).toBe(FIXTURE_NAMES.length);
    expect(getAggregateDelegationSavings(temp.db, READ_PRICING)).toEqual(before);
  });
});
