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

  /**
   * K1 (2026-09-23). `index` is a RAW PRINT twice over: the `#` column renders
   * `{segment.index + 1}` and the row key is built as
   * `${agentId ?? 'main'}-${String(index)}`. A server that stopped sending it
   * numbers every row `NaN` and keys every row identically, which React
   * reconciles into ONE row - a table that silently loses its other rows while
   * looking like a complete one. Nothing downstream can say "unreadable" for
   * it, so the shape check is the only place the absence can be caught.
   */
  it('refuses a segment with no `index`, the number the `#` column prints raw', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          compaction: { ...analysis.compaction, segments: [omit(compactionSegment(), 'index')] },
        }),
      ),
    ).toBe(false);
  });

  /**
   * K2 (2026-09-23). `agentId` and `boundary` are read THROUGH, not printed, so
   * their absence is a category-1 TypeError during render: the panel is
   * replaced by an error notice that cannot say what went wrong. Both are
   * NULLABLE and both nulls are meaningful (`null` agentId is the main thread,
   * `null` boundary is a segment with no recorded boundary), which is why the
   * check is `null`-or-shape rather than presence. `agentId` must be a STRING
   * in particular: `shortId` slices it, and `shortId({})` hands React an object
   * as a child, which React refuses outright.
   */
  it('accepts a segment whose `agentId` is a string and whose `boundary` is a record', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          compaction: {
            ...analysis.compaction,
            segments: [
              compactionSegment({
                agentId: '00000000-1111-2222-3333-444444444444',
                boundary: {
                  agentId: null,
                  timestamp: '2026-09-23T00:00:00.000Z',
                  trigger: null,
                  preTokens: null,
                },
              }),
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['absent', omit(compactionSegment(), 'agentId')],
    ['neither null nor a string', compactionSegment({ agentId: 42 as unknown as null })],
  ])('refuses a segment whose `agentId` is %s', (_label, segment) => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          compaction: { ...analysis.compaction, segments: [segment] },
        }),
      ),
    ).toBe(false);
  });

  it.each([
    ['absent', omit(compactionSegment(), 'boundary')],
    ['neither null nor a record', compactionSegment({ boundary: 'yesterday' as unknown as null })],
  ])('refuses a segment whose `boundary` is %s', (_label, segment) => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          compaction: { ...analysis.compaction, segments: [segment] },
        }),
      ),
    ).toBe(false);
  });

  /**
   * K2 (2026-09-23). The per-agent rows shared their check with the delegation
   * ROLLUP, which carries the same three money fields and no agent id - so the
   * rows inherited a check that could not require one. Each row is keyed
   * `key={agent.agentId}` and labelled `shortId(agent.agentId)`, both of which
   * throw on an absent id, taking the whole analysis panel down.
   */
  it('refuses a per-agent savings row with no `agentId`, which keys and labels it', () => {
    const analysis = costAnalysis();
    expect(
      isCostAnalysis(
        body({
          ...analysis,
          delegationSavings: {
            ...analysis.delegationSavings,
            perAgent: [omit(agentSavings(), 'agentId')],
          },
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

/**
 * L1 (2026-09-09). The corpus-scope pair that describes the top-sessions
 * table. `topSessions` is a SLICE, and until these two fields existed the
 * payload could not say so: `sessionCount` is the population the slice was cut
 * from and `hasMore` says the slice is short of it. Both are refused when
 * absent because neither has a renderer that could say "unreadable" in its
 * place - the first is printed raw as a denominator, and the second gates a
 * disclosure, so a stale server would render as "5 of undefined sessions" with
 * the truncation notice quietly withdrawn.
 *
 * The fixture derives both from `topSessions.length` unless a case passes them,
 * so the malformed bodies here are built by spreading over its output: that is
 * the shape a server version-skew actually puts on the wire, and it is also the
 * only way to say `null`, which the builder's `??` would otherwise fill in.
 */
describe('isCostSummary - the corpus-scope pair (L1)', () => {
  /** One row of a corpus of 51, i.e. the truncated case the pair exists for. */
  const truncated = costSummary({
    topSessions: [{ sessionId: 's', projectSlug: null, tokens: 1, costUsd: 1, unpricedTokens: 0 }],
    sessionCount: 51,
  });

  it('accepts a summary carrying both scope fields', () => {
    expect(isCostSummary(body(truncated))).toBe(true);
  });

  it('accepts a slice that is the whole corpus, where `hasMore` is false', () => {
    expect(isCostSummary(body(costSummary()))).toBe(true);
  });

  it('refuses a missing `sessionCount`, which prints raw as a denominator', () => {
    expect(isCostSummary(omit(truncated, 'sessionCount'))).toBe(false);
  });

  it('refuses a `sessionCount` that is not a number', () => {
    // The string is the numeric-STRING case the global `isFinite` would have
    // accepted; `null` is the quiet one, since it survives to the screen as a
    // denominator the server never sent.
    expect(isCostSummary(body({ ...truncated, sessionCount: '5' }))).toBe(false);
    expect(isCostSummary(body({ ...truncated, sessionCount: null }))).toBe(false);
  });

  it('refuses a missing `hasMore`, whose falsiness claims the table is complete', () => {
    expect(isCostSummary(omit(truncated, 'hasMore'))).toBe(false);
  });

  it('refuses a `hasMore` that is not a boolean', () => {
    // Same reasoning as `counts.truncated` in `isGlobalDag`: `0` is a falsy
    // stand-in for "not truncated" that the server never asserted, and the
    // string `'true'` is truthy whatever it spells.
    expect(isCostSummary(body({ ...truncated, hasMore: 0 }))).toBe(false);
    expect(isCostSummary(body({ ...truncated, hasMore: 'true' }))).toBe(false);
  });

  it('accepts a fractional `sessionCount` (rule 1)', () => {
    // Deliberate, not an oversight: rule 1 is SHAPE, NOT SANITY. Half a session
    // is a server bug that prints as `2.5` and can be disbelieved on sight,
    // which is a different class from `null` printing as a number nobody sent.
    // Do not "fix" this into a `Number.isInteger` check - the guard would then
    // black out a whole cost page over a figure the reader could already see
    // was wrong.
    expect(isCostSummary(body({ ...truncated, sessionCount: 2.5 }))).toBe(true);
  });
});
