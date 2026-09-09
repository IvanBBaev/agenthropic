/**
 * rankTopBurners (review item M-8): pure re-sort of the served DAG nodes.
 * The suite pins the ranking key (totalTokens, so unpriced burn still ranks),
 * the deterministic tie-breaks, and the honest bookkeeping - zero-usage
 * agents are excluded but counted, and the slice never hides how many agents
 * actually ranked.
 */
import { describe, expect, it } from 'vitest';
import { rankTopBurners } from '../src/views/top-burners';
import { agentNode } from './fixtures';

describe('rankTopBurners', () => {
  it('ranks by total tokens descending, not by dollars', () => {
    const ranking = rankTopBurners(
      [
        // Cheapest by dollars but heaviest by tokens (all unpriced): must win.
        agentNode({ id: 'agent-unpriced', totalTokens: 9000, costUsd: 0, unpricedTokens: 9000 }),
        agentNode({ id: 'agent-priced', totalTokens: 5000, costUsd: 2.5 }),
      ],
      10,
    );
    expect(ranking.entries.map((entry) => entry.id)).toEqual(['agent-unpriced', 'agent-priced']);
  });

  it('breaks a token tie by cost descending', () => {
    const ranking = rankTopBurners(
      [
        agentNode({ id: 'agent-cheap', totalTokens: 5000, costUsd: 0.1 }),
        agentNode({ id: 'agent-dear', totalTokens: 5000, costUsd: 0.9 }),
      ],
      10,
    );
    expect(ranking.entries.map((entry) => entry.id)).toEqual(['agent-dear', 'agent-cheap']);
  });

  it('breaks a full tie by id, whatever the input order', () => {
    const tiedA = agentNode({ id: 'agent-a', totalTokens: 5000, costUsd: 0.5 });
    const tiedB = agentNode({ id: 'agent-b', totalTokens: 5000, costUsd: 0.5 });
    // Both input orders converge on the same output, so an SSE-driven refetch
    // that happens to reorder the payload cannot reshuffle the table.
    expect(rankTopBurners([tiedA, tiedB], 10).entries.map((entry) => entry.id)).toEqual([
      'agent-a',
      'agent-b',
    ]);
    expect(rankTopBurners([tiedB, tiedA], 10).entries.map((entry) => entry.id)).toEqual([
      'agent-a',
      'agent-b',
    ]);
  });

  it('excludes zero-usage agents from the ranking but counts them', () => {
    const ranking = rankTopBurners(
      [
        agentNode({ id: 'agent-idle', totalTokens: 0, costUsd: 0 }),
        agentNode({ id: 'agent-busy', totalTokens: 800 }),
        agentNode({ id: 'agent-idle-2', totalTokens: 0, costUsd: 0 }),
      ],
      10,
    );
    expect(ranking.entries.map((entry) => entry.id)).toEqual(['agent-busy']);
    expect(ranking.rankedCount).toBe(1);
    expect(ranking.zeroUsageCount).toBe(2);
  });

  it('slices to topN while reporting the full ranked count', () => {
    const nodes = [1000, 2000, 3000, 4000].map((tokens) =>
      agentNode({ id: `agent-${String(tokens)}`, totalTokens: tokens }),
    );
    const ranking = rankTopBurners(nodes, 2);
    expect(ranking.entries.map((entry) => entry.id)).toEqual(['agent-4000', 'agent-3000']);
    expect(ranking.rankedCount).toBe(4);
    expect(ranking.zeroUsageCount).toBe(0);
  });

  it('does not mutate the served nodes array', () => {
    const nodes = Object.freeze([
      agentNode({ id: 'agent-low', totalTokens: 100 }),
      agentNode({ id: 'agent-high', totalTokens: 900 }),
    ]);
    const ranking = rankTopBurners(nodes, 10);
    expect(ranking.entries.map((entry) => entry.id)).toEqual(['agent-high', 'agent-low']);
    expect(nodes.map((node) => node.id)).toEqual(['agent-low', 'agent-high']);
  });

  /**
   * AMENDED 2026-09-03 (CA-6, CA-7): the cases above pin the bookkeeping for
   * figures the payload actually carries. These pin it for figures it does
   * not. `api.ts` hands this module `body as T` - an unchecked cast with no
   * runtime schema anywhere in this app - so an absent or corrupt
   * `totalTokens` / `costUsd` arrives as a non-number, every comparison
   * against it is silently false, and a NaN comparator result is read by
   * Array#sort as "equal".
   */
  it('does not file an unreadable token count under "zero recorded tokens"', () => {
    const ranking = rankTopBurners(
      [
        agentNode({ id: 'agent-busy', totalTokens: 800 }),
        agentNode({ id: 'agent-idle', totalTokens: 0, costUsd: 0 }),
        agentNode({ id: 'agent-unreadable', totalTokens: Number.NaN, costUsd: 0 }),
        agentNode({ id: 'agent-negative', totalTokens: -5, costUsd: 0 }),
      ],
      10,
    );
    expect(ranking.entries.map((entry) => entry.id)).toEqual(['agent-busy']);
    expect(ranking.rankedCount).toBe(1);
    expect(ranking.zeroUsageCount).toBe(1);
    expect(ranking.unreadableUsageCount).toBe(2);
    // Every served agent is accounted for in exactly one of the three buckets.
    expect(ranking.rankedCount + ranking.zeroUsageCount + ranking.unreadableUsageCount).toBe(4);
  });

  it('orders an unreadable dollar figure the same way whatever the input order', () => {
    const unreadable = agentNode({ id: 'agent-a', totalTokens: 5000, costUsd: Number.NaN });
    const priced = agentNode({ id: 'agent-b', totalTokens: 5000, costUsd: 0.5 });
    expect(rankTopBurners([unreadable, priced], 10).entries.map((entry) => entry.id)).toEqual([
      'agent-b',
      'agent-a',
    ]);
    expect(rankTopBurners([priced, unreadable], 10).entries.map((entry) => entry.id)).toEqual([
      'agent-b',
      'agent-a',
    ]);
  });

  it('settles two unreadable dollar figures by id', () => {
    const left = agentNode({ id: 'agent-a', totalTokens: 5000, costUsd: Number.NaN });
    const right = agentNode({ id: 'agent-b', totalTokens: 5000, costUsd: Number.NaN });
    expect(rankTopBurners([right, left], 10).entries.map((entry) => entry.id)).toEqual([
      'agent-a',
      'agent-b',
    ]);
  });

  it('returns everything (and an empty result) at the edges', () => {
    // AMENDED 2026-09-03 (CA-6): the exhaustive shape gained
    // `unreadableUsageCount`; the original expectation is otherwise untouched.
    expect(rankTopBurners([], 10)).toEqual({
      entries: [],
      rankedCount: 0,
      zeroUsageCount: 0,
      unreadableUsageCount: 0,
    });
    const single = rankTopBurners([agentNode({ totalTokens: 1 })], 10);
    expect(single.entries).toHaveLength(1);
  });
});
