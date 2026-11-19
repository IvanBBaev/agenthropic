/**
 * DAT-10 - the advisory pricing drift alarm: Claude Code's own dollar figure
 * against OUR dated rates applied to ITS OWN token counts.
 */
import { describe, expect, it } from 'vitest';
import {
  COST_STATE_TOLERANCE,
  COST_STATE_VERDICTS,
  PricingError,
  reconcileCostState,
  type CostStateModelUsage,
  type CostStateSnapshot,
  type ModelCostStateReconciliation,
  type PricingEntry,
} from '../src/index';

const EPOCH = '2020-01-01T00:00:00.000Z';
const SPAN = {
  fromMs: Date.parse('2026-03-01T00:00:00.000Z'),
  toMs: Date.parse('2026-03-01T02:00:00.000Z'),
};

function sonnetPricing(effectiveFrom: string = EPOCH): PricingEntry[] {
  return [
    { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: 3, effectiveFrom },
    { model: 'claude-sonnet-5', bucket: 'output', usdPerMtok: 15, effectiveFrom },
    { model: 'claude-sonnet-5', bucket: 'cache_read', usdPerMtok: 0.3, effectiveFrom },
    { model: 'claude-sonnet-5', bucket: 'cache_write_5m', usdPerMtok: 3.75, effectiveFrom },
    { model: 'claude-sonnet-5', bucket: 'cache_write_1h', usdPerMtok: 6, effectiveFrom },
  ];
}

/** 10 in, 20 out, 30 read, 25 5m + 15 1h writes - $522.75 per million of these sets. */
const EXACT_USD = (10 * 3 + 20 * 15 + 30 * 0.3 + 25 * 3.75 + 15 * 6) / 1_000_000;

function usage(overrides: Partial<CostStateModelUsage> = {}): CostStateModelUsage {
  return {
    model: 'claude-sonnet-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: 30,
    cacheCreationInputTokens: 40,
    cacheCreation5mInputTokens: 25,
    cacheCreation1hInputTokens: 15,
    webSearchRequests: 0,
    costUsd: EXACT_USD,
    ...overrides,
  };
}

function snapshot(
  models: CostStateModelUsage[] = [usage()],
  hasUnknownModelCost = false,
): CostStateSnapshot {
  return {
    totalCostUsd: models.reduce((sum, m) => sum + m.costUsd, 0),
    hasUnknownModelCost,
    models,
  };
}

function only(
  models: CostStateModelUsage[],
  pricing = sonnetPricing(),
  span = SPAN,
): ModelCostStateReconciliation {
  const [model, ...rest] = reconcileCostState(snapshot(models), pricing, span).models;
  if (model === undefined || rest.length > 0) throw new Error('expected exactly one model');
  return model;
}

describe('reconcileCostState', () => {
  it('lists the verdicts worst first and pins the default tolerance', () => {
    expect(COST_STATE_VERDICTS).toEqual(['drift', 'unpriced', 'unverifiable', 'in-band']);
    expect(COST_STATE_TOLERANCE).toBe(1e-6);
  });

  it('reads an exactly matching figure as in-band with a zero-width band', () => {
    const result = reconcileCostState(snapshot(), sonnetPricing(), SPAN);
    expect(result).toEqual({
      verdict: 'in-band',
      reason: null,
      reportedUsd: EXACT_USD,
      models: [
        {
          model: 'claude-sonnet-5',
          verdict: 'in-band',
          reason: null,
          reportedUsd: EXACT_USD,
          computedLowUsd: EXACT_USD,
          computedHighUsd: EXACT_USD,
        },
      ],
    });
  });

  it('bounds unsplit cache writes by the cheaper and the dearer TTL', () => {
    const base = (10 * 3 + 20 * 15 + 30 * 0.3) / 1_000_000;
    const unsplit = usage({ cacheCreation5mInputTokens: null, cacheCreation1hInputTokens: null });
    const low = base + (40 * 3.75) / 1_000_000;
    const high = base + (40 * 6) / 1_000_000;
    for (const costUsd of [low, high, (low + high) / 2]) {
      const model = only([{ ...unsplit, costUsd }]);
      expect(model.verdict).toBe('in-band');
      expect(model.computedLowUsd).toBeCloseTo(low, 12);
      expect(model.computedHighUsd).toBeCloseTo(high, 12);
    }
  });

  it('prices only the unsplit remainder of a partially split write at both TTLs', () => {
    const partial = usage({ cacheCreationInputTokens: 50 }); // 25 + 15 split, 10 unsplit
    const model = only([partial]);
    expect(model.computedLowUsd).toBeCloseTo(EXACT_USD + (10 * 3.75) / 1_000_000, 12);
    expect(model.computedHighUsd).toBeCloseTo(EXACT_USD + (10 * 6) / 1_000_000, 12);
    expect(model.verdict).toBe('drift'); // the exact figure sits below the 10-token floor
  });

  it('flags a figure above or below the band as drift', () => {
    expect(only([usage({ costUsd: EXACT_USD * 1.01 })]).verdict).toBe('drift');
    expect(only([usage({ costUsd: EXACT_USD * 0.99 })]).verdict).toBe('drift');
  });

  it('absorbs float noise within the relative tolerance, and honours a custom one', () => {
    expect(only([usage({ costUsd: EXACT_USD * (1 + 1e-7) })]).verdict).toBe('in-band');
    expect(only([usage({ costUsd: EXACT_USD * (1 - 1e-7) })]).verdict).toBe('in-band');
    const loose = reconcileCostState(
      snapshot([usage({ costUsd: EXACT_USD * 1.05 })]),
      sonnetPricing(),
      SPAN,
      0.1,
    );
    expect(loose.verdict).toBe('in-band');
  });

  it('reads a model with no tokens and no cost as in-band', () => {
    const empty = usage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      costUsd: 0,
    });
    const model = only([empty]);
    expect(model).toMatchObject({ verdict: 'in-band', computedLowUsd: 0, computedHighUsd: 0 });
  });

  it('widens the band by every rate in force during the span', () => {
    const repriced: PricingEntry[] = [
      ...sonnetPricing(),
      {
        model: 'claude-sonnet-5',
        bucket: 'input',
        usdPerMtok: 6,
        effectiveFrom: '2026-03-01T01:00:00.000Z',
      },
    ];
    const model = only([usage()], repriced);
    expect(model.verdict).toBe('in-band');
    expect(model.computedLowUsd).toBeCloseTo(EXACT_USD, 12);
    expect(model.computedHighUsd).toBeCloseTo(EXACT_USD + (10 * 3) / 1_000_000, 12);
  });

  it('ignores a reprice that took effect after the span ended', () => {
    const later: PricingEntry[] = [
      ...sonnetPricing(),
      {
        model: 'claude-sonnet-5',
        bucket: 'input',
        usdPerMtok: 6,
        effectiveFrom: '2026-04-01T00:00:00.000Z',
      },
    ];
    expect(only([usage()], later)).toMatchObject({
      computedLowUsd: EXACT_USD,
      computedHighUsd: EXACT_USD,
    });
  });

  it('reads a model with no price row as unpriced', () => {
    const model = only([usage({ model: 'claude-unknown-9' })]);
    expect(model).toEqual({
      model: 'claude-unknown-9',
      verdict: 'unpriced',
      reason: null,
      reportedUsd: EXACT_USD,
      computedLowUsd: null,
      computedHighUsd: null,
    });
  });

  it('reads a used bucket with no rate as unpriced, an unused one as fine', () => {
    const noRead = sonnetPricing().filter((entry) => entry.bucket !== 'cache_read');
    expect(only([usage()], noRead).verdict).toBe('unpriced');
    expect(
      only([usage({ cacheReadInputTokens: 0, costUsd: EXACT_USD - 9e-6 })], noRead).verdict,
    ).toBe('in-band');
  });

  it('reads an unsplit remainder as unpriced when either TTL has no rate', () => {
    const unsplit = usage({ cacheCreation5mInputTokens: null, cacheCreation1hInputTokens: null });
    for (const bucket of ['cache_write_5m', 'cache_write_1h']) {
      const pricing = sonnetPricing().filter((entry) => entry.bucket !== bucket);
      expect(only([unsplit], pricing).verdict, bucket).toBe('unpriced');
    }
  });

  it('reads a span that starts before the first rate as unpriced', () => {
    expect(only([usage()], sonnetPricing('2026-03-01T01:00:00.000Z')).verdict).toBe('unpriced');
  });

  it('reads a 5m/1h split larger than the total as unverifiable', () => {
    expect(only([usage({ cacheCreationInputTokens: 30 })])).toEqual({
      model: 'claude-sonnet-5',
      verdict: 'unverifiable',
      reason: 'cache-split-exceeds-total',
      reportedUsd: EXACT_USD,
      computedLowUsd: null,
      computedHighUsd: null,
    });
  });

  it('reads web-search requests as unverifiable above the floor, drift below it', () => {
    const withSearch = usage({ webSearchRequests: 3, costUsd: EXACT_USD + 0.03 });
    expect(only([withSearch])).toMatchObject({
      verdict: 'unverifiable',
      reason: 'web-search-requests',
      computedLowUsd: EXACT_USD,
      computedHighUsd: EXACT_USD,
    });
    expect(only([usage({ webSearchRequests: 3, costUsd: EXACT_USD / 2 })])).toMatchObject({
      verdict: 'drift',
      reason: 'web-search-requests',
    });
  });

  it('takes the worst model verdict for the session', () => {
    const result = reconcileCostState(
      snapshot([usage(), usage({ model: 'claude-unknown-9' }), usage({ costUsd: 1 })]),
      sonnetPricing(),
      SPAN,
    );
    expect(result.verdict).toBe('drift');
    expect(result.models.map((m) => m.verdict)).toEqual(['in-band', 'unpriced', 'drift']);
    expect(reconcileCostState(snapshot([]), sonnetPricing(), SPAN)).toEqual({
      verdict: 'in-band',
      reason: null,
      reportedUsd: 0,
      models: [],
    });
  });

  it("raises an in-band session to unverifiable on Claude Code's own unknown-cost flag", () => {
    expect(reconcileCostState(snapshot([usage()], true), sonnetPricing(), SPAN)).toMatchObject({
      verdict: 'unverifiable',
      reason: 'unknown-model-cost',
    });
    const drifted = reconcileCostState(
      snapshot([usage({ costUsd: 1 })], true),
      sonnetPricing(),
      SPAN,
    );
    expect(drifted).toMatchObject({ verdict: 'drift', reason: null });
  });

  it('accepts a zero-length span', () => {
    const instant = { fromMs: SPAN.fromMs, toMs: SPAN.fromMs };
    expect(reconcileCostState(snapshot(), sonnetPricing(), instant).verdict).toBe('in-band');
  });

  it.each([
    ['a NaN start', { fromMs: Number.NaN, toMs: SPAN.toMs }],
    ['an infinite end', { fromMs: SPAN.fromMs, toMs: Number.POSITIVE_INFINITY }],
    ['an inverted span', { fromMs: SPAN.toMs, toMs: SPAN.fromMs }],
  ])('throws RangeError on %s', (_label, span) => {
    expect(() => reconcileCostState(snapshot(), sonnetPricing(), span)).toThrow(RangeError);
  });

  it.each([Number.NaN, -0.1, Number.POSITIVE_INFINITY])(
    'throws RangeError on tolerance %s',
    (tolerance) => {
      expect(() => reconcileCostState(snapshot(), sonnetPricing(), SPAN, tolerance)).toThrow(
        RangeError,
      );
    },
  );

  it('throws PricingError on a malformed price table, like the ledger', () => {
    const bad: PricingEntry[] = sonnetPricing().map((entry) => ({ ...entry, usdPerMtok: -1 }));
    expect(() => reconcileCostState(snapshot(), bad, SPAN)).toThrow(PricingError);
  });
});
