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

  it('returns the full 25-row WP-C1 seed (5 models x 5 buckets)', () => {
    temp = createMigratedTempDb();
    const pricing = loadPricing(temp.db);
    expect(pricing).toHaveLength(25);
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
