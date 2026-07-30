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
});
