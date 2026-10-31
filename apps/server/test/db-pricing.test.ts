import { afterEach, describe, expect, it } from 'vitest';
import { computeCostUsd, type DedupedUsage } from '@agenthropic/core';
import { loadPricing } from '../src/db/pricing';
import { createMigratedTempDb, type TempDb } from './helpers';

describe('loadPricing (WP-C1 seed read path)', () => {
  let temp: TempDb | undefined;

  afterEach(() => {
    temp?.cleanup();
    temp = undefined;
  });

  it('returns the full 50-row table (5 seed models + 2 from migration 18 + 1 each from migrations 19, 24 and 25, x 5 buckets)', () => {
    temp = createMigratedTempDb();
    const pricing = loadPricing(temp.db);
    expect(pricing).toHaveLength(50);
  });

  it('prices a claude-haiku-5-5 message up to 100k prompt tokens and halts one over (migration 25, D1)', () => {
    // The corpus carries 16 such records, every prompt <= 100k. Only the base
    // tier is seeded, so a longer prompt must halt rather than price at it.
    temp = createMigratedTempDb();
    const pricing = loadPricing(temp.db);
    const atLimit: DedupedUsage = {
      messageId: 'msg-haiku-5-5',
      model: 'claude-haiku-5-5',
      timestamp: '2026-10-29T00:00:00.000Z',
      agentId: null,
      usage: {
        input: 20_000,
        output: 40_000,
        cacheRead: 60_000,
        cacheWrite5m: 16_000,
        cacheWrite1h: 4_000,
      },
    };
    // 20k input @ $0.10 + 40k output @ $0.50 + 60k cache_read @ $0.01
    // + 16k 5m write @ $0.125 + 4k 1h write @ $0.20
    // = 0.002 + 0.02 + 0.0006 + 0.002 + 0.0008 = 0.0254.
    expect(computeCostUsd([atLimit], pricing)).toBeCloseTo(0.0254, 12);
    expect(() =>
      computeCostUsd(
        [{ ...atLimit, usage: { ...atLimit.usage, cacheRead: atLimit.usage.cacheRead + 1 } }],
        pricing,
      ),
    ).toThrow(/exceeds the 100000-token base tier/);
  });

  it('prices a claude-opus-5-5 message instead of halting on an unknown model id (migration 19)', () => {
    // The 2026-09-26 real-corpus boot parked 27 of 61 sessions on exactly this
    // id. The gate itself is untouched (a model with no row still throws); the
    // cure is the row, and this is the read-path proof that the row is there.
    temp = createMigratedTempDb();
    const pricing = loadPricing(temp.db);
    const usage: DedupedUsage[] = [
      {
        messageId: 'msg-opus-5-5',
        model: 'claude-opus-5-5',
        timestamp: '2026-09-26T00:00:00.000Z',
        agentId: null,
        usage: {
          input: 1_000_000,
          output: 100_000,
          cacheRead: 5_000_000,
          cacheWrite5m: 1_000_000,
          cacheWrite1h: 500_000,
        },
      },
    ];
    // 1M input @ $4 + 100k output @ $20 + 5M cache_read @ $0.2 + 1M 5m write @ $5
    // + 500k 1h write @ $8 = 4 + 2 + 1 + 5 + 4 = 16.
    expect(computeCostUsd(usage, pricing)).toBeCloseTo(16, 10);
    expect(() => computeCostUsd([{ ...usage[0]!, model: 'claude-opus-5-6' }], pricing)).toThrow(
      /unknown model id/,
    );
  });

  it('carries the seeded claude-opus-4-8 input and derived cache_read rates', () => {
    temp = createMigratedTempDb();
    const pricing = loadPricing(temp.db);

    const input = pricing.find((p) => p.model === 'claude-opus-4-8' && p.bucket === 'input');
    expect(input?.usdPerMtok).toBe(5);

    // cache_read is seeded as 0.1 x input (5 -> 0.5).
    const cacheRead = pricing.find(
      (p) => p.model === 'claude-opus-4-8' && p.bucket === 'cache_read',
    );
    expect(cacheRead?.usdPerMtok).toBe(0.5);
  });

  it('maps every row to the camelCase PricingEntry shape', () => {
    temp = createMigratedTempDb();
    const pricing = loadPricing(temp.db);

    for (const entry of pricing) {
      expect(Object.keys(entry).sort()).toEqual(
        ['bucket', 'effectiveFrom', 'model', 'usdPerMtok'].sort(),
      );
      expect(typeof entry.model).toBe('string');
      expect(typeof entry.bucket).toBe('string');
      expect(typeof entry.usdPerMtok).toBe('number');
      expect(typeof entry.effectiveFrom).toBe('string');
    }
  });

  it('feeds computeCostUsd to yield a finite cost', () => {
    temp = createMigratedTempDb();
    const pricing = loadPricing(temp.db);

    const usage: DedupedUsage[] = [
      {
        messageId: 'msg-1',
        model: 'claude-opus-4-8',
        timestamp: '2026-07-12T00:00:00.000Z',
        agentId: null,
        usage: {
          input: 1_000_000,
          output: 200_000,
          cacheRead: 4_000_000,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        },
      },
    ];

    const cost = computeCostUsd(usage, pricing);
    expect(Number.isFinite(cost)).toBe(true);
    // 1M input @ $5 + 200k output @ $25 + 4M cache_read @ $0.5 = 5 + 5 + 2 = 12.
    expect(cost).toBeCloseTo(12, 10);
  });
});
