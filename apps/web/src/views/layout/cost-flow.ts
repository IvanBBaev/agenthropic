/**
 * Pure sankey layout for the cost view (WP-U9): model -> all cost -> session
 * flows, computed synchronously with d3-sankey. Every link value is a dollar
 * figure the API actually served - the module NEVER apportions model cost
 * across sessions (the summary has no model-by-session matrix, so inventing
 * one would be fabrication). What cannot be drawn as a dollar flow is
 * reported instead of hidden: zero-cost models (unpriced-only usage), the
 * "other sessions" remainder outside topN, and the unpriced token total.
 */
import { sankey, sankeyLinkHorizontal, type SankeyGraph, type SankeyLink } from 'd3-sankey';
import type { CostSummaryDto } from '../../dto';
import { shortId } from '../../format';

/** Categorical slots are fixed, never cycled; extra models fold into Other. */
export const MAX_MODEL_NODES = 7;

export type FlowNodeKind = 'model' | 'hub' | 'session' | 'other-sessions' | 'other-models';

export interface FlowNodeSeed {
  readonly id: string;
  readonly label: string;
  readonly kind: FlowNodeKind;
  /** Fixed categorical palette slot for model nodes; null = neutral ink. */
  readonly colorIndex: number | null;
  readonly unpricedTokens: number;
}

interface FlowLinkSeed {
  source: string;
  target: string;
  value: number;
}

/**
 * A seed node as d3-sankey hands it back. The geometry is optional in
 * @types/d3-sankey because it only exists after layout, so the converters
 * below give every field an explicit fallback instead of asserting.
 */
export type LaidOutNode = FlowNodeSeed & {
  readonly value?: number | undefined;
  readonly x0?: number | undefined;
  readonly x1?: number | undefined;
  readonly y0?: number | undefined;
  readonly y1?: number | undefined;
};

/** A laid-out link: endpoints resolved to node objects, geometry optional. */
export interface LaidOutLink {
  readonly source: LaidOutNode;
  readonly target: LaidOutNode;
  readonly value: number;
  readonly width?: number | undefined;
  readonly y0?: number | undefined;
  readonly y1?: number | undefined;
}

/** Path generator seam - injectable so both outcomes are directly testable. */
export type LinkPathFn = (link: LaidOutLink) => string | null;

const LINK_PATH = sankeyLinkHorizontal<FlowNodeSeed, FlowLinkSeed>();

const defaultLinkPath: LinkPathFn = (link) =>
  LINK_PATH(link as unknown as SankeyLink<FlowNodeSeed, FlowLinkSeed>);

/** Layout node -> render node; missing geometry becomes 0, never NaN. */
export function toFlowNode(node: LaidOutNode): FlowNode {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    colorIndex: node.colorIndex,
    unpricedTokens: node.unpricedTokens,
    value: node.value ?? 0,
    x0: node.x0 ?? 0,
    x1: node.x1 ?? 0,
    y0: node.y0 ?? 0,
    y1: node.y1 ?? 0,
  };
}

/**
 * Layout link -> render link. A flow wears its model's hue on either side of
 * the hub; hub->session remainder links are neutral. A missing path or width
 * degrades to an empty path / a one-pixel ribbon rather than to NaN geometry.
 */
export function toFlowLink(
  link: LaidOutLink,
  colorByNodeId: ReadonlyMap<string, number | null>,
  pathFor: LinkPathFn = defaultLinkPath,
): FlowLink {
  const sourceId = link.source.id;
  return {
    path: pathFor(link) ?? '',
    width: Math.max(1, link.width ?? 1),
    value: link.value,
    sourceId,
    targetId: link.target.id,
    colorIndex: colorByNodeId.get(sourceId) ?? null,
  };
}

export interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly kind: FlowNodeKind;
  readonly colorIndex: number | null;
  readonly unpricedTokens: number;
  readonly value: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export interface FlowLink {
  /** SVG path (sankeyLinkHorizontal) - the renderer draws it verbatim. */
  readonly path: string;
  readonly width: number;
  readonly value: number;
  readonly sourceId: string;
  readonly targetId: string;
  readonly colorIndex: number | null;
}

export interface CostFlowLayout {
  /** False when nothing has a positive price - render honest copy, not an empty SVG. */
  readonly hasFlow: boolean;
  readonly nodes: readonly FlowNode[];
  readonly links: readonly FlowLink[];
  /** Models with $0 priced cost but real tokens - listed, never drawn as $0 flows. */
  readonly zeroCostModels: readonly string[];
  /** Dollar remainder of sessions outside topN (the "other sessions" node). */
  readonly otherSessionsCost: number;
  readonly width: number;
  readonly height: number;
}

const REMAINDER_EPSILON = 1e-6;

/**
 * Build and position the flow graph. Left column: priced models (top
 * MAX_MODEL_NODES by input order, rest folded into "other models"); middle:
 * the all-cost hub; right column: topN sessions plus the honest "other
 * sessions" remainder. Deterministic for identical input.
 */
export function computeCostFlow(
  summary: CostSummaryDto,
  width = 640,
  height = 320,
): CostFlowLayout {
  const pricedModels = summary.perModel.filter((model) => model.costUsd > 0);
  const zeroCostModels = summary.perModel
    .filter((model) => model.costUsd === 0 && (model.tokens > 0 || model.unpricedTokens > 0))
    .map((model) => model.model);

  if (pricedModels.length === 0 || summary.totals.costUsd <= 0) {
    return {
      hasFlow: false,
      nodes: [],
      links: [],
      zeroCostModels,
      otherSessionsCost: 0,
      width,
      height,
    };
  }

  const nodes: FlowNodeSeed[] = [];
  const links: FlowLinkSeed[] = [];
  const hubId = 'hub';

  const shown = pricedModels.slice(0, MAX_MODEL_NODES);
  const folded = pricedModels.slice(MAX_MODEL_NODES);
  shown.forEach((model, index) => {
    const id = `model:${model.model}`;
    nodes.push({
      id,
      label: model.model,
      kind: 'model',
      colorIndex: index,
      unpricedTokens: model.unpricedTokens,
    });
    links.push({ source: id, target: hubId, value: model.costUsd });
  });
  if (folded.length > 0) {
    const foldedCost = folded.reduce((sum, model) => sum + model.costUsd, 0);
    const foldedUnpriced = folded.reduce((sum, model) => sum + model.unpricedTokens, 0);
    nodes.push({
      id: 'other-models',
      label: `other models (${folded.length})`,
      kind: 'other-models',
      colorIndex: null,
      unpricedTokens: foldedUnpriced,
    });
    links.push({ source: 'other-models', target: hubId, value: foldedCost });
  }

  nodes.push({
    id: hubId,
    label: 'all cost',
    kind: 'hub',
    colorIndex: null,
    unpricedTokens: summary.totals.unpricedTokens,
  });

  const pricedSessions = summary.topSessions.filter((session) => session.costUsd > 0);
  let sessionsCost = 0;
  for (const session of pricedSessions) {
    const id = `session:${session.sessionId}`;
    nodes.push({
      id,
      // The label is what the chart paints verbatim: a real project slug in
      // full (never truncated into something that reads like an id), or the
      // shortened session id when no slug was recorded.
      label: session.projectSlug ?? shortId(session.sessionId),
      kind: 'session',
      colorIndex: null,
      unpricedTokens: session.unpricedTokens,
    });
    links.push({ source: hubId, target: id, value: session.costUsd });
    sessionsCost += session.costUsd;
  }
  const otherSessionsCost = summary.totals.costUsd - sessionsCost;
  if (otherSessionsCost > REMAINDER_EPSILON) {
    nodes.push({
      id: 'other-sessions',
      label: 'other sessions',
      kind: 'other-sessions',
      colorIndex: null,
      unpricedTokens: 0,
    });
    links.push({ source: hubId, target: 'other-sessions', value: otherSessionsCost });
  }

  const generator = sankey<FlowNodeSeed, FlowLinkSeed>()
    .nodeId((node) => node.id)
    .nodeWidth(12)
    .nodePadding(10)
    .extent([
      [0, 0],
      [width, height],
    ]);
  const graph: SankeyGraph<FlowNodeSeed, FlowLinkSeed> = generator({
    nodes: nodes.map((node) => ({ ...node })),
    links: links.map((link) => ({ ...link })),
  });

  const colorByNodeId = new Map(nodes.map((node) => [node.id, node.colorIndex]));

  return {
    hasFlow: true,
    nodes: graph.nodes.map((node) => toFlowNode(node)),
    // sankey() has replaced the string endpoints with node objects by now;
    // the cast names that fact once instead of asserting on every field.
    links: graph.links.map((link) => toFlowLink(link as unknown as LaidOutLink, colorByNodeId)),
    zeroCostModels,
    otherSessionsCost: otherSessionsCost > REMAINDER_EPSILON ? otherSessionsCost : 0,
    width,
    height,
  };
}
