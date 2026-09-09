/**
 * Pure sankey layout for the cost view (WP-U9): model -> all cost -> session
 * flows, computed synchronously with d3-sankey. Every link value is a dollar
 * figure the API actually served - the module NEVER apportions model cost
 * across sessions (the summary has no model-by-session matrix, so inventing
 * one would be fabrication). What cannot be drawn as a dollar flow is
 * reported instead of hidden: zero-cost models (unpriced-only usage), the
 * "other sessions" remainder outside topN, and the unpriced token total.
 *
 * AMENDED 2026-09-02 (F-7, F-8). "What cannot be drawn as a dollar flow is
 * reported instead of hidden" was the intent, and it was not the behaviour.
 * Two gaps sat under it, both persuasive because the happy path looks right.
 * (1) The model split was `> 0` drawn / `=== 0` reported, exhaustive only
 * while every served cost is zero or positive - and the wire schema's
 * `Type.Number({ minimum: 0 })` is a documented no-op at serialize time, so a
 * negative or non-finite cost matched NEITHER arm and left no trace anywhere
 * on the page. (2) The diagram's two sides are built from two INDEPENDENT
 * server fields - inflow from `perModel`, outflow from `totals.costUsd` - and
 * nothing checked that they agree; d3-sankey resolves any disagreement in
 * silence by taking the larger side as the hub's value, so a corpus whose own
 * breakdown contradicts its own total still drew as a clean, balanced
 * picture. `undrawable` and `balance` close both: nothing leaves the diagram
 * without being named, and the diagram says out loud when it does not account
 * for itself.
 *
 * AMENDED 2026-09-08 (CF-2). `balance` reconciles the SERVED sums and never
 * looks at the ribbons, so it is not the check the hub's LABEL needs. The hub
 * is the one node claiming to be a whole, and its two sides are built from two
 * different served fields - `perModel` entering, top sessions plus a remainder
 * cut from `totals.costUsd` leaving. Only the entering side was ever compared
 * against the total, so a corpus whose sessions overshoot their own total drew
 * $1.00 of ribbons in and $3.00 out and had the word "all" painted over the
 * larger of them. {@link HubDraw} reports both drawn sides, and the label is
 * now a claim no larger than the ribbons support.
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

/**
 * Layout node -> render node; missing geometry becomes 0, never NaN.
 *
 * AMENDED 2026-09-02 (F-8). True and complete for the four geometry fields: a
 * missing coordinate is a layout artefact and 0 is a safe pixel. It is not
 * true for `value`, which is MONEY - see {@link flowNodeValueUsd}, which
 * `computeCostFlow` routes that one field through. The `?? 0` here is left
 * standing because this converter's zero-for-value output is pinned by an
 * existing regression test, and the house rule is to extend rather than
 * rewrite; no production path reaches it with the value absent.
 */
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
 * The dollar figure a laid-out node carries, or `NaN` when the layout never
 * gave it one.
 *
 * `?? 0` is the right default for a missing pixel and the wrong one for a
 * missing amount: it turns "this node's total was never computed" into a
 * measured $0.00, which is precisely the silent zero this dashboard exists to
 * refuse. `NaN` is the app's existing carrier for "not a readable amount"
 * (`formatUsd` renders it as UNREADABLE_USD), so the gap survives every
 * formatter it passes through instead of being invented into a figure.
 */
export function flowNodeValueUsd(node: LaidOutNode): number {
  return node.value ?? Number.NaN;
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

/**
 * A served per-model or per-session cost that no ribbon can carry: negative
 * (a flow has no direction for it) or not a number at all (it has no width).
 * Named in prose beside the diagram, with the amount EXACTLY as served - the
 * one thing that must never happen to it is being quietly dropped or coerced
 * into a drawable zero.
 */
export interface UndrawableCost {
  /** Already-presentable subject, e.g. `model claude-opus-4`. */
  readonly label: string;
  /** Exactly what the server served, sign and all; may be non-finite. */
  readonly costUsd: number;
}

/**
 * Whether the diagram's two independently-served sides account for each
 * other. The inflow is built from `perModel`, the outflow from
 * `totals.costUsd`; the server derives both from one pass over the same
 * rollup, so they agree unless something upstream is wrong - which is exactly
 * why a disagreement must be said out loud rather than absorbed by the layout.
 */
export interface FlowBalance {
  /** Sum of every READABLE per-model cost served, sign included. */
  readonly perModelUsd: number;
  /** Sum of the top sessions actually drawn as ribbons. */
  readonly sessionsUsd: number;
  /** The served corpus total - the field the whole outflow side is built from. */
  readonly totalUsd: number;
  /**
   * `perModelUsd - totalUsd` once it exceeds {@link BALANCE_EPSILON}, else
   * exactly 0. Non-zero means the server's own breakdown and its own total
   * contradict each other.
   */
  readonly modelsMinusTotalUsd: number;
  /**
   * How far the drawn top sessions overshoot the served total, else 0. The
   * remainder node cannot carry a negative value, so without this the
   * overshoot would leave no trace at all.
   */
  readonly sessionsOverTotalUsd: number;
  /** False when `totals.costUsd` is not a finite number, so nothing reconciles. */
  readonly totalReadable: boolean;
  /** True only when every check above holds - the picture accounts for itself. */
  readonly balanced: boolean;
}

/**
 * What the DRAWN ribbons carry either side of the hub, and whether that
 * supports the hub's label (CF-2).
 *
 * Deliberately not part of {@link FlowBalance}: that one reconciles the sums
 * the server SERVED, and both of these are sums of what the layout could
 * actually turn into a ribbon. The two differ exactly when something served
 * was left out of the drawing, which is the case the hub's label used to get
 * wrong.
 */
export interface HubDraw {
  /** Dollars the drawn model ribbons carry into the hub. */
  readonly inUsd: number;
  /** Dollars the drawn session ribbons - top sessions plus the remainder - carry out. */
  readonly outUsd: number;
  /**
   * Whether the two drawn sides are within {@link BALANCE_EPSILON} of each
   * other. False means d3-sankey had to pick one: `node.value` is
   * `max(inflow, outflow)`, so the figure on the hub is one side of a
   * disagreement and nothing about the picture shows which.
   */
  readonly sidesAgree: boolean;
  /**
   * True only when the sides agree AND they agree with the served total - the
   * one state in which the hub can honestly be called `all cost`. Written as
   * `sidesAgree && ...` rather than as two independent comparisons against the
   * total, because two sides can each sit within an epsilon of the total while
   * being two epsilons apart from each other.
   */
  readonly isWhole: boolean;
}

/**
 * The hub facts of a diagram that has no hub. Not a measurement: with no
 * ribbons there are no sides to disagree, and no label exists that could
 * overclaim. `isWhole: false` is the honest reading - nothing here is being
 * called `all cost`.
 */
const NO_HUB_DRAWN: HubDraw = { inUsd: 0, outUsd: 0, sidesAgree: true, isWhole: false };

export interface CostFlowLayout {
  /** False when nothing has a positive price - render honest copy, not an empty SVG. */
  readonly hasFlow: boolean;
  readonly nodes: readonly FlowNode[];
  readonly links: readonly FlowLink[];
  /** Models with $0 priced cost but real tokens - listed, never drawn as $0 flows. */
  readonly zeroCostModels: readonly string[];
  /** Dollar remainder of sessions outside topN (the "other sessions" node). */
  readonly otherSessionsCost: number;
  /**
   * Model and session costs a ribbon cannot carry, named with the amount the
   * server served. Empty in the healthy case - this list is silent unless
   * something really is undrawable.
   */
  readonly undrawable: readonly UndrawableCost[];
  /** Whether the two independently-served sides of the diagram agree. */
  readonly balance: FlowBalance;
  /** What the drawn ribbons carry either side of the hub (CF-2). */
  readonly hub: HubDraw;
  readonly width: number;
  readonly height: number;
}

const REMAINDER_EPSILON = 1e-6;

/**
 * Reconciliation threshold: $0.0001, the smallest amount `formatUsd` prints as
 * a distinct figure. Conservative in BOTH directions on purpose. It sits
 * orders of magnitude above the drift two different summation orders of the
 * same doubles can produce (worst case ~2e-6 for a million-row corpus), so the
 * disclosure cannot fire on arithmetic noise - a warning that cries wolf is
 * spent credibility. And it goes no higher, so nothing a reader could actually
 * see on screen is swallowed. This is a floating-point floor, NOT an
 * owner-set tolerance for real accounting error.
 */
const BALANCE_EPSILON = 1e-4;

type ModelCost = CostSummaryDto['perModel'][number];
type SessionCost = CostSummaryDto['topSessions'][number];

/** A served amount a ribbon can carry: a real number, strictly positive. */
function isDrawableCost(costUsd: number): boolean {
  return Number.isFinite(costUsd) && costUsd > 0;
}

/**
 * A served amount a ribbon CANNOT carry and that must therefore be named in
 * prose: negative, or not a number at all. Deliberately not the negation of
 * {@link isDrawableCost} - exactly $0 is neither drawable nor a fault, and
 * lumping it in here would fire a hazard notice at a perfectly ordinary
 * unpriced-only row.
 */
function isUndrawableCost(costUsd: number): boolean {
  return !Number.isFinite(costUsd) || costUsd < 0;
}

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
  // AMENDED 2026-09-02 (F-7). This used to be two filters, `> 0` drawn and
  // `=== 0` listed, which is a total partition only if a served cost is always
  // zero or positive. It is not: the wire schema's `minimum: 0` never runs at
  // serialize time. A negative cost therefore matched neither filter and was
  // deleted from the page in silence. The loop below is total over the sign
  // domain - every served row lands in exactly one bucket, and every bucket is
  // rendered somewhere.
  const undrawable: UndrawableCost[] = [];
  const pricedModels: ModelCost[] = [];
  const zeroCostModels: string[] = [];
  let perModelUsd = 0;
  for (const model of summary.perModel) {
    if (isDrawableCost(model.costUsd)) {
      pricedModels.push(model);
      perModelUsd += model.costUsd;
      continue;
    }
    if (isUndrawableCost(model.costUsd)) {
      undrawable.push({ label: `model ${model.model}`, costUsd: model.costUsd });
      // A non-finite cost is deliberately kept OUT of `perModelUsd`: one NaN
      // would poison the sum and silence the reconciliation below, which is
      // the only other check that would have noticed it.
      if (Number.isFinite(model.costUsd)) perModelUsd += model.costUsd;
      continue;
    }
    // Exactly $0. Real usage behind it is worth naming; a row with no tokens
    // at all is genuinely nothing to report.
    if (model.tokens > 0 || model.unpricedTokens > 0) zeroCostModels.push(model.model);
  }

  const pricedSessions: SessionCost[] = [];
  let sessionsCost = 0;
  for (const session of summary.topSessions) {
    if (isDrawableCost(session.costUsd)) {
      pricedSessions.push(session);
      sessionsCost += session.costUsd;
      continue;
    }
    // F-7, session side. A $0 session is genuinely absorbed by the "other
    // sessions" remainder and needs no note. A negative or unreadable one is
    // not: `sessionsCost` cannot carry it, the remainder cannot represent it,
    // and without this line it would leave the diagram with nothing said.
    if (isUndrawableCost(session.costUsd)) {
      undrawable.push({
        label: `session ${session.projectSlug ?? shortId(session.sessionId)}`,
        costUsd: session.costUsd,
      });
    }
  }

  // AMENDED 2026-09-02 (F-8). The inflow is summed from `perModel` and the
  // outflow from `totals.costUsd` - two separate fields on the wire. When they
  // disagree d3-sankey does not complain; it sets the hub's value to the
  // larger side and draws a picture that looks balanced because a sankey
  // always does. These three checks are the only thing standing between the
  // reader and a diagram that quietly picked a winner.
  //
  // AMENDED 2026-09-07 (CF-1). "the only thing standing between the reader and
  // a diagram that quietly picked a winner" overstated what these three catch.
  // They reconcile the SERVED sums, and `perModelUsd` includes a finite
  // negative - so a $1.00 model beside a -$0.30 refund reconciles exactly
  // against a $0.70 total and every check here stays silent, while the drawn
  // ribbons still carry $1.00 into the hub, because a negative cannot be a
  // ribbon. The hub's LABEL is what closed that: see `hubIsWhole` below.
  const totalUsd = summary.totals.costUsd;
  const totalReadable = Number.isFinite(totalUsd);
  const modelsGap = totalReadable ? perModelUsd - totalUsd : 0;
  const sessionsGap = totalReadable ? sessionsCost - totalUsd : 0;
  const modelsMinusTotalUsd = Math.abs(modelsGap) > BALANCE_EPSILON ? modelsGap : 0;
  const sessionsOverTotalUsd = sessionsGap > BALANCE_EPSILON ? sessionsGap : 0;
  const balance: FlowBalance = {
    perModelUsd,
    sessionsUsd: sessionsCost,
    totalUsd,
    modelsMinusTotalUsd,
    sessionsOverTotalUsd,
    totalReadable,
    balanced: totalReadable && modelsMinusTotalUsd === 0 && sessionsOverTotalUsd === 0,
  };

  if (pricedModels.length === 0 || summary.totals.costUsd <= 0) {
    return {
      hasFlow: false,
      nodes: [],
      links: [],
      zeroCostModels,
      otherSessionsCost: 0,
      undrawable,
      balance,
      hub: NO_HUB_DRAWN,
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

  // AMENDED 2026-09-07 (CF-1). The hub was labelled 'all cost' unconditionally,
  // and it is the one node in the picture that claims to be a WHOLE - the view
  // paints that label beside it and puts it in the node's hover text next to
  // d3-sankey's own value, which is max(inflow, outflow). Whenever a served
  // cost could not become a ribbon (a negative, an unreadable amount) or the
  // sums do not reconcile, that number is the drawn ribbons and NOT the served
  // total, so a reader comparing it against the total on the same page met two
  // different dollar figures both called "all". The label now claims only what
  // the ribbons support; the undrawable/balance notices say why they differ.
  //
  // AMENDED 2026-09-08 (CF-2). The paragraph above is right about the hazard
  // and closed half of it. `hubIsWhole` compared the ENTERING side against the
  // served total and never looked at the leaving side, which is a separate
  // sum of separate served fields - the drawn top sessions plus a remainder
  // cut from `totals.costUsd`. When the top sessions overshoot that total the
  // remainder goes negative, no remainder ribbon is drawn, and the leaving
  // side is then the sessions alone: $1.00 of model ribbons enter, $3.00 of
  // session ribbons leave, the entering side still matches the served $1.00,
  // and the hub was therefore labelled `all cost` while d3-sankey printed
  // $3.00 on it - against a Total cost tile on the same page reading $1.00.
  // The check is now two-sided. A hub whose sides disagree is not called a
  // cost at all: it is called what the figure actually is, `larger drawn
  // side`, and the imbalance note (chart-summary.ts) quotes both sides.
  const otherSessionsCost = summary.totals.costUsd - sessionsCost;
  // One predicate for "a remainder ribbon exists", asked three times below.
  // The hub's leaving side is computed from the SAME test that decides whether
  // the ribbon is drawn, so the two cannot drift into disagreement.
  const drawsRemainder = otherSessionsCost > REMAINDER_EPSILON;
  const drawnIntoHubUsd = pricedModels.reduce((sum, model) => sum + model.costUsd, 0);
  const drawnOutOfHubUsd = sessionsCost + (drawsRemainder ? otherSessionsCost : 0);
  const sidesAgree = Math.abs(drawnIntoHubUsd - drawnOutOfHubUsd) <= BALANCE_EPSILON;
  const hub: HubDraw = {
    inUsd: drawnIntoHubUsd,
    outUsd: drawnOutOfHubUsd,
    sidesAgree,
    isWhole: sidesAgree && Math.abs(drawnIntoHubUsd - totalUsd) <= BALANCE_EPSILON,
  };
  nodes.push({
    id: hubId,
    label: hub.isWhole ? 'all cost' : hub.sidesAgree ? 'drawn cost' : 'larger drawn side',
    kind: 'hub',
    colorIndex: null,
    unpricedTokens: summary.totals.unpricedTokens,
  });

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
  }
  // CF-2: `otherSessionsCost` and `drawsRemainder` are computed above, beside
  // the hub, because the hub's label cannot be decided without knowing what
  // leaves it. Same values, same test, one place.
  if (drawsRemainder) {
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
    // The money field is taken from `flowNodeValueUsd`, not from
    // `toFlowNode`'s `?? 0` - see that helper for why a missing AMOUNT must
    // not degrade the way a missing COORDINATE does.
    nodes: graph.nodes.map((node) => ({ ...toFlowNode(node), value: flowNodeValueUsd(node) })),
    // sankey() has replaced the string endpoints with node objects by now;
    // the cast names that fact once instead of asserting on every field.
    links: graph.links.map((link) => toFlowLink(link as unknown as LaidOutLink, colorByNodeId)),
    zeroCostModels,
    otherSessionsCost: drawsRemainder ? otherSessionsCost : 0,
    undrawable,
    balance,
    hub,
    width,
    height,
  };
}
