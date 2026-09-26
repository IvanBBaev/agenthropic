import { afterEach, describe, expect, it } from 'vitest';
import { computeCostUsd, type DedupedUsage } from '@agenthropic/core';
import { loadPricing, upsertPricingRate } from '../src/db/pricing';
import { createMigratedTempDb, type TempDb } from './helpers';

/**
 * `upsertPricingRate` is the canonical write path for a rate, yet it
 * stored any number it was handed. A negative, infinite or NaN rate landed in
 * `model_pricing` silently, and the failure only surfaced later and elsewhere:
 * core's `computeCostUsd` refuses the WHOLE pricing table, so every model -
 * not just the corrupted one - stops pricing at ingest and in the cost routes.
 */
const opusInput = (temp: TempDb): unknown =>
  temp.db
    .prepare(
      "SELECT usd_per_mtok FROM model_pricing WHERE model = 'claude-opus-4-8' AND bucket = 'input'",
    )
    .all();

const usage = (model: string): DedupedUsage[] => [
  {
    messageId: 'msg-1',
    model,
    timestamp: '2026-07-12T00:00:00.000Z',
    agentId: null,
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  },
];

describe('upsertPricingRate rejects a rate that is not a finite non-negative number', () => {
  let temp: TempDb | undefined;

  afterEach(() => {
    temp?.cleanup();
    temp = undefined;
  });

  it.each([
    ['negative', -5],
    ['infinite', Number.POSITIVE_INFINITY],
    ['negative infinite', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('refuses a %s rate and writes nothing', (_label, rate) => {
    temp = createMigratedTempDb();
    const before = opusInput(temp);
    const count = (): unknown => temp!.db.prepare('SELECT COUNT(*) AS n FROM model_pricing').get();
    const countBefore = count();

    // A new dated row, and an in-place overwrite of the seeded row.
    expect(() =>
      upsertPricingRate(temp!.db, {
        model: 'claude-opus-4-8',
        bucket: 'input',
        usdPerMtok: rate,
        effectiveFrom: '2026-07-01',
      }),
    ).toThrow(/usd_per_mtok .* is not a finite, non-negative number/);
    const seeded = loadPricing(temp.db).find(
      (p) => p.model === 'claude-opus-4-8' && p.bucket === 'input',
    )!;
    expect(() => upsertPricingRate(temp!.db, { ...seeded, usdPerMtok: rate })).toThrow(
      /is not a finite, non-negative number/,
    );

    expect(count()).toEqual(countBefore);
    expect(opusInput(temp)).toEqual(before);
    // The table still prices every model.
    expect(computeCostUsd(usage('claude-haiku-4-5-20251001'), loadPricing(temp.db))).toBe(1);
  });

  it('still accepts a zero rate (free is a real price) and a positive update in place', () => {
    temp = createMigratedTempDb();
    upsertPricingRate(temp.db, {
      model: 'claude-opus-4-8',
      bucket: 'input',
      usdPerMtok: 0,
      effectiveFrom: '2026-07-01',
    });
    upsertPricingRate(temp.db, {
      model: 'claude-opus-4-8',
      bucket: 'input',
      usdPerMtok: 7,
      effectiveFrom: '2026-07-01T00:00:00Z',
    });
    expect(computeCostUsd(usage('claude-opus-4-8'), loadPricing(temp.db))).toBe(7);
  });
});
