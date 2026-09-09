/**
 * CA-8 / AU-10 - unit cover for the hand-written response-body predicates.
 *
 * `api.test.ts` proves the BEHAVIOUR these back: a body that parses and still
 * cannot be trusted is refused rather than cast, and the caller is told which
 * kind of failure it was. This file proves the predicates themselves, one
 * rejected field at a time, because the boundary tests can only afford one
 * representative case per endpoint and the interesting question here is
 * per-FIELD: which absence blacks a panel out, and which one is deliberately
 * let through to a renderer that already says "unreadable" in that one cell.
 *
 * Each case is written as the malformed payload a server version-skew would
 * actually produce - a dropped key or a nulled figure - rather than as an
 * abstract type probe, so the file doubles as the record of what the guards
 * consider load-bearing.
 */
import { describe, expect, it } from 'vitest';
import {
  isAggregateSavings,
  isCostAnalysis,
  isCostSummary,
  isGlobalDag,
  isSessionList,
  isSessionTree,
} from '../src/dto-guards';
import {
  aggregateSavings,
  agentNode,
  agentSavings,
  compactionSegment,
  costAnalysis,
  costSummary,
  globalDag,
  sessionList,
  sessionSummary,
  sessionTree,
} from './fixtures';

/**
 * The predicates take what `api.ts` hands them: a parsed body, already known to
 * be a non-null object and nothing more. Building the malformed cases means
 * saying things the DTO types forbid - that is the point - so every fixture is
 * widened here rather than each case carrying its own cast.
 */
function body(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** A copy of `value` with one key dropped - the field a server stopped sending. */
function omit<T extends object>(value: T, key: keyof T & string): Record<string, unknown> {
  // `{ ...value }` is typed `T`, and a bare `T extends object` carries no
  // index signature - the widening is the cast, not the spread.
  const clone = { ...value } as Record<string, unknown>;
  delete clone[key];
  return clone;
}

describe('isSessionList', () => {
  it('accepts a populated list', () => {
    expect(isSessionList(body(sessionList([sessionSummary()])))).toBe(true);
  });

  it('accepts an empty list, which is a fact and not a gap', () => {
    expect(isSessionList(body(sessionList()))).toBe(true);
  });

  it('refuses a missing `sessions` container', () => {
    expect(isSessionList(omit(sessionList(), 'sessions'))).toBe(false);
  });

  it('refuses a `sessions` value that is not an array', () => {
    expect(isSessionList(body({ ...sessionList(), sessions: { 0: sessionSummary() } }))).toBe(
      false,
    );
  });

  it('refuses a non-record row, which has no properties to read', () => {
    expect(isSessionList(body({ ...sessionList(), sessions: ['aaaa-bbbb'] }))).toBe(false);
  });

  it('refuses a missing `total`, which the list prints as a count', () => {
    expect(isSessionList(omit(sessionList(), 'total'))).toBe(false);
  });

  it.each(['agentCount', 'totalTokens', 'totalCostUsd', 'unpricedTokens'] as const)(
    'refuses a row with no `%s`',
    (key) => {
      expect(isSessionList(body(sessionList([omit(sessionSummary(), key) as never])))).toBe(false);
    },
  );

  it('refuses a nulled figure as firmly as an absent one', () => {
    // The quiet case: `null > 0` is false, so a nulled `unpricedTokens`
    // withdraws the "~ n unpriced" caveat instead of showing a gap.
    expect(
      isSessionList(body(sessionList([sessionSummary({ unpricedTokens: null as never })]))),
    ).toBe(false);
  });

  it('refuses a numeric STRING, which the global `isFinite` would have accepted', () => {
    expect(
      isSessionList(body(sessionList([sessionSummary({ totalTokens: '1200' as never })]))),
    ).toBe(false);
  });

  it('refuses a missing `statusCounts` object, which the board reads through', () => {
    expect(
      isSessionList(body(sessionList([omit(sessionSummary(), 'statusCounts') as never]))),
    ).toBe(false);
  });

  it('refuses a null `statusCounts`, which is an object to `typeof`', () => {
    expect(
      isSessionList(body(sessionList([sessionSummary({ statusCounts: null as never })]))),
    ).toBe(false);
  });

  it('refuses an array `statusCounts`, which has no named buckets', () => {
    expect(isSessionList(body(sessionList([sessionSummary({ statusCounts: [] as never })])))).toBe(
      false,
    );
  });

  it('accepts a `statusCounts` the server sent holes in (rule 2)', () => {
    // Pinned by the honesty suite: an omitted bucket renders as an explicit
    // "no figure" marker, which says strictly more than a blacked-out board.
    expect(
      isSessionList(
        body(
          sessionList([sessionSummary({ statusCounts: { working: 1, completed: 2 } as never })]),
        ),
      ),
    ).toBe(true);
  });

  it('accepts an unreadable `status` string, which prints as itself (rule 2)', () => {
    expect(isSessionList(body(sessionList([sessionSummary({ status: 'moon' as never })])))).toBe(
      true,
    );
  });

  // DG-4. The companion to the case above, and the one the docblock's rule-2
  // exemption for `status` actually rests on. A server that RENAMES or DROPS
  // the field is the realistic version-skew - far likelier than one that sends
  // a status word nobody has heard of - and it arrives here as a non-string.
  // The guard must let it through: `statusMeta` answers it with
  // `unrecognised (no status word sent)`, which is strictly more than a
  // blacked-out session list would say. Pinned from this end so that tightening
  // the guard into a blackout is a test failure and not a silent judgement
  // call; `status.test.ts` (SV-3) pins the other end, the renderer this
  // exemption defers to.
  it('accepts a `status` that is not a string at all (rule 2)', () => {
    expect(isSessionList(body(sessionList([sessionSummary({ status: undefined as never })])))).toBe(
      true,
    );
    expect(isSessionList(body(sessionList([sessionSummary({ status: 7 as never })])))).toBe(true);
  });
});

describe('isSessionTree', () => {
  it('accepts a populated tree', () => {
    expect(isSessionTree(body(sessionTree({ agents: [agentNode()] })))).toBe(true);
  });

  it('refuses a missing `unattributed` rollup', () => {
    expect(isSessionTree(omit(sessionTree(), 'unattributed'))).toBe(false);
  });

  it('refuses an `unattributed` rollup with no `unpricedTokens`', () => {
    const tree = sessionTree();
    expect(
      isSessionTree(body({ ...tree, unattributed: omit(tree.unattributed, 'unpricedTokens') })),
    ).toBe(false);
  });

  it.each(['agentCount', 'edgeCount'] as const)('refuses a tree with no `%s`', (key) => {
    expect(isSessionTree(omit(sessionTree(), key))).toBe(false);
  });

  it('refuses an agent row with no `costUsd`', () => {
    expect(
      isSessionTree(body(sessionTree({ agents: [omit(agentNode(), 'costUsd') as never] }))),
    ).toBe(false);
  });

  it('refuses a missing `edges` array, which the tree maps and counts', () => {
    expect(isSessionTree(omit(sessionTree(), 'edges'))).toBe(false);
  });
});

describe('isGlobalDag', () => {
  it('accepts a populated graph', () => {
    expect(isGlobalDag(body(globalDag({ nodes: [agentNode()] })))).toBe(true);
  });

  it('refuses a missing `counts` block', () => {
    expect(isGlobalDag(omit(globalDag(), 'counts'))).toBe(false);
  });

  it.each([
    'totalSessions',
    'totalAgents',
    'totalEdges',
    'returnedAgents',
    'returnedEdges',
  ] as const)('refuses counts with no `%s`', (key) => {
    const dag = globalDag();
    expect(isGlobalDag(body({ ...dag, counts: omit(dag.counts, key) }))).toBe(false);
  });

  it('refuses a missing `truncated` flag, whose falsiness claims completeness', () => {
    const dag = globalDag();
    expect(isGlobalDag(body({ ...dag, counts: omit(dag.counts, 'truncated') }))).toBe(false);
  });

  it("refuses a `truncated` flag sent as a string, since `'false'` is truthy", () => {
    const dag = globalDag();
    expect(isGlobalDag(body({ ...dag, counts: { ...dag.counts, truncated: 'false' } }))).toBe(
      false,
    );
  });

  it('refuses a node with no `totalTokens`, which ranks the burners table', () => {
    expect(
      isGlobalDag(body(globalDag({ nodes: [omit(agentNode(), 'totalTokens') as never] }))),
    ).toBe(false);
  });

  it('refuses a missing `nodes` array', () => {
    expect(isGlobalDag(omit(globalDag(), 'nodes'))).toBe(false);
  });

  it('refuses a missing `edges` array', () => {
    expect(isGlobalDag(omit(globalDag(), 'edges'))).toBe(false);
  });
});

describe('isCostSummary', () => {
  it('accepts a fully populated summary', () => {
    expect(
      isCostSummary(
        body(
          costSummary({
            perModel: [{ model: 'claude-opus-5', tokens: 1, costUsd: 1, unpricedTokens: 0 }],
            perDay: [{ day: '2026-09-03', tokens: 1, costUsd: 1, unpricedTokens: 0 }],
            topSessions: [
              { sessionId: 's', projectSlug: null, tokens: 1, costUsd: 1, unpricedTokens: 0 },
            ],
          }),
        ),
      ),
    ).toBe(true);
  });

  it('refuses a missing `totals` block', () => {
    expect(isCostSummary(omit(costSummary(), 'totals'))).toBe(false);
  });

  it.each(['tokens', 'costUsd', 'unpricedTokens'] as const)(
    'refuses totals with no `%s`',
    (key) => {
      const summary = costSummary();
      expect(isCostSummary(body({ ...summary, totals: omit(summary.totals, key) }))).toBe(false);
    },
  );

  it('accepts NaN, which no JSON body can carry and F-5 already renders honestly', () => {
    const summary = costSummary();
    expect(
      isCostSummary(body({ ...summary, totals: { ...summary.totals, costUsd: Number.NaN } })),
    ).toBe(true);
  });

  it.each(['perModel', 'perDay', 'topSessions'] as const)('refuses a missing `%s` array', (key) => {
    expect(isCostSummary(omit(costSummary(), key))).toBe(false);
  });

  it('refuses a per-model row with no `costUsd`', () => {
    expect(
      isCostSummary(body(costSummary({ perModel: [{ model: 'claude-opus-5' } as never] }))),
    ).toBe(false);
  });

  it('refuses a per-day row with no `unpricedTokens`', () => {
    expect(
      isCostSummary(
        body(costSummary({ perDay: [{ day: '2026-09-03', tokens: 1, costUsd: 1 } as never] })),
      ),
    ).toBe(false);
  });

  it('refuses a top-session row with no `tokens`', () => {
    expect(
      isCostSummary(
        body(
          costSummary({
            topSessions: [{ sessionId: 's', costUsd: 1, unpricedTokens: 0 } as never],
          }),
        ),
      ),
    ).toBe(false);
  });

  it('accepts an ABSENT `coverage`, which means "no ingest seam wired"', () => {
    // Optional in the schema and meaningful by its absence: "we did not ask" is
    // a different fact from zero, and refusing it would call an honest server
    // malformed.
    expect(isCostSummary(body(costSummary()))).toBe(true);
  });

  it('accepts a complete `coverage`', () => {
    expect(
      isCostSummary(
        body(costSummary({ coverage: { sessionsExcluded: 3, sessionsQuarantined: 1 } })),
      ),
    ).toBe(true);
  });

  it('refuses a `coverage` that is present and half-filled', () => {
    expect(isCostSummary(body(costSummary({ coverage: { sessionsExcluded: 3 } as never })))).toBe(
      false,
    );
  });

  it('refuses a `coverage` sent as null rather than omitted', () => {
    // `null` is not absence: it asserts the field exists and holds nothing,
    // and it would take the two excluded-session counts down with it.
    expect(isCostSummary(body(costSummary({ coverage: null as never })))).toBe(false);
  });
});

describe('isAggregateSavings', () => {
  it('accepts the honest empty corpus', () => {
    expect(isAggregateSavings(body(aggregateSavings()))).toBe(true);
  });

  it.each([
    'actualUsd',
    'hypotheticalUsd',
    'savingsUsd',
    'sessionsTotal',
    'sessionsWithSubagents',
    'sessionsPriced',
    'skippedSessionCount',
    'subagentsPriced',
    'subagentsSkipped',
    'untypedAgents',
  ] as const)('refuses an estimate with no `%s`', (key) => {
    // The scope counters are checked as hard as the dollars on purpose: each is
    // either summed into a printed denominator or gates a `> 0` disclosure.
    expect(isAggregateSavings(omit(aggregateSavings(), key))).toBe(false);
  });

  it('refuses a missing `skippedSessions` sample', () => {
    expect(isAggregateSavings(omit(aggregateSavings(), 'skippedSessions'))).toBe(false);
  });

  it('refuses a missing `hypotheticalModels` list', () => {
    expect(isAggregateSavings(omit(aggregateSavings(), 'hypotheticalModels'))).toBe(false);
  });
});

describe('isCostAnalysis', () => {
  it('accepts a populated analysis', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          compaction: { ...analysis.compaction, segments: [compactionSegment()] },
          delegationSavings: { ...analysis.delegationSavings, perAgent: [agentSavings()] },
        }),
      ),
    ).toBe(true);
  });

  it('refuses a missing `compaction` block', () => {
    expect(isCostAnalysis(omit(costAnalysis(), 'compaction'))).toBe(false);
  });

  it('refuses a missing `delegationSavings` block', () => {
    expect(isCostAnalysis(omit(costAnalysis(), 'delegationSavings'))).toBe(false);
  });

  it.each(['naiveUsd', 'repricedUsd', 'deltaUsd', 'compactionCount'] as const)(
    'refuses compaction with no `%s`',
    (key) => {
      const analysis = costAnalysis();
      expect(
        isCostAnalysis(body({ ...analysis, compaction: omit(analysis.compaction, key) })),
      ).toBe(false);
    },
  );

  it('refuses a missing `segments` array', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(body({ ...analysis, compaction: omit(analysis.compaction, 'segments') })),
    ).toBe(false);
  });

  it('refuses a segment with no `tokens` bucket set', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          compaction: {
            ...analysis.compaction,
            segments: [omit(compactionSegment(), 'tokens')],
          },
        }),
      ),
    ).toBe(false);
  });

  it('refuses a segment with no `usd`', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          compaction: { ...analysis.compaction, segments: [omit(compactionSegment(), 'usd')] },
        }),
      ),
    ).toBe(false);
  });

  it('accepts a segment whose `messageCount` and token buckets have holes (rule 2)', () => {
    // Both exemptions in one payload, and both pinned by the CA-1 regression:
    // the row prints "messages unreadable" and "tokens unreadable" instead of
    // taking the whole analysis panel down with it.
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          compaction: {
            ...analysis.compaction,
            segments: [
              {
                ...omit(compactionSegment(), 'messageCount'),
                tokens: { input: 100, cacheRead: 300, cacheWrite5m: 40, cacheWrite1h: 5 },
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it.each(['actualUsd', 'hypotheticalUsd', 'savingsUsd'] as const)(
    'refuses delegation savings with no `%s`',
    (key) => {
      const analysis = costAnalysis();
      expect(
        isCostAnalysis(
          body({ ...analysis, delegationSavings: omit(analysis.delegationSavings, key) }),
        ),
      ).toBe(false);
    },
  );

  it('refuses a per-agent row with no `savingsUsd`', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          delegationSavings: {
            ...analysis.delegationSavings,
            perAgent: [omit(agentSavings(), 'savingsUsd')],
          },
        }),
      ),
    ).toBe(false);
  });

  it('refuses a missing `perAgent` array', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({ ...analysis, delegationSavings: omit(analysis.delegationSavings, 'perAgent') }),
      ),
    ).toBe(false);
  });

  it('refuses a missing `skippedAgentIds` array, whose length reports the exclusions', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          delegationSavings: omit(analysis.delegationSavings, 'skippedAgentIds'),
        }),
      ),
    ).toBe(false);
  });
});
