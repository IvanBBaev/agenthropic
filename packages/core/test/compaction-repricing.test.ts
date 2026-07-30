/**
 * Tests for WP-C4 compaction-aware repricing.
 *
 * Coverage strategy:
 * - The Phase-3 exit-gate invariant ("PreCompact reprices vs baseline"):
 *   `repricedUsd` must reconcile with `naiveUsd` (delta ~0) on a complete
 *   substrate, for zero, one and multiple boundaries.
 * - Segmentation semantics: per-transcript cuts (compaction mid-agent leaves
 *   the main stream whole), boundary-timestamp tie goes to the new segment,
 *   empty segments stay visible, `preTokens` baselines are carried through.
 * - Loud failures: unknown model still throws `PricingError` (never $0),
 *   unparsable boundary timestamps throw.
 * - End-to-end: parseSession + extractCompactionBoundaries on the
 *   task-notification-recovery fixture (the corpus compaction pathology).
 */
import { describe, expect, it } from 'vitest';
import {
  computeCompactionAwareCost,
  computeCostUsd,
  extractCompactionBoundaries,
  parseSession,
  PricingError,
} from '../src/index';
import type {
  CompactionBoundary,
  CompactionRepricingResult,
  DedupedUsage,
  PricingEntry,
  TokenBuckets,
} from '../src/index';
import { getFixture } from '@agenthropic/test-fixtures';

const EPOCH = '2020-01-01T00:00:00.000Z';

/** Flat synthetic price card: $2/MTok input, $10/MTok output, $0.2/MTok cache-read. */
function pricing(model = 'model-a'): PricingEntry[] {
  return [
    { model, bucket: 'input', usdPerMtok: 2, effectiveFrom: EPOCH },
    { model, bucket: 'output', usdPerMtok: 10, effectiveFrom: EPOCH },
    { model, bucket: 'cache_read', usdPerMtok: 0.2, effectiveFrom: EPOCH },
    { model, bucket: 'cache_write_5m', usdPerMtok: 2.5, effectiveFrom: EPOCH },
    { model, bucket: 'cache_write_1h', usdPerMtok: 4, effectiveFrom: EPOCH },
  ];
}

function usage(
  messageId: string,
  timestamp: string,
  buckets: Partial<TokenBuckets> = {},
  overrides: Partial<DedupedUsage> = {},
): DedupedUsage {
  return {
    messageId,
    model: 'model-a',
    timestamp,
    agentId: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...buckets },
    ...overrides,
  };
}

function boundary(
  timestamp: string,
  overrides: Partial<CompactionBoundary> = {},
): CompactionBoundary {
  return { agentId: null, timestamp, trigger: 'auto', preTokens: 100_000, ...overrides };
}

function segmentsFor(result: CompactionRepricingResult, agentId: string | null) {
  return result.segments.filter((s) => s.agentId === agentId);
}

describe('computeCompactionAwareCost — zero compactions', () => {
  it('returns all-zero totals and no segments for empty usage and no boundaries', () => {
    const result = computeCompactionAwareCost([], [], pricing());
    expect(result).toEqual({
      naiveUsd: 0,
      repricedUsd: 0,
      deltaUsd: 0,
      compactionCount: 0,
      segments: [],
    });
  });

  it('emits one boundary-less segment per transcript, repriced == naive', () => {
    const rows = [
      usage('m1', '2026-03-01T10:00:00Z', { input: 1_000_000 }), // $2
      usage('m2', '2026-03-01T10:01:00Z', { output: 100_000 }), // $1
      usage('a1', '2026-03-01T10:02:00Z', { cacheRead: 5_000_000 }, { agentId: 'beef0001' }), // $1
    ];
    const result = computeCompactionAwareCost(rows, [], pricing());

    expect(result.naiveUsd).toBeCloseTo(4, 10);
    expect(result.repricedUsd).toBeCloseTo(result.naiveUsd, 10);
    expect(result.deltaUsd).toBeCloseTo(0, 10);
    expect(result.compactionCount).toBe(0);
    expect(result.segments).toHaveLength(2);

    const [main, agent] = result.segments;
    expect(main).toMatchObject({ agentId: null, index: 0, boundary: null, messageCount: 2 });
    expect(main!.usd).toBeCloseTo(3, 10);
    expect(agent).toMatchObject({ agentId: 'beef0001', index: 0, boundary: null, messageCount: 1 });
    expect(agent!.usd).toBeCloseTo(1, 10);
  });
});

describe('computeCompactionAwareCost — single boundary', () => {
  const rows = [
    usage('m1', '2026-03-01T10:00:00Z', { input: 1_000_000 }), // $2  pre
    usage('m2', '2026-03-01T11:00:00Z', { output: 200_000 }), // $2  exactly at the boundary -> post
    usage('m3', '2026-03-01T12:00:00Z', { cacheRead: 10_000_000 }), // $2  post
  ];
  const cut = boundary('2026-03-01T11:00:00Z', { preTokens: 165_000 });

  it('splits the stream at the boundary; a row exactly at the boundary opens the new segment', () => {
    const result = computeCompactionAwareCost(rows, [cut], pricing());

    expect(result.compactionCount).toBe(1);
    const mainSegments = segmentsFor(result, null);
    expect(mainSegments).toHaveLength(2);

    const [pre, post] = mainSegments;
    expect(pre).toMatchObject({ index: 0, boundary: null, messageCount: 1 });
    expect(pre!.usd).toBeCloseTo(2, 10);
    expect(pre!.tokens.input).toBe(1_000_000);

    expect(post).toMatchObject({ index: 1, messageCount: 2 });
    expect(post!.boundary).toEqual(cut); // preserved preTokens baseline is carried through
    expect(post!.usd).toBeCloseTo(4, 10);
    expect(post!.tokens.output).toBe(200_000);
    expect(post!.tokens.cacheRead).toBe(10_000_000);
  });

  it('PreCompact reprices vs baseline: repriced reconciles with naive on a complete substrate', () => {
    const result = computeCompactionAwareCost(rows, [cut], pricing());
    expect(result.naiveUsd).toBeCloseTo(computeCostUsd(rows, pricing()), 12);
    expect(result.repricedUsd).toBeCloseTo(result.naiveUsd, 9);
    expect(Math.abs(result.deltaUsd)).toBeLessThan(1e-9);
  });

  it('a boundary mid-agent cuts only that agent stream, never the main one', () => {
    const mixed = [
      usage('m1', '2026-03-01T10:00:00Z', { input: 1_000_000 }),
      usage('m2', '2026-03-01T12:00:00Z', { input: 1_000_000 }),
      usage('a1', '2026-03-01T10:30:00Z', { output: 100_000 }, { agentId: 'beef0001' }),
      usage('a2', '2026-03-01T11:30:00Z', { output: 100_000 }, { agentId: 'beef0001' }),
    ];
    const agentCut = boundary('2026-03-01T11:00:00Z', { agentId: 'beef0001', preTokens: 50_000 });
    const result = computeCompactionAwareCost(mixed, [agentCut], pricing());

    const mainSegments = segmentsFor(result, null);
    expect(mainSegments).toHaveLength(1); // main stream stays whole
    expect(mainSegments[0]!.messageCount).toBe(2);

    const agentSegments = segmentsFor(result, 'beef0001');
    expect(agentSegments).toHaveLength(2);
    expect(agentSegments.map((s) => s.messageCount)).toEqual([1, 1]);
    expect(agentSegments[1]!.boundary?.preTokens).toBe(50_000);
    expect(result.deltaUsd).toBeCloseTo(0, 10);
  });
});

describe('computeCompactionAwareCost — multiple resets', () => {
  it('emits boundaryCount + 1 segments, keeping empty middle segments visible', () => {
    const rows = [
      usage('m1', '2026-03-01T10:00:00Z', { input: 500_000 }), // segment 0
      usage('m2', '2026-03-01T13:00:00Z', { input: 500_000 }), // segment 2
    ];
    const cuts = [
      boundary('2026-03-01T11:00:00Z', { preTokens: 111 }),
      boundary('2026-03-01T12:00:00Z', { preTokens: 222 }),
    ];
    const result = computeCompactionAwareCost(rows, cuts, pricing());

    expect(result.compactionCount).toBe(2);
    const mainSegments = segmentsFor(result, null);
    expect(mainSegments).toHaveLength(3);
    expect(mainSegments.map((s) => s.messageCount)).toEqual([1, 0, 1]);
    expect(mainSegments[1]!.usd).toBe(0);
    expect(mainSegments[1]!.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(mainSegments.map((s) => s.boundary?.preTokens ?? null)).toEqual([null, 111, 222]);
    expect(result.deltaUsd).toBeCloseTo(0, 10);
  });

  it('sorts unordered boundaries by timestamp before segmenting', () => {
    const rows = [
      usage('m1', '2026-03-01T11:30:00Z', { input: 1_000_000 }), // between the two cuts
    ];
    const cuts = [
      boundary('2026-03-01T12:00:00Z', { preTokens: 2 }), // supplied out of order
      boundary('2026-03-01T11:00:00Z', { preTokens: 1 }),
    ];
    const result = computeCompactionAwareCost(rows, cuts, pricing());
    const mainSegments = segmentsFor(result, null);
    expect(mainSegments.map((s) => s.messageCount)).toEqual([0, 1, 0]);
    expect(mainSegments.map((s) => s.boundary?.preTokens ?? null)).toEqual([null, 1, 2]);
  });

  it('emits all-empty segments for a transcript that has boundaries but no usage', () => {
    const result = computeCompactionAwareCost(
      [],
      [boundary('2026-03-01T11:00:00Z', { agentId: 'beef0001' })],
      pricing(),
    );
    expect(result.naiveUsd).toBe(0);
    expect(result.repricedUsd).toBe(0);
    const agentSegments = segmentsFor(result, 'beef0001');
    expect(agentSegments).toHaveLength(2);
    expect(agentSegments.every((s) => s.usd === 0 && s.messageCount === 0)).toBe(true);
  });

  it('orders the main transcript first even when subagent usage comes first', () => {
    const rows = [
      usage('a1', '2026-03-01T10:00:00Z', { input: 1 }, { agentId: 'beef0001' }),
      usage('m1', '2026-03-01T10:01:00Z', { input: 1 }),
    ];
    const result = computeCompactionAwareCost(rows, [], pricing());
    expect(result.segments.map((s) => s.agentId)).toEqual([null, 'beef0001']);
  });
});

describe('computeCompactionAwareCost — loud failures', () => {
  it('throws PricingError on an unknown model — never a silent $0', () => {
    const rows = [usage('m1', '2026-03-01T10:00:00Z', { input: 1 }, { model: 'model-unknown' })];
    expect(() => computeCompactionAwareCost(rows, [], pricing())).toThrow(PricingError);
    expect(() =>
      computeCompactionAwareCost(rows, [boundary('2026-03-01T09:00:00Z')], pricing()),
    ).toThrow(/unknown model id/);
  });

  it('throws on an unparsable boundary timestamp', () => {
    const rows = [usage('m1', '2026-03-01T10:00:00Z', { input: 1 })];
    expect(() => computeCompactionAwareCost(rows, [boundary('not-a-date')], pricing())).toThrow(
      /unparsable ISO-8601/,
    );
  });
});

describe('computeCompactionAwareCost — end-to-end on the compaction fixture', () => {
  it('reprices the task-notification-recovery session across its compact_boundary', () => {
    const fixture = getFixture('task-notification-recovery');
    const session = parseSession(fixture);
    const boundaries = extractCompactionBoundaries(fixture);
    const card = pricing('synthetic-model-a');

    const result = computeCompactionAwareCost(session.usage, boundaries, card);

    // Child usage: 19 input + 3100 cacheRead + 64 output, all pre-dating the
    // main-transcript boundary — which must NOT cut the child's stream.
    const childSegments = segmentsFor(result, 'c0ffee42');
    expect(childSegments).toHaveLength(1);
    expect(childSegments[0]!.messageCount).toBe(1);
    expect(childSegments[0]!.tokens).toMatchObject({ input: 19, cacheRead: 3100, output: 64 });

    // The main transcript carries the boundary (with its preserved baseline)
    // but no priced usage: two empty segments keep the reset visible.
    const mainSegments = segmentsFor(result, null);
    expect(mainSegments).toHaveLength(2);
    expect(mainSegments.map((s) => s.messageCount)).toEqual([0, 0]);
    expect(mainSegments[1]!.boundary?.preTokens).toBe(165000);

    expect(result.compactionCount).toBe(1);
    expect(result.naiveUsd).toBeCloseTo(computeCostUsd(session.usage, card), 12);
    expect(result.deltaUsd).toBeCloseTo(0, 10);
  });
});
