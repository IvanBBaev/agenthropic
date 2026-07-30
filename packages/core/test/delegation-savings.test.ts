/**
 * Tests for WP-C5 delegation-savings.
 *
 * Coverage strategy:
 * - The plan formula `Σ max(0, top-tier-equiv − actual)` against hand-checked
 *   dollar figures, including the clamped inverted-routing case.
 * - Top-tier resolution: explicit override, main-agent derivation (usage rows
 *   with `agentId === null`), depth-2 nearest-ancestor walk, usage-less parent
 *   skip-through, greatest-output model settle, orphan/cycle skips.
 * - Honest-uncertainty labeling (`isEstimate: true` everywhere), `<synthetic>`
 *   rows staying $0 in the hypothetical, dated-price resolution at the child's
 *   own timestamps.
 * - Loud failures: unknown actual OR hypothetical model throws `PricingError`.
 * - End-to-end on the parsed depth-2-sync fixture.
 */
import { describe, expect, it } from 'vitest';
import { computeDelegationSavings, parseSession, PricingError } from '../src/index';
import type {
  DedupedUsage,
  ParsedAgent,
  ParsedSession,
  PricingEntry,
  TokenBuckets,
} from '../src/index';
import { getFixture } from '@agenthropic/test-fixtures';

const EPOCH = '2020-01-01T00:00:00.000Z';
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TS = '2026-03-01T10:00:00.000Z';

/** Price card: `cheap` $1/$5, `top` $5/$25 per MTok (input/output; cache-read x0.1 of input). */
function pricing(): PricingEntry[] {
  const card = (model: string, input: number, output: number): PricingEntry[] => [
    { model, bucket: 'input', usdPerMtok: input, effectiveFrom: EPOCH },
    { model, bucket: 'output', usdPerMtok: output, effectiveFrom: EPOCH },
    { model, bucket: 'cache_read', usdPerMtok: input * 0.1, effectiveFrom: EPOCH },
    { model, bucket: 'cache_write_5m', usdPerMtok: input * 1.25, effectiveFrom: EPOCH },
    { model, bucket: 'cache_write_1h', usdPerMtok: input * 2, effectiveFrom: EPOCH },
  ];
  return [
    ...card('cheap', 1, 5),
    ...card('top', 5, 25),
    ...(['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const).map(
      (bucket): PricingEntry => ({
        model: '<synthetic>',
        bucket,
        usdPerMtok: 0,
        effectiveFrom: EPOCH,
      }),
    ),
  ];
}

function agent(id: string, overrides: Partial<ParsedAgent> = {}): ParsedAgent {
  return {
    id,
    type: 'subagent',
    subagentType: 'general-purpose',
    parentAgentId: SESSION,
    startedAt: TS,
    endedAt: null,
    ...overrides,
  };
}

function mainAgent(): ParsedAgent {
  return agent(SESSION, { type: 'main', subagentType: null, parentAgentId: null });
}

function usage(
  messageId: string,
  agentId: string | null,
  model: string,
  buckets: Partial<TokenBuckets> = {},
  timestamp: string = TS,
): DedupedUsage {
  return {
    messageId,
    model,
    timestamp,
    agentId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...buckets },
  };
}

function session(agents: ParsedAgent[], rows: DedupedUsage[]): ParsedSession {
  return { sessionId: SESSION, agents, edges: [], usage: rows };
}

describe('computeDelegationSavings — empty and trivial trees', () => {
  it('returns all zeros for an empty tree (no agents at all)', () => {
    const result = computeDelegationSavings(session([], []), pricing());
    expect(result).toEqual({
      actualUsd: 0,
      hypotheticalUsd: 0,
      savingsUsd: 0,
      perAgent: [],
      skippedAgentIds: [],
      isEstimate: true,
    });
  });

  it('returns all zeros for a single root with no children', () => {
    const rows = [usage('m1', null, 'top', { input: 1_000_000 })];
    const result = computeDelegationSavings(session([mainAgent()], rows), pricing());
    expect(result.actualUsd).toBe(0);
    expect(result.hypotheticalUsd).toBe(0);
    expect(result.savingsUsd).toBe(0);
    expect(result.perAgent).toEqual([]);
    expect(result.isEstimate).toBe(true);
  });

  it('includes a subagent with zero usage rows at $0 across the board', () => {
    const rows = [usage('m1', null, 'top', { input: 1_000 })];
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001')], rows),
      pricing(),
    );
    expect(result.perAgent).toHaveLength(1);
    expect(result.perAgent[0]).toMatchObject({
      agentId: 'beef0001',
      actualUsd: 0,
      hypotheticalUsd: 0,
      savingsUsd: 0,
      hypotheticalModel: 'top',
      isEstimate: true,
    });
  });
});

describe('computeDelegationSavings — the plan formula, hand-checked', () => {
  // Child on `cheap`: 1 MTok input ($1) + 0.1 MTok output ($0.5) = $1.50 actual.
  // Repriced at `top`: $5 + $2.5 = $7.50 hypothetical -> savings $6.00.
  const childRows = [
    usage('c1', 'beef0001', 'cheap', { input: 1_000_000 }),
    usage('c2', 'beef0001', 'cheap', { output: 100_000 }),
  ];
  const mainRows = [usage('m1', null, 'top', { input: 10_000, output: 5_000 })];

  it('savings = hypothetical − actual for a child routed to a cheaper model', () => {
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001')], [...mainRows, ...childRows]),
      pricing(),
    );
    expect(result.actualUsd).toBeCloseTo(1.5, 10);
    expect(result.hypotheticalUsd).toBeCloseTo(7.5, 10);
    expect(result.savingsUsd).toBeCloseTo(6, 10);
    expect(result.perAgent[0]).toMatchObject({
      agentId: 'beef0001',
      parentAgentId: SESSION,
      hypotheticalModel: 'top',
      isEstimate: true,
    });
    expect(result.skippedAgentIds).toEqual([]);
  });

  it('yields zero savings when the child already runs the parent model', () => {
    const sameModelRows = [
      usage('m1', null, 'top', { output: 1_000 }),
      usage('c1', 'beef0001', 'top', { input: 1_000_000 }),
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001')], sameModelRows),
      pricing(),
    );
    expect(result.actualUsd).toBeCloseTo(5, 10);
    expect(result.hypotheticalUsd).toBeCloseTo(5, 10);
    expect(result.savingsUsd).toBe(0);
  });

  it('clamps a negative per-agent term at 0 (child MORE expensive than the parent)', () => {
    const invertedRows = [
      usage('m1', null, 'cheap', { output: 1_000 }),
      usage('c1', 'beef0001', 'top', { input: 1_000_000 }), // actual $5, hypothetical at cheap $1
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001')], invertedRows),
      pricing(),
    );
    expect(result.actualUsd).toBeCloseTo(5, 10);
    expect(result.hypotheticalUsd).toBeCloseTo(1, 10); // the inversion stays visible…
    expect(result.savingsUsd).toBe(0); // …but never counts as negative savings
  });

  it('sums per-agent terms independently (one saving, one clamped)', () => {
    const rows = [
      usage('m1', null, 'top', { output: 1_000 }),
      usage('c1', 'beef0001', 'cheap', { input: 1_000_000 }), // $1 -> $5: saves $4
      usage('c2', 'beef0002', 'top', { input: 1_000_000 }), // $5 -> $5: saves $0
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001'), agent('beef0002')], rows),
      pricing(),
    );
    expect(result.savingsUsd).toBeCloseTo(4, 10);
    expect(result.perAgent.map((a) => a.savingsUsd)).toEqual([4, 0]);
  });
});

describe('computeDelegationSavings — top-tier model resolution', () => {
  it('an explicit options.topTierModel overrides ancestor derivation', () => {
    const rows = [
      usage('m1', null, 'cheap', { output: 1_000 }), // parent runs cheap…
      usage('c1', 'beef0001', 'cheap', { input: 1_000_000 }),
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001')], rows),
      pricing(),
      {
        topTierModel: 'top',
      },
    );
    expect(result.perAgent[0]!.hypotheticalModel).toBe('top');
    expect(result.savingsUsd).toBeCloseTo(4, 10); // $1 actual vs $5 at the named alternative
  });

  it('derives a grandchild model from its DIRECT parent, not the root', () => {
    const depth1 = agent('d1d1a001');
    const depth2 = agent('d2d2b002', { parentAgentId: 'd1d1a001' });
    const rows = [
      usage('m1', null, 'cheap', { output: 1_000 }),
      usage('p1', 'd1d1a001', 'top', { output: 1_000 }),
      usage('g1', 'd2d2b002', 'cheap', { input: 1_000_000 }),
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), depth1, depth2], rows),
      pricing(),
    );
    const grandchild = result.perAgent.find((a) => a.agentId === 'd2d2b002');
    expect(grandchild?.hypotheticalModel).toBe('top'); // depth-1 model, not main's `cheap`
    const child = result.perAgent.find((a) => a.agentId === 'd1d1a001');
    expect(child?.hypotheticalModel).toBe('cheap'); // depth-1's own parent is main
  });

  it('walks past a usage-less parent up to the main agent', () => {
    const depth1 = agent('d1d1a001'); // no usage rows at all
    const depth2 = agent('d2d2b002', { parentAgentId: 'd1d1a001' });
    const rows = [
      usage('m1', null, 'top', { output: 1_000 }),
      usage('g1', 'd2d2b002', 'cheap', { input: 1_000_000 }),
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), depth1, depth2], rows),
      pricing(),
    );
    expect(result.perAgent.find((a) => a.agentId === 'd2d2b002')?.hypotheticalModel).toBe('top');
    // The usage-less depth-1 still resolves (its parent is main) at $0 cost.
    expect(result.perAgent.find((a) => a.agentId === 'd1d1a001')?.actualUsd).toBe(0);
  });

  it('settles a multi-model ancestor to its greatest-output row, ignoring <synthetic>', () => {
    const rows = [
      usage('m1', null, '<synthetic>', { output: 9_000_000 }), // never a routing model
      usage('m2', null, 'cheap', { output: 100 }),
      usage('m3', null, 'top', { output: 5_000 }), // settled model: greatest real output
      usage('c1', 'beef0001', 'cheap', { input: 1_000_000 }),
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001')], rows),
      pricing(),
    );
    expect(result.perAgent[0]!.hypotheticalModel).toBe('top');
  });

  it('skips an orphan (parentAgentId null) when no topTierModel is given', () => {
    const orphan = agent('0e0e0e0e', { parentAgentId: null });
    const rows = [usage('c1', '0e0e0e0e', 'cheap', { input: 1_000_000 })];
    const result = computeDelegationSavings(session([mainAgent(), orphan], rows), pricing());
    expect(result.skippedAgentIds).toEqual(['0e0e0e0e']);
    expect(result.perAgent).toEqual([]);
    expect(result.actualUsd).toBe(0); // excluded from the sums, not priced against a guess
  });

  it('prices an orphan when an explicit topTierModel names the routing alternative', () => {
    const orphan = agent('0e0e0e0e', { parentAgentId: null });
    const rows = [usage('c1', '0e0e0e0e', 'cheap', { input: 1_000_000 })];
    const result = computeDelegationSavings(session([mainAgent(), orphan], rows), pricing(), {
      topTierModel: 'top',
    });
    expect(result.skippedAgentIds).toEqual([]);
    expect(result.savingsUsd).toBeCloseTo(4, 10);
  });

  it('terminates on a defensive parent cycle instead of looping forever', () => {
    const a = agent('aaaa0001', { parentAgentId: 'bbbb0002' });
    const b = agent('bbbb0002', { parentAgentId: 'aaaa0001' });
    const rows = [usage('c1', 'aaaa0001', 'cheap', { input: 1_000 })];
    const result = computeDelegationSavings(session([a, b], rows), pricing());
    // `aaaa0001`'s walk (b -> a, already visited) finds no usage: skipped.
    // `bbbb0002`'s walk reaches `aaaa0001`, which DOES have usage: resolved.
    expect(result.skippedAgentIds).toEqual(['aaaa0001']);
    expect(result.perAgent).toEqual([
      expect.objectContaining({ agentId: 'bbbb0002', hypotheticalModel: 'cheap', actualUsd: 0 }),
    ]);
  });

  it('skips every member of a usage-less parent cycle', () => {
    const a = agent('aaaa0001', { parentAgentId: 'bbbb0002' });
    const b = agent('bbbb0002', { parentAgentId: 'aaaa0001' });
    const result = computeDelegationSavings(session([a, b], []), pricing());
    expect(result.skippedAgentIds).toEqual(['aaaa0001', 'bbbb0002']);
    expect(result.perAgent).toEqual([]);
  });

  it('skips a child whose parent pointer dangles at an unknown, usage-less id', () => {
    const child = agent('beef0001', { parentAgentId: 'not-a-known-agent' });
    const rows = [usage('c1', 'beef0001', 'cheap', { input: 1_000 })];
    const result = computeDelegationSavings(session([child], rows), pricing());
    expect(result.skippedAgentIds).toEqual(['beef0001']);
  });
});

describe('computeDelegationSavings — honesty guarantees', () => {
  it('keeps <synthetic> child rows at $0 in the hypothetical (no fabricated spend)', () => {
    const rows = [
      usage('m1', null, 'top', { output: 1_000 }),
      usage('c1', 'beef0001', '<synthetic>', { input: 50_000_000 }),
      usage('c2', 'beef0001', 'cheap', { input: 1_000_000 }),
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001')], rows),
      pricing(),
    );
    // Only the real row reprices: $1 -> $5. The synthetic 50 MTok stays $0.
    expect(result.actualUsd).toBeCloseTo(1, 10);
    expect(result.hypotheticalUsd).toBeCloseTo(5, 10);
    expect(result.savingsUsd).toBeCloseTo(4, 10);
  });

  it('resolves dated prices at the child row timestamps in BOTH actual and hypothetical', () => {
    const changeAt = '2026-06-01T00:00:00.000Z';
    const dated: PricingEntry[] = [
      { model: 'cheap', bucket: 'input', usdPerMtok: 1, effectiveFrom: EPOCH },
      { model: 'top', bucket: 'input', usdPerMtok: 5, effectiveFrom: EPOCH },
      { model: 'top', bucket: 'input', usdPerMtok: 10, effectiveFrom: changeAt },
      { model: 'top', bucket: 'output', usdPerMtok: 25, effectiveFrom: EPOCH },
    ];
    const rows = [
      usage('m1', null, 'top', { output: 1 }, '2026-07-01T00:00:00.000Z'),
      // The child ran BEFORE the top-tier price change: the hypothetical must
      // use the old $5 rate of the child's own timestamp, not today's $10.
      usage('c1', 'beef0001', 'cheap', { input: 1_000_000 }, '2026-05-01T00:00:00.000Z'),
    ];
    const result = computeDelegationSavings(session([mainAgent(), agent('beef0001')], rows), dated);
    expect(result.perAgent[0]!.hypotheticalUsd).toBeCloseTo(5, 10);
  });

  it('labels every level as an estimate with a literal true', () => {
    const rows = [
      usage('m1', null, 'top', { output: 1_000 }),
      usage('c1', 'beef0001', 'cheap', { input: 1_000 }),
    ];
    const result = computeDelegationSavings(
      session([mainAgent(), agent('beef0001')], rows),
      pricing(),
    );
    expect(result.isEstimate).toBe(true);
    expect(result.perAgent.every((a) => a.isEstimate)).toBe(true);
  });
});

describe('computeDelegationSavings — loud failures', () => {
  it('throws PricingError when a child model is unknown — never a silent $0', () => {
    const rows = [
      usage('m1', null, 'top', { output: 1_000 }),
      usage('c1', 'beef0001', 'model-unknown', { input: 1 }),
    ];
    const s = session([mainAgent(), agent('beef0001')], rows);
    expect(() => computeDelegationSavings(s, pricing())).toThrow(PricingError);
    expect(() => computeDelegationSavings(s, pricing())).toThrow(/unknown model id/);
  });

  it('throws PricingError when the hypothetical top-tier model has no pricing rows', () => {
    const rows = [
      usage('m1', null, 'unpriced-top', { output: 1_000 }),
      usage('c1', 'beef0001', 'cheap', { input: 1 }),
    ];
    const s = session([mainAgent(), agent('beef0001')], rows);
    expect(() => computeDelegationSavings(s, pricing())).toThrow(PricingError);
    // Same failure via the explicit override path.
    expect(() => computeDelegationSavings(s, pricing(), { topTierModel: 'also-unpriced' })).toThrow(
      PricingError,
    );
  });
});

describe('computeDelegationSavings — end-to-end on the depth-2-sync fixture', () => {
  it('computes a hand-checked estimate over the parsed fixture with same-model routing', () => {
    const parsed = parseSession(getFixture('depth-2-sync'));
    const EPOCH_CARD: PricingEntry[] = (
      ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const
    ).map((bucket) => ({
      model: 'synthetic-model-a',
      bucket,
      usdPerMtok: 1,
      effectiveFrom: EPOCH,
    }));

    const result = computeDelegationSavings(parsed, EPOCH_CARD);

    // Every agent in the fixture runs synthetic-model-a, so repricing at the
    // ancestor model is the identity: hypothetical == actual, savings == 0.
    expect(result.perAgent).toHaveLength(2);
    expect(result.skippedAgentIds).toEqual([]);
    expect(result.hypotheticalUsd).toBeCloseTo(result.actualUsd, 12);
    expect(result.savingsUsd).toBe(0);
    // d1: (20+40+200+500) tokens, d2: (10+15) tokens at $1/MTok.
    expect(result.actualUsd).toBeCloseTo(785 / 1_000_000, 12);
    const grandchild = result.perAgent.find((a) => a.agentId === 'd2d2b002');
    expect(grandchild?.parentAgentId).toBe('d1d1a001');
  });
});
