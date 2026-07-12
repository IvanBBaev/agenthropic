import { describe, expect, it } from 'vitest';
import { computeCostUsd, dedupeUsageByMessageId, PricingError } from '../src/index';
import type { DedupedUsage, PricingEntry, TokenBuckets } from '../src/index';

const EPOCH = '2020-01-01T00:00:00.000Z';

/** List-style seed for a fictional model: $3/$15 per MTok, cache-read x0.1, write x1.25 / x2.0. */
function sonnetPricing(effectiveFrom: string = EPOCH): PricingEntry[] {
  return [
    { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: 3, effectiveFrom },
    { model: 'claude-sonnet-5', bucket: 'output', usdPerMtok: 15, effectiveFrom },
    { model: 'claude-sonnet-5', bucket: 'cache_read', usdPerMtok: 0.3, effectiveFrom },
    { model: 'claude-sonnet-5', bucket: 'cache_write_5m', usdPerMtok: 3.75, effectiveFrom },
    { model: 'claude-sonnet-5', bucket: 'cache_write_1h', usdPerMtok: 6, effectiveFrom },
  ];
}

function usage(
  overrides: Partial<DedupedUsage> = {},
  buckets: Partial<TokenBuckets> = {},
): DedupedUsage {
  return {
    messageId: 'msg_001',
    model: 'claude-sonnet-5',
    timestamp: '2026-07-10T12:00:00.000Z',
    agentId: null,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      ...buckets,
    },
    ...overrides,
  };
}

describe('computeCostUsd', () => {
  it('returns 0 for empty usage', () => {
    expect(computeCostUsd([], sonnetPricing())).toBe(0);
  });

  it('computes a hand-checked per-bucket total for one message', () => {
    // 1 MTok input ($3) + 0.2 MTok output ($3) + 10 MTok cache-read ($3)
    // + 0.4 MTok cache-write-5m ($1.50) + 0.5 MTok cache-write-1h ($3) = $13.50
    const entry = usage(
      {},
      {
        input: 1_000_000,
        output: 200_000,
        cacheRead: 10_000_000,
        cacheWrite5m: 400_000,
        cacheWrite1h: 500_000,
      },
    );
    expect(computeCostUsd([entry], sonnetPricing())).toBeCloseTo(13.5, 10);
  });

  it('sums across messages and models', () => {
    const pricing: PricingEntry[] = [
      ...sonnetPricing(),
      { model: 'claude-haiku-4-5', bucket: 'input', usdPerMtok: 1, effectiveFrom: EPOCH },
      { model: 'claude-haiku-4-5', bucket: 'output', usdPerMtok: 5, effectiveFrom: EPOCH },
    ];
    const entries = [
      usage({ messageId: 'm1' }, { input: 2_000_000 }), // $6.00
      usage(
        { messageId: 'm2', model: 'claude-haiku-4-5' },
        { input: 1_000_000, output: 1_000_000 },
      ), // $6.00
    ];
    expect(computeCostUsd(entries, pricing)).toBeCloseTo(12, 10);
  });

  it('resolves the OLD rate strictly before a price change and the NEW rate at/after (WP-C2)', () => {
    const changeAt = '2026-09-01T00:00:00.000Z';
    const pricing: PricingEntry[] = [
      { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: 2, effectiveFrom: EPOCH },
      { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: 3, effectiveFrom: changeAt },
    ];
    const oneMtokInput = (timestamp: string) =>
      computeCostUsd([usage({ timestamp }, { input: 1_000_000 })], pricing);

    expect(oneMtokInput('2026-08-31T23:59:59.999Z')).toBeCloseTo(2, 10); // old rate before
    expect(oneMtokInput(changeAt)).toBeCloseTo(3, 10); // new rate exactly at
    expect(oneMtokInput('2026-10-01T00:00:00.000Z')).toBeCloseTo(3, 10); // new rate after
  });

  it('picks the latest applicable row regardless of pricing-table order', () => {
    const pricing: PricingEntry[] = [
      {
        model: 'claude-sonnet-5',
        bucket: 'input',
        usdPerMtok: 5,
        effectiveFrom: '2026-06-01T00:00:00Z',
      },
      { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: 2, effectiveFrom: EPOCH },
      {
        model: 'claude-sonnet-5',
        bucket: 'input',
        usdPerMtok: 9,
        effectiveFrom: '2027-01-01T00:00:00Z',
      },
    ];
    const entry = usage({}, { input: 1_000_000 }); // 2026-07-10 -> the $5 row
    expect(computeCostUsd([entry], pricing)).toBeCloseTo(5, 10);
  });

  it('throws on an unknown model id — never silently prices at $0', () => {
    const entry = usage({ model: 'claude-unknown-99' }, { input: 1 });
    expect(() => computeCostUsd([entry], sonnetPricing())).toThrow(PricingError);
    expect(() => computeCostUsd([entry], sonnetPricing())).toThrow(/unknown model id/);
  });

  it('throws when a nonzero bucket has no price row for the model', () => {
    const pricing: PricingEntry[] = [
      { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: 3, effectiveFrom: EPOCH },
    ];
    const entry = usage({}, { input: 10, output: 10 });
    expect(() => computeCostUsd([entry], pricing)).toThrow(PricingError);
    expect(() => computeCostUsd([entry], pricing)).toThrow(/no price for bucket "output"/);
  });

  it('throws when no price row is effective yet at the usage timestamp', () => {
    const pricing: PricingEntry[] = [
      {
        model: 'claude-sonnet-5',
        bucket: 'input',
        usdPerMtok: 3,
        effectiveFrom: '2027-01-01T00:00:00Z',
      },
    ];
    const entry = usage({}, { input: 10 });
    expect(() => computeCostUsd([entry], pricing)).toThrow(/no price effective at/);
  });

  it('ignores zero-token buckets (they need no price row)', () => {
    const pricing: PricingEntry[] = [
      { model: 'claude-sonnet-5', bucket: 'output', usdPerMtok: 15, effectiveFrom: EPOCH },
    ];
    const entry = usage({}, { output: 100_000 });
    expect(computeCostUsd([entry], pricing)).toBeCloseTo(1.5, 10);
  });

  it('prices <synthetic> at $0 only via explicit seed rows, not via a fallback', () => {
    const syntheticSeed: PricingEntry[] = (
      ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const
    ).map((bucket) => ({ model: '<synthetic>', bucket, usdPerMtok: 0, effectiveFrom: EPOCH }));

    const entry = usage({ model: '<synthetic>' }, { input: 500, output: 500 });
    expect(computeCostUsd([entry], syntheticSeed)).toBe(0);
    // Without the seed rows the same entry must throw, proving no fallback exists.
    expect(() => computeCostUsd([entry], sonnetPricing())).toThrow(PricingError);
  });

  it('throws on a negative or non-finite pricing rate', () => {
    const bad: PricingEntry[] = [
      { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: -1, effectiveFrom: EPOCH },
    ];
    expect(() => computeCostUsd([], bad)).toThrow(PricingError);
    const nan: PricingEntry[] = [
      { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: Number.NaN, effectiveFrom: EPOCH },
    ];
    expect(() => computeCostUsd([], nan)).toThrow(/non-negative finite/);
  });

  it('throws on an unparsable pricing effectiveFrom', () => {
    const bad: PricingEntry[] = [
      { model: 'claude-sonnet-5', bucket: 'input', usdPerMtok: 3, effectiveFrom: 'not-a-date' },
    ];
    expect(() => computeCostUsd([], bad)).toThrow(RangeError);
  });

  it('throws on an unparsable usage timestamp', () => {
    const entry = usage({ timestamp: 'garbage' }, { input: 1 });
    expect(() => computeCostUsd([entry], sonnetPricing())).toThrow(/unparsable ISO-8601/);
  });

  it('dedupe -> cost pipeline: duplicated raw lines do not inflate the bill', () => {
    const raw = Array.from({ length: 3 }, () => ({
      messageId: 'msg_dup',
      model: 'claude-sonnet-5',
      timestamp: '2026-07-10T12:00:00.000Z',
      usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    }));
    const total = computeCostUsd(dedupeUsageByMessageId(raw), sonnetPricing());
    expect(total).toBeCloseTo(3, 10); // naive summation would report $9
  });
});
