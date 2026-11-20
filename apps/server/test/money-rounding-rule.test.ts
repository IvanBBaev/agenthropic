/**
 * DAT-12 — the money rounding rule, and a test that the gate and the API agree.
 *
 * Dollars exist twice. The ingest gate (`priceUsage` in packages/core) sums one
 * `tokens * rate / 1e6` term per message bucket, in message order. The API
 * (`getCostSummary`) sums one term per `token_usage_rollup` group, in primary
 * key order, over an exact integer token total. Both are IEEE-754 doubles and
 * neither path rounds, so the two cannot be bit-identical in general.
 * rate-resolver-parity.test.ts pins them to the cent on single rows; this file
 * pins them on totals over many rows, which is where float drift lives.
 *
 * THE RULE (docs/site/architecture/cost-model.md, "The rounding rule"):
 *  1. A dollar amount is a double from end to end. No path rounds it, and the
 *     only rounding is the display edge (`formatUsd`: cents at or above $0.01).
 *  2. Each path is within `(n + 4) * 2^-53 * S` of the exact rational total,
 *     where n is the number of terms that path adds and S the exact total:
 *     one unit roundoff per addition, plus a few per term for the rate's
 *     binary representation, the multiply and the divide. So the two paths
 *     are within the sum of their bounds of each other.
 *  3. Consequently both paths display the same cents unless the exact total
 *     sits within that bound of a half-cent, where rounding is a coin toss
 *     for any binary representation.
 *
 * The exact total is computed with BigInt in pico-dollars (rates carry at most
 * six decimals, so `tokens * rate * 1e6` is an integer), an oracle that shares
 * no arithmetic with either path.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { priceUsage } from '@agenthropic/core';
import type { DedupedUsage, PricingEntry, TokenBuckets } from '@agenthropic/core';
import { getCostSummary } from '../src/api/queries';
import { loadPricing } from '../src/db/pricing';
import { insertTokenUsageRows } from '../src/db/token-usage';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

const UNIT_ROUNDOFF = 2 ** -53;
const PICO_PER_USD = 1_000_000_000_000n;
const HALF_CENT_PICO = 5_000_000_000n;
const CENT_PICO = 10_000_000_000n;

const BUCKET_KEYS = [
  ['input', 'input'],
  ['output', 'output'],
  ['cacheRead', 'cache_read'],
  ['cacheWrite5m', 'cache_write_5m'],
  ['cacheWrite1h', 'cache_write_1h'],
] as const satisfies ReadonlyArray<readonly [keyof TokenBuckets, string]>;

/** The day the test models are repriced: usage on or after it takes the second rate. */
const REPRICE_AT = '2026-10-01T00:00:00.000Z';

/**
 * Test-only models with deliberately non-dyadic rates (0.3, 0.08, 18.75 ...),
 * so that almost no term is exact in binary, and a mid-range reprice, so that
 * the rollup splits one model into several rate groups.
 */
const MODELS = ['dat12-alpha', 'dat12-beta'] as const;
const RATES: Record<(typeof MODELS)[number], Record<string, readonly [number, number]>> = {
  'dat12-alpha': {
    input: [3, 3.3],
    output: [15, 16.5],
    cache_read: [0.3, 0.33],
    cache_write_5m: [3.75, 4.125],
    cache_write_1h: [6, 6.6],
  },
  'dat12-beta': {
    input: [0.8, 1.1],
    output: [4, 5.5],
    cache_read: [0.08, 0.11],
    cache_write_5m: [1, 1.375],
    cache_write_1h: [1.6, 2.2],
  },
};

function seedRates(db: TempDb['db']): void {
  const insert = db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
  );
  for (const model of MODELS) {
    for (const [bucket, [before, after]] of Object.entries(RATES[model])) {
      insert.run(model, bucket, before, '2026-01-01T00:00:00.000Z');
      insert.run(model, bucket, after, REPRICE_AT);
    }
  }
}

/**
 * Every rate the oracle has converted, keyed by the rate itself. There are only
 * twenty, and checking each once keeps a horizon of 100,000 terms from spending
 * its time on 100,000 identical assertions (QA-FLAKE-1).
 */
const microRates = new Map<number, bigint>();

/** Rate as an exact integer of micro-dollars per Mtok; refuses a rate with more than six decimals. */
function microRate(model: string, bucket: string, timestamp: string): bigint {
  const pair = RATES[model as (typeof MODELS)[number]][bucket]!;
  const rate = timestamp >= REPRICE_AT ? pair[1] : pair[0];
  const known = microRates.get(rate);
  if (known !== undefined) {
    return known;
  }
  const micro = Math.round(rate * 1e6);
  expect(Math.abs(rate * 1e6 - micro)).toBeLessThan(1e-6);
  microRates.set(rate, BigInt(micro));
  return BigInt(micro);
}

interface Usage {
  readonly session: number;
  readonly model: (typeof MODELS)[number];
  readonly day: number;
  readonly tokens: readonly [number, number, number, number, number];
}

function toDeduped(usages: readonly Usage[]): Map<string, DedupedUsage[]> {
  const bySession = new Map<string, DedupedUsage[]>();
  usages.forEach((u, i) => {
    const sessionId = `dat12-session-${String(u.session)}`;
    const timestamp = new Date(Date.UTC(2026, 8, 1) + u.day * 86_400_000 + i).toISOString();
    const usage = Object.fromEntries(
      BUCKET_KEYS.map(([key], b) => [key, u.tokens[b]!]),
    ) as unknown as TokenBuckets;
    const list = bySession.get(sessionId) ?? [];
    list.push({ messageId: `msg-${String(i)}`, model: u.model, timestamp, usage, agentId: null });
    bySession.set(sessionId, list);
  });
  return bySession;
}

interface Measured {
  readonly gateUsd: number;
  readonly apiUsd: number;
  readonly exactPico: bigint;
  readonly gateTerms: number;
  readonly apiTerms: number;
}

function measure(tmp: TempDb, usages: readonly Usage[]): Measured {
  const { db } = tmp;
  seedRates(db);
  const bySession = toDeduped(usages);
  const all: DedupedUsage[] = [];
  for (const [sessionId, entries] of bySession) {
    insertSession(db, sessionId);
    insertTokenUsageRows(db, sessionId, entries);
    all.push(...entries);
  }
  const pricing: readonly PricingEntry[] = loadPricing(db);
  const gate = priceUsage(all, pricing);
  expect(gate.unpricedTokens).toBe(0);

  let exactPico = 0n;
  let gateTerms = 0;
  for (const entry of all) {
    for (const [key, bucket] of BUCKET_KEYS) {
      const tokens = entry.usage[key];
      if (tokens === 0) {
        continue;
      }
      gateTerms += 1;
      exactPico += BigInt(tokens) * microRate(entry.model, bucket, entry.timestamp);
    }
  }
  const apiTerms = db.prepare('SELECT COUNT(*) FROM token_usage_rollup').pluck().get() as number;
  const summary = getCostSummary(db, 10);
  expect(summary.totals.unpricedTokens).toBe(0);
  return { gateUsd: gate.costUsd, apiUsd: summary.totals.costUsd, exactPico, gateTerms, apiTerms };
}

function boundUsd(terms: number, exactUsd: number): number {
  return (terms + 4) * UNIT_ROUNDOFF * exactUsd;
}

/** Distance, in pico-dollars, from the exact total to the nearest half-cent rounding boundary. */
function picoToHalfCent(exactPico: bigint): bigint {
  const rem = exactPico % CENT_PICO;
  return rem >= HALF_CENT_PICO ? rem - HALF_CENT_PICO : HALF_CENT_PICO - rem;
}

function assertRule(m: Measured): void {
  const exactUsd = Number(m.exactPico) / Number(PICO_PER_USD);
  const gateBound = boundUsd(m.gateTerms, exactUsd);
  const apiBound = boundUsd(m.apiTerms, exactUsd);
  // Rule 2: each path is within its own bound of the exact total ...
  expect(Math.abs(m.gateUsd - exactUsd)).toBeLessThanOrEqual(gateBound);
  expect(Math.abs(m.apiUsd - exactUsd)).toBeLessThanOrEqual(apiBound);
  // ... so the two are within the sum of the bounds of each other.
  expect(Math.abs(m.gateUsd - m.apiUsd)).toBeLessThanOrEqual(gateBound + apiBound);
  // Rule 3: same cents unless the exact total sits on a half-cent within the bound.
  const nearBoundaryPico = BigInt(Math.ceil((gateBound + apiBound) * 1e12)) + 1n;
  if (picoToHalfCent(m.exactPico) > nearBoundaryPico) {
    expect(m.apiUsd.toFixed(2)).toBe(m.gateUsd.toFixed(2));
  }
}

const temps: TempDb[] = [];
afterEach(() => {
  for (const tmp of temps.splice(0)) {
    tmp.cleanup();
  }
});

function freshDb(): TempDb {
  const tmp = createMigratedTempDb();
  temps.push(tmp);
  return tmp;
}

const tokenCount = fc.oneof(
  { weight: 2, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 5000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 5_000_000 }) },
);
const usageArb: fc.Arbitrary<Usage> = fc.record({
  session: fc.integer({ min: 0, max: 3 }),
  model: fc.constantFrom(...MODELS),
  day: fc.integer({ min: 0, max: 59 }),
  tokens: fc.tuple(tokenCount, tokenCount, tokenCount, tokenCount, tokenCount),
});

describe('money rounding rule: gate vs API (DAT-12)', () => {
  it('both paths stay within the float bound of the exact total, on any usage', () => {
    fc.assert(
      fc.property(fc.array(usageArb, { minLength: 1, maxLength: 300 }), (usages) => {
        const tmp = freshDb();
        try {
          assertRule(measure(tmp, usages));
        } finally {
          tmp.cleanup();
          temps.splice(temps.indexOf(tmp), 1);
        }
      }),
      { numRuns: 40 },
    );
  });

  // The horizon IS the point - float drift lives in long sums - so it is not
  // shrunk to fit the suite's 60 s default. The work is fixed (a seeded LCG);
  // only wall-clock time varies, and most of it is the real write path landing
  // 100,000 token_usage rows. About 18 s alone at load 55, 75.6 s inside the
  // full suite at load 76 (2026-11-20 rehearsal), so this case gets its own
  // ceiling with room above that (QA-FLAKE-1).
  it(
    'holds over a long horizon: 20,000 messages, four sessions, sixty days',
    { timeout: 240_000 },
    () => {
      // A fixed LCG, so this case is the same on every run.
      let state = 0x2545f491;
      const next = (mod: number): number => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state % mod;
      };
      const usages: Usage[] = Array.from({ length: 20_000 }, () => ({
        session: next(4),
        model: MODELS[next(2)]!,
        day: next(60),
        tokens: [next(20_000), next(4_000), next(2_000_000), next(60_000), next(30_000)],
      }));
      const m = measure(freshDb(), usages);
      assertRule(m);
      // Big enough to be a real long-horizon total, and the two paths really are
      // different sums: far fewer rollup groups than gate terms.
      expect(Number(m.exactPico / PICO_PER_USD)).toBeGreaterThan(1000);
      expect(m.apiTerms).toBeLessThan(m.gateTerms / 10);
    },
  );

  it('flags a path that rounds early: per-term rounding to the cent breaks the bound', () => {
    // The guard rail for rule 1: a "helpful" Math.round(x * 100) / 100 on each
    // term would drift by up to half a cent per term, far outside the bound.
    const usages: Usage[] = Array.from({ length: 200 }, (_, i) => ({
      session: i % 2,
      model: MODELS[i % 2]!,
      day: i % 60,
      tokens: [1234, 567, 0, 0, 0],
    }));
    const tmp = freshDb();
    const m = measure(tmp, usages);
    assertRule(m);
    let roundedEarly = 0;
    for (const entries of toDeduped(usages).values()) {
      for (const entry of entries) {
        const one = priceUsage([entry], loadPricing(tmp.db)).costUsd;
        roundedEarly += Math.round(one * 100) / 100;
      }
    }
    const exactUsd = Number(m.exactPico) / Number(PICO_PER_USD);
    expect(Math.abs(roundedEarly - exactUsd)).toBeGreaterThan(boundUsd(m.gateTerms, exactUsd));
  });
});
