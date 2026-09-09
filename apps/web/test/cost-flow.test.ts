/**
 * Cost-flow sankey layout tests (WP-U9): dollar-true links only, honest
 * remainders, zero-cost models reported instead of drawn, fixed categorical
 * slots that fold instead of cycling.
 */
import { describe, expect, it } from 'vitest';
import { describeCostFlow } from '../src/views/chart-summary';
import { computeCostFlow, flowNodeValueUsd, MAX_MODEL_NODES } from '../src/views/layout/cost-flow';
import { costSummary } from './fixtures';

describe('computeCostFlow', () => {
  it('reports no flow when nothing has a positive price', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 500, costUsd: 0, unpricedTokens: 500 },
        perModel: [{ model: 'claude-x', tokens: 500, costUsd: 0, unpricedTokens: 500 }],
      }),
    );
    expect(flow.hasFlow).toBe(false);
    expect(flow.nodes).toHaveLength(0);
    expect(flow.links).toHaveLength(0);
    expect(flow.zeroCostModels).toEqual(['claude-x']);
  });

  it('builds model -> hub -> session links with real dollar values', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1.0, unpricedTokens: 0 },
        perModel: [
          { model: 'claude-a', tokens: 2000, costUsd: 0.7, unpricedTokens: 0 },
          { model: 'claude-b', tokens: 1000, costUsd: 0.3, unpricedTokens: 0 },
        ],
        topSessions: [
          { sessionId: 's1', projectSlug: 'p1', tokens: 2500, costUsd: 0.8, unpricedTokens: 0 },
          { sessionId: 's2', projectSlug: null, tokens: 500, costUsd: 0.2, unpricedTokens: 0 },
        ],
      }),
    );

    expect(flow.hasFlow).toBe(true);
    const linkValues = new Map(
      flow.links.map((link) => [`${link.sourceId}->${link.targetId}`, link.value]),
    );
    expect(linkValues.get('model:claude-a->hub')).toBe(0.7);
    expect(linkValues.get('model:claude-b->hub')).toBe(0.3);
    expect(linkValues.get('hub->session:s1')).toBe(0.8);
    expect(linkValues.get('hub->session:s2')).toBe(0.2);
    // Both sides sum to the total - no remainder node needed.
    expect(flow.otherSessionsCost).toBe(0);
    expect(flow.nodes.some((node) => node.kind === 'other-sessions')).toBe(false);
    // Every node is positioned with a real extent and links carry SVG paths.
    for (const node of flow.nodes) {
      expect(node.x1).toBeGreaterThan(node.x0);
      expect(node.y1).toBeGreaterThanOrEqual(node.y0);
    }
    for (const link of flow.links) {
      expect(link.path.length).toBeGreaterThan(0);
      expect(link.width).toBeGreaterThan(0);
    }
  });

  it('adds an honest other-sessions remainder outside topN', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1.0, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1.0, unpricedTokens: 0 }],
        topSessions: [
          { sessionId: 's1', projectSlug: 'p1', tokens: 2000, costUsd: 0.75, unpricedTokens: 0 },
        ],
      }),
    );
    expect(flow.otherSessionsCost).toBeCloseTo(0.25, 10);
    const remainder = flow.links.find((link) => link.targetId === 'other-sessions');
    expect(remainder?.value).toBeCloseTo(0.25, 10);
  });

  it('assigns fixed categorical slots and folds extra models into Other, never cycling', () => {
    const perModel = Array.from({ length: MAX_MODEL_NODES + 2 }, (_, index) => ({
      model: `model-${index}`,
      tokens: 100,
      costUsd: 1,
      unpricedTokens: 0,
    }));
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 100 * perModel.length, costUsd: perModel.length, unpricedTokens: 0 },
        perModel,
      }),
    );
    const modelNodes = flow.nodes.filter((node) => node.kind === 'model');
    expect(modelNodes).toHaveLength(MAX_MODEL_NODES);
    expect(modelNodes.map((node) => node.colorIndex)).toEqual(
      Array.from({ length: MAX_MODEL_NODES }, (_, index) => index),
    );
    const other = flow.nodes.find((node) => node.kind === 'other-models');
    expect(other?.label).toBe('other models (2)');
    expect(other?.colorIndex).toBeNull();
    const foldedLink = flow.links.find((link) => link.sourceId === 'other-models');
    expect(foldedLink?.value).toBe(2);
  });

  it('keeps unpriced tokens attached to nodes and lists zero-cost models separately', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 2000, costUsd: 0.5, unpricedTokens: 900 },
        perModel: [
          { model: 'claude-a', tokens: 1000, costUsd: 0.5, unpricedTokens: 100 },
          { model: 'claude-legacy', tokens: 800, costUsd: 0, unpricedTokens: 800 },
        ],
      }),
    );
    expect(flow.zeroCostModels).toEqual(['claude-legacy']);
    const modelNode = flow.nodes.find((node) => node.id === 'model:claude-a');
    expect(modelNode?.unpricedTokens).toBe(100);
    const hub = flow.nodes.find((node) => node.kind === 'hub');
    expect(hub?.unpricedTokens).toBe(900);
  });

  it('returns a fully empty layout for an empty summary, keeping the requested extent', () => {
    // EXTENDED 2026-09-02 (F-7, F-8): the assertion is exact on purpose, so it
    // is the tripwire for any field added to the layout. The two new ones are
    // added here rather than the assertion being loosened - an empty corpus
    // has nothing undrawable and balances trivially, and both facts belong in
    // the pinned shape.
    // EXTENDED 2026-09-09 (CF-2): `hub` joins the pinned shape for the same
    // reason. An empty corpus draws no ribbons at all, and the honest reading
    // of that is `sidesAgree` (nothing disagrees with nothing) but NOT
    // `isWhole` - there is no drawn total to call whole, and a hub that never
    // rendered must not be the one thing on the page claiming completeness.
    expect(computeCostFlow(costSummary())).toEqual({
      hasFlow: false,
      nodes: [],
      links: [],
      zeroCostModels: [],
      otherSessionsCost: 0,
      undrawable: [],
      balance: {
        perModelUsd: 0,
        sessionsUsd: 0,
        totalUsd: 0,
        modelsMinusTotalUsd: 0,
        sessionsOverTotalUsd: 0,
        totalReadable: true,
        balanced: true,
      },
      hub: { inUsd: 0, outUsd: 0, sidesAgree: true, isWhole: false },
      width: 640,
      height: 320,
    });
    expect(computeCostFlow(costSummary(), 800, 100).width).toBe(800);
    expect(computeCostFlow(costSummary(), 800, 100).height).toBe(100);
  });

  it('reports a model whose only usage is unpriced, and skips one with no usage at all', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 0, costUsd: 0, unpricedTokens: 700 },
        perModel: [
          // No priced tokens at all - the whole 700 is an honest pricing gap.
          { model: 'claude-unpriced-only', tokens: 0, costUsd: 0, unpricedTokens: 700 },
          // Recorded but idle: $0 with nothing behind it is not worth reporting.
          { model: 'claude-never-used', tokens: 0, costUsd: 0, unpricedTokens: 0 },
        ],
      }),
    );
    expect(flow.hasFlow).toBe(false);
    expect(flow.zeroCostModels).toEqual(['claude-unpriced-only']);
  });

  it('lays a single model -> hub -> session chain across the full extent', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 1000, costUsd: 2, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 1000, costUsd: 2, unpricedTokens: 0 }],
        topSessions: [
          { sessionId: 's1', projectSlug: 'p1', tokens: 1000, costUsd: 2, unpricedTokens: 0 },
        ],
      }),
      400,
      200,
    );

    expect(flow.nodes.map((node) => node.id)).toEqual(['model:claude-a', 'hub', 'session:s1']);
    expect(flow.nodes.map((node) => node.value)).toEqual([2, 2, 2]);
    // Three columns, left-anchored to right-anchored, each of the fixed width.
    expect(flow.nodes.map((node) => node.x1 - node.x0)).toEqual([12, 12, 12]);
    expect(flow.nodes[0]!.x0).toBe(0);
    expect(flow.nodes[2]!.x1).toBe(400);
    expect(flow.nodes[0]!.x1).toBeLessThan(flow.nodes[1]!.x0);
    expect(flow.nodes[1]!.x1).toBeLessThan(flow.nodes[2]!.x0);
    for (const node of flow.nodes) {
      expect(node.y0).toBeGreaterThanOrEqual(0);
      expect(node.y1).toBeLessThanOrEqual(200);
    }

    expect(flow.links.map((link) => `${link.sourceId}->${link.targetId}`)).toEqual([
      'model:claude-a->hub',
      'hub->session:s1',
    ]);
    expect(flow.links.map((link) => link.value)).toEqual([2, 2]);
    // A flow keeps its model's hue on the left of the hub and goes neutral after it.
    expect(flow.links.map((link) => link.colorIndex)).toEqual([0, null]);
    for (const link of flow.links) {
      expect(link.path.startsWith('M')).toBe(true);
    }
  });

  it('never draws a $0 session and lets its tokens fall into the honest remainder', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1, unpricedTokens: 500 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1, unpricedTokens: 500 }],
        topSessions: [
          { sessionId: 'priced', projectSlug: 'p', tokens: 2000, costUsd: 0.6, unpricedTokens: 0 },
          {
            sessionId: 'unpriced-only',
            projectSlug: 'q',
            tokens: 1000,
            costUsd: 0,
            unpricedTokens: 500,
          },
        ],
      }),
    );

    expect(flow.nodes.map((node) => node.id)).not.toContain('session:unpriced-only');
    expect(flow.links.some((link) => link.targetId === 'session:unpriced-only')).toBe(false);
    expect(flow.otherSessionsCost).toBeCloseTo(0.4, 10);
  });

  it('does not invent an other-sessions node for a sub-epsilon float remainder', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; the epsilon exists for this.
    expect(0.1 + 0.2).not.toBe(0.3);
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 0.3, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 0.3, unpricedTokens: 0 }],
        topSessions: [
          { sessionId: 's1', projectSlug: null, tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
          { sessionId: 's2', projectSlug: null, tokens: 2000, costUsd: 0.2, unpricedTokens: 0 },
        ],
      }),
    );

    expect(flow.otherSessionsCost).toBe(0);
    expect(flow.nodes.some((node) => node.kind === 'other-sessions')).toBe(false);
    // With no project slug the node falls back to the raw session id, never blank.
    expect(flow.nodes.filter((node) => node.kind === 'session').map((node) => node.label)).toEqual([
      's1',
      's2',
    ]);
  });

  it('keeps extreme magnitudes inside the extent and a tiny flow still visible', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 1_000_000_000, costUsd: 1_000_000, unpricedTokens: 0 },
        perModel: [
          { model: 'huge', tokens: 999_999_999, costUsd: 999_999.99, unpricedTokens: 0 },
          { model: 'tiny', tokens: 1, costUsd: 0.01, unpricedTokens: 0 },
        ],
        topSessions: [
          {
            sessionId: 's',
            projectSlug: null,
            tokens: 1_000_000_000,
            costUsd: 1_000_000,
            unpricedTokens: 0,
          },
        ],
      }),
    );

    // Sub-pixel float slack: the extent is respected, not exceeded visibly.
    const slack = 1e-9;
    for (const node of flow.nodes) {
      expect(node.x0).toBeGreaterThanOrEqual(-slack);
      expect(node.x1).toBeLessThanOrEqual(640 + slack);
      expect(node.y0).toBeGreaterThanOrEqual(-slack);
      expect(node.y1).toBeLessThanOrEqual(320 + slack);
      expect(Number.isFinite(node.value)).toBe(true);
    }
    // A real-but-tiny cost keeps a drawable stroke instead of vanishing.
    const tiny = flow.links.find((link) => link.sourceId === 'model:tiny');
    expect(tiny?.value).toBe(0.01);
    expect(tiny?.width).toBeGreaterThanOrEqual(1);
  });

  it('names a model whose served cost is negative instead of deleting it from the page', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 0.7, unpricedTokens: 0 },
        perModel: [
          { model: 'claude-a', tokens: 2000, costUsd: 1.0, unpricedTokens: 0 },
          { model: 'claude-refund', tokens: 1000, costUsd: -0.3, unpricedTokens: 0 },
        ],
      }),
    );
    // Not drawn - a ribbon has no direction for it - but named, with the sign.
    expect(flow.links.some((link) => link.sourceId === 'model:claude-refund')).toBe(false);
    expect(flow.zeroCostModels).not.toContain('claude-refund');
    expect(flow.undrawable).toEqual([{ label: 'model claude-refund', costUsd: -0.3 }]);
    // The breakdown still adds up to the served total, so no balance alarm.
    expect(flow.balance.balanced).toBe(true);
  });

  it('names a model whose served cost is not a number, and keeps it out of the sum', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1, unpricedTokens: 0 },
        perModel: [
          { model: 'claude-a', tokens: 2000, costUsd: 1, unpricedTokens: 0 },
          { model: 'claude-broken', tokens: 1000, costUsd: Number.NaN, unpricedTokens: 0 },
        ],
      }),
    );
    expect(flow.undrawable).toHaveLength(1);
    expect(flow.undrawable[0]?.label).toBe('model claude-broken');
    expect(flow.undrawable[0]?.costUsd).toBeNaN();
    // The unreadable row must not poison the reconciliation that reports it.
    expect(flow.balance.perModelUsd).toBe(1);
    expect(flow.balance.balanced).toBe(true);
  });

  it('names a session whose served cost no ribbon can carry, on either kind of fault', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1, unpricedTokens: 0 }],
        topSessions: [
          {
            sessionId: 's-ok',
            projectSlug: 'agenthropic',
            tokens: 1000,
            costUsd: 1,
            unpricedTokens: 0,
          },
          {
            sessionId: 's-neg',
            projectSlug: 'refunded',
            tokens: 500,
            costUsd: -2,
            unpricedTokens: 0,
          },
          {
            sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
            projectSlug: null,
            tokens: 500,
            costUsd: Number.POSITIVE_INFINITY,
            unpricedTokens: 0,
          },
          { sessionId: 's-zero', projectSlug: 'quiet', tokens: 0, costUsd: 0, unpricedTokens: 0 },
        ],
      }),
    );
    expect(flow.undrawable.map((entry) => entry.label)).toEqual([
      'session refunded',
      'session aaaaaaaa\u2026',
    ]);
    // A $0 session is absorbed by the remainder and is NOT a fault: warning
    // about it would spend the credibility this notice needs when it fires.
    expect(flow.undrawable.map((entry) => entry.label)).not.toContain('session quiet');
  });

  it('refuses to present a diagram whose two served sides contradict each other', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 9000, costUsd: 40, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 9000, costUsd: 12, unpricedTokens: 0 }],
      }),
    );
    expect(flow.hasFlow).toBe(true);
    expect(flow.balance.balanced).toBe(false);
    expect(flow.balance.perModelUsd).toBe(12);
    expect(flow.balance.totalUsd).toBe(40);
    expect(flow.balance.modelsMinusTotalUsd).toBe(-28);
    expect(flow.balance.sessionsOverTotalUsd).toBe(0);
  });

  it('says so when the drawn sessions alone exceed the served total', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1, unpricedTokens: 0 }],
        topSessions: [
          { sessionId: 's1', projectSlug: 'p', tokens: 2000, costUsd: 3, unpricedTokens: 0 },
        ],
      }),
    );
    // The negative remainder cannot be drawn, so it used to vanish entirely.
    expect(flow.otherSessionsCost).toBe(0);
    expect(flow.balance.sessionsUsd).toBe(3);
    expect(flow.balance.sessionsOverTotalUsd).toBe(2);
    expect(flow.balance.balanced).toBe(false);
  });

  it('refuses to reconcile against a served total that is not a readable amount', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: Number.NaN, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1, unpricedTokens: 0 }],
      }),
    );
    expect(flow.balance.totalReadable).toBe(false);
    expect(flow.balance.balanced).toBe(false);
    // No gap is claimed either - an unreadable total supports no arithmetic.
    expect(flow.balance.modelsMinusTotalUsd).toBe(0);
    expect(flow.balance.sessionsOverTotalUsd).toBe(0);
  });

  it('treats a sub-cent divergence as float dust rather than crying wolf', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1.000_02, unpricedTokens: 0 }],
        topSessions: [
          { sessionId: 's1', projectSlug: 'p', tokens: 3000, costUsd: 1.000_02, unpricedTokens: 0 },
        ],
      }),
    );
    expect(flow.balance.modelsMinusTotalUsd).toBe(0);
    expect(flow.balance.sessionsOverTotalUsd).toBe(0);
    expect(flow.balance.balanced).toBe(true);
  });

  it('refuses to put a dollar figure on a node the layout never valued', () => {
    const seed = {
      id: 'hub',
      label: 'all cost',
      kind: 'hub' as const,
      colorIndex: null,
      unpricedTokens: 0,
    };
    // A missing coordinate degrades to a safe pixel; a missing AMOUNT must not
    // degrade to a measured $0.00, so it carries the app's unreadable marker.
    expect(flowNodeValueUsd(seed)).toBeNaN();
    expect(flowNodeValueUsd({ ...seed, value: 2.5 })).toBe(2.5);
  });
});

/**
 * ADDED 2026-09-07 (CF-1, CS-2). The hub is the one node in the diagram that
 * claims to be a WHOLE, and `describeCostFlow` is the same diagram in prose:
 * both are tested here against the served totals they claim to summarise.
 */
describe('the hub node and its prose alternative', () => {
  it('does not call the hub "all cost" when a served cost could not be drawn into it', () => {
    // $1.00 of usage and a $0.30 refund reconcile to the served $0.70 total,
    // so the balance check is silent - but a negative cannot be a ribbon, so
    // only $1.00 is actually drawn into the hub.
    const summary = costSummary({
      totals: { tokens: 3000, costUsd: 0.7, unpricedTokens: 0 },
      perModel: [
        { model: 'claude-a', tokens: 3000, costUsd: 1.0, unpricedTokens: 0 },
        { model: 'claude-refund', tokens: 0, costUsd: -0.3, unpricedTokens: 0 },
      ],
    });
    const flow = computeCostFlow(summary);
    const hub = flow.nodes.find((node) => node.kind === 'hub')!;

    expect(flow.balance.balanced).toBe(true);
    expect(hub.value).toBe(1);
    expect(summary.totals.costUsd).toBe(0.7);
    // AMENDED 2026-09-09 (CF-2). This asserted `drawn cost`, which was correct
    // for a check that only looked at the ENTERING side: $1.00 of model ribbons
    // enter, that is not the served $0.70, so the hub is not whole. It is also
    // not the whole story about this fixture. $0.70 LEAVES - the remainder
    // ribbon cut from the served total - so the two drawn sides differ by $0.30
    // and the $1.00 the hub prints is one side of a disagreement, not a sum.
    // The label now says which figure it is. The claim this test was written to
    // pin - that a hub with an undrawable cost behind it is never called
    // `all cost` - is unchanged and strictly better served.
    expect(hub.label).toBe('larger drawn side');
    expect(flow.hub).toEqual({ inUsd: 1, outUsd: 0.7, sidesAgree: false, isWhole: false });
  });

  it('calls the hub "drawn cost" when both drawn sides agree but miss the served total', () => {
    // The middle label, and the state that made CF-2's two-sided check more
    // than a rename: $1.00 enters and $1.00 leaves, so the picture is internally
    // consistent and d3-sankey had no choice to make - but the server served
    // $0.70, so the hub is not the whole of anything. Sides agreeing is not the
    // same claim as sides matching the total, and the label keeps them apart.
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 0.7, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1.0, unpricedTokens: 0 }],
        topSessions: [
          { sessionId: 's1', projectSlug: 'p', tokens: 3000, costUsd: 1.0, unpricedTokens: 0 },
        ],
      }),
    );
    const hub = flow.nodes.find((node) => node.kind === 'hub')!;

    expect(flow.hub).toEqual({ inUsd: 1, outUsd: 1, sidesAgree: true, isWhole: false });
    expect(hub.label).toBe('drawn cost');
  });

  it('still calls the hub "all cost" when the drawn ribbons are the whole total', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1.0, unpricedTokens: 0 },
        perModel: [
          { model: 'claude-a', tokens: 2000, costUsd: 0.7, unpricedTokens: 0 },
          { model: 'claude-b', tokens: 1000, costUsd: 0.3, unpricedTokens: 0 },
        ],
      }),
    );
    expect(flow.nodes.find((node) => node.kind === 'hub')!.label).toBe('all cost');
  });

  it('states an unreadable unpriced total instead of dropping the caveat', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1.0, unpricedTokens: Number.NaN },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1.0, unpricedTokens: 0 }],
      }),
    );
    expect(describeCostFlow(flow, Number.NaN)).toContain('tokens unreadable');
  });

  it("says a single node's unpriced count is unreadable rather than printing it as priced", () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 3000, costUsd: 1.0, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1.0, unpricedTokens: Number.NaN }],
      }),
    );
    expect(describeCostFlow(flow, 0)).toContain(
      'claude-a $1.00 (plus unpriced: tokens unreadable)',
    );
  });
});
