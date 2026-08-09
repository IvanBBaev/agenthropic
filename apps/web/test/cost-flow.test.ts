/**
 * Cost-flow sankey layout tests (WP-U9): dollar-true links only, honest
 * remainders, zero-cost models reported instead of drawn, fixed categorical
 * slots that fold instead of cycling.
 */
import { describe, expect, it } from 'vitest';
import { computeCostFlow, MAX_MODEL_NODES } from '../src/views/layout/cost-flow';
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
    expect(computeCostFlow(costSummary())).toEqual({
      hasFlow: false,
      nodes: [],
      links: [],
      zeroCostModels: [],
      otherSessionsCost: 0,
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
});
