/**
 * Text alternatives for the D3 charts (WP-U7..U9).
 *
 * `role="img"` hides an SVG's whole subtree from assistive technology, so the
 * `<title>` elements inside the tree, the DAG and the sankey are invisible to
 * a screen reader and to anyone who cannot hover. These pure functions build
 * the same honesty facts as prose: the status mix (including `unknown`,
 * unrecorded and unrecognised states), the observed/inferred edge split with
 * the inferring source named, and the unpriced-token gap. The views render
 * the string visibly AND point at it with `aria-describedby`, so the
 * uncertainty is never carried by colour or geometry alone.
 */
import type { AgentNodeDto, OrchestrationEdgeDto } from '../dto';
import { formatTokens, formatUsd } from '../format';
import type { CostFlowLayout, FlowNode } from './layout/cost-flow';
import { isPlaceableEdge } from './layout/layered';
import { statusMeta } from './status';

/** `n label` phrases in first-seen order, e.g. `2 working, 1 unknown`. */
function tallyStatuses(agents: readonly AgentNodeDto[]): string {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const label = statusMeta(agent.status).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${String(count)} ${label}`).join(', ');
}

/**
 * The two facts a graph payload cannot carry about itself: when it was read,
 * and whether the served node list is the whole graph or a cut of one. Both
 * fields are optional because a caller without them is not thereby hiding
 * anything - a session tree endpoint returns the whole session, and a reading
 * taken a second ago is not usefully dated.
 *
 * Added 2026-09-08 (CS-4). See the amendment on `describeAgentGraph`.
 */
export interface AgentGraphContext {
  /**
   * The age of the read, phrased exactly as `snapshotAge` phrases it (`2m
   * ago`). Callers set it only once the reading is old enough to matter: a
   * date stamped on every render is the kind of uniform caveat that stops
   * being read, which is the same disclosure failure by another route.
   */
  readonly asOf?: string;
  /**
   * Set only when the payload was truncated: how many agents came back, and
   * how many the same read counted. Absent means "this is the whole graph",
   * which is a claim - so a caller that does not know must not set it.
   */
  readonly sliceOf?: {
    readonly returnedAgents: number;
    readonly totalAgents: number;
  };
}

/**
 * Prose summary of an agent graph: what the nodes are doing, which edges are
 * observed vs inferred (and from which signal), and how many tokens carry no
 * price. Empty inputs say so rather than producing a confident empty phrase.
 *
 * AMENDED 2026-09-08 (CS-4). This function used to end at the unpriced gap,
 * and both callers then appended the rest of the truth themselves: DagView
 * built an " As recorded ... " clause and a " This counts the returned slice
 * only: N of M agents." clause and concatenated them into the same paragraph;
 * SessionsView built the first of the two. So the string this module returned
 * was, on its own, a present-tense tally of a whole graph - and it was only
 * ever true because two call sites remembered to qualify it afterwards. That
 * is the fragile arrangement: the qualification lived furthest from the claim
 * it corrects, and the next caller - or the next refactor of an existing one -
 * inherits a confident sentence with nothing attached to say it is a
 * two-minute-old count of 1 agent out of 1200.
 *
 * The qualification now belongs to the sentence it qualifies. The wording is
 * carried over verbatim from the call sites, so the rendered paragraph is
 * unchanged; `context` is optional and an absent (or empty) one reproduces the
 * old string byte for byte, so nothing that calls this with two arguments
 * changes. What deliberately did NOT move here: `cyclicNodes`, which is a fact
 * about the LAYOUT rather than about the served graph - this module never sees
 * a layout, and inventing a way to pass one in would put geometry inside a
 * data summary. The views disclose it beside the chart (see DG-3).
 */
export function describeAgentGraph(
  agents: readonly AgentNodeDto[],
  edges: readonly OrchestrationEdgeDto[],
  context: AgentGraphContext = {},
): string {
  const statusPart =
    agents.length === 0 ? 'No agents.' : `Agents by status: ${tallyStatuses(agents)}.`;

  const observed = edges.filter((edge) => edge.source === 'tool_use').length;
  const inferredSources = [
    ...new Set(edges.filter((edge) => edge.source !== 'tool_use').map((edge) => edge.source)),
  ];
  const inferredDetail = inferredSources.length > 0 ? ` (${inferredSources.join(', ')})` : '';
  const edgePart =
    edges.length === 0
      ? 'No edges.'
      : `Edges: ${String(observed)} observed (tool_use), ${String(edges.length - observed)} inferred${inferredDetail}.`;

  // AMENDED 2026-09-07 (CS-1). `edgePart` used to be the whole edge story, and
  // it is a census of the SERVED list, not of the drawn one: `computeLayeredLayout`
  // silently omits every edge whose parent or child is absent from the node
  // payload (truncated slice, or a parent outside the session). A reader who
  // meets the graph as an image - which is exactly this string's audience - was
  // therefore told "3 edges" about a picture holding one line, with the count
  // of missing ones living only in sighted prose beside the chart. The rule is
  // asked of `isPlaceableEdge` so it cannot drift from the geometry's.
  const nodeIds = new Set(agents.map((agent) => agent.id));
  const undrawn = edges.filter(
    (edge) =>
      !isPlaceableEdge(nodeIds, { parentId: edge.parentAgentId, childId: edge.childAgentId }),
  ).length;
  const undrawnPart =
    undrawn > 0
      ? ` Not drawn: ${String(undrawn)} edge${undrawn === 1 ? '' : 's'} pointing at an agent that is not in this picture.`
      : '';

  // AMENDED 2026-09-07 (CS-2). The clause was gated on `unpriced > 0`, and a
  // non-finite total fails that test as quietly as a zero one does - so a graph
  // whose unpriced count arrived unreadable produced a string with NO unpriced
  // sentence, which is the same string a fully-priced graph produces. Silence
  // here reads as "everything carries a price"; the gap is now named with the
  // app's own vocabulary for an unreadable count.
  const unpriced = agents.reduce((sum, agent) => sum + agent.unpricedTokens, 0);
  const unpricedPart = !Number.isFinite(unpriced)
    ? ` The unpriced-token total came back ${formatTokens(unpriced)}, so how much of this graph is excluded from every dollar figure is unknown.`
    : unpriced > 0
      ? ` ${formatTokens(unpriced)} tokens carry no price and are excluded from every dollar figure.`
      : '';

  // CS-4 (2026-09-08). Order matches the order the two call sites appended
  // these clauses in, so the paragraph a reader hears is the same paragraph:
  // scope of the count first ("this is 1 of 1200"), then its age ("and it was
  // true two minutes ago"). Both are stated only when the caller knows them -
  // an absent clause here means the caller had nothing to disclose, never that
  // it was dropped on the way.
  const slicePart =
    context.sliceOf === undefined
      ? ''
      : ` This counts the returned slice only: ${String(context.sliceOf.returnedAgents)} of ${String(context.sliceOf.totalAgents)} agents.`;
  const asOfPart = context.asOf === undefined ? '' : ` As recorded ${context.asOf}, not as of now.`;

  return `${statusPart} ${edgePart}${undrawnPart}${unpricedPart}${slicePart}${asOfPart}`;
}

function describeFlowNode(node: FlowNode): string {
  // AMENDED 2026-09-07 (CS-2). Same hole as the graph total, per node: a
  // non-finite unpriced count failed `> 0` and printed the node as if its
  // whole usage were priced. An unreadable count is now said out loud.
  const unpriced = !Number.isFinite(node.unpricedTokens)
    ? ` (plus unpriced: ${formatTokens(node.unpricedTokens)})`
    : node.unpricedTokens > 0
      ? ` (plus ~${formatTokens(node.unpricedTokens)} unpriced)`
      : '';
  return `${node.label} ${formatUsd(node.value)}${unpriced}`;
}

/**
 * CV-2 (2026-09-08). What the hub's hover figure is, and why it can disagree
 * with the ribbons drawn either side of it.
 *
 * The hover printed `node.value` next to the hub's label and left the number
 * unexplained. `node.value` is d3-sankey's, and d3-sankey resolves a node
 * whose two sides do not agree by taking the LARGER of them - verbatim from
 * d3-sankey 0.12.3, sankey.js:
 *
 *     node.value = Math.max(sum(node.sourceLinks, value), sum(node.targetLinks, value))
 *
 * The hub's sides are served independently and computed apart: what enters is
 * the drawable `perModel` rows, what leaves is the drawn top sessions plus a
 * remainder derived from `totals.costUsd` (see cost-flow.ts). So a diagram
 * with $12.00 of ribbons arriving and $40.00 leaving hovered as a flat "drawn
 * cost: $40.00", and - because the layout's `hubIsWhole` test compares only
 * the ENTERING side against the served total, never the leaving one - a hub
 * can even be labelled "all cost" and hover a figure the Total cost tile
 * above contradicts. Nothing else on the page closes that: the balance
 * banner compares the SERVED sums, not the drawn ribbons, and describeCostFlow
 * (chart-summary.ts, another lane) never mentions the hub at all.
 *
 * Deliberately NOT changed: the max() itself. It is d3-sankey's contract and
 * the geometry is laid out from it, so overriding the figure here would put
 * a number on the page that does not match the picture beside it. What
 * changed is that the figure now arrives with the two sides it was chosen
 * from and the size of the gap between them. When the sides agree - the
 * healthy case, and every balanced corpus - this says nothing at all.
 *
 * AMENDED 2026-09-08 (CF-2). Three things in the docblock above are now out of
 * date, and the sentence they were written against is fixed rather than
 * restated. (1) "the layout's `hubIsWhole` test compares only the ENTERING
 * side" was the root cause and is closed: the layout checks both drawn sides,
 * and a hub whose sides disagree is labelled `larger drawn side` rather than
 * `all cost`, so this note no longer has to rescue a label that contradicts
 * the page. It stays because the corrected label names the figure and cannot
 * quantify it - the reader still needs the two sides and the gap, and the
 * label and this note now fire on ONE predicate (`flow.hub.sidesAgree`), so
 * they cannot say different things about the same picture. (2) "describeCostFlow
 * ... never mentions the hub at all" was true and was the reason CostView
 * appended this string to the prose itself; the note now LIVES in the prose
 * builder, by the argument `describeAgentGraph` records above under CS-4 - a
 * qualification kept by the call sites is a convention, not a property of the
 * summary, and the next caller inherits the confident sentence without it.
 * CostView imports it for the hover, so both renderings are still one string.
 * (3) The gap is no longer measured here: the two sides and the epsilon that
 * decides they disagree come from the layout, which is the only place that
 * knows which ribbons were actually drawn.
 */
export function hubImbalanceNote(node: FlowNode, flow: CostFlowLayout): string {
  if (node.kind !== 'hub') return '';
  if (flow.hub.sidesAgree) return '';
  const { inUsd, outUsd } = flow.hub;
  const gapUsd = Math.abs(inUsd - outUsd);
  return `The hub's two sides do not match: ribbons carrying ${formatUsd(inUsd)} enter it and ribbons carrying ${formatUsd(outUsd)} leave, a gap of ${formatUsd(gapUsd)}. The figure printed on the hub is the larger of those two sides - what a sankey node takes when its sides disagree - not a third amount the server served.`;
}

/**
 * Prose summary of the cost sankey: the dollar entering from each model, the
 * dollar leaving to each session, the models that have usage but no price
 * (so they are absent from the picture), and the unpriced total that sits
 * outside every flow.
 *
 * AMENDED 2026-09-08 (CF-2). The list above was the whole function and it left
 * out the hub - the one node that claims to be a whole - so this string
 * enumerated a confident, self-consistent flow while the hub in the middle of
 * it could be carrying two sides that disagree. The paragraph on screen did
 * carry the caveat, because CostView appended it after calling this; that is
 * the arrangement CS-4 rejected two functions up. It is stated here now, and
 * stated last, so the rendered paragraph is unchanged.
 */
export function describeCostFlow(flow: CostFlowLayout, unpricedTokens: number): string {
  if (!flow.hasFlow) return 'No priced dollar flow to draw.';

  const models = flow.nodes.filter((node) => node.kind === 'model' || node.kind === 'other-models');
  const sessions = flow.nodes.filter(
    (node) => node.kind === 'session' || node.kind === 'other-sessions',
  );
  const parts = [
    `Priced dollar flow. From models: ${models.map(describeFlowNode).join(', ')}.`,
    `To sessions: ${sessions.map(describeFlowNode).join(', ')}.`,
  ];
  if (flow.zeroCostModels.length > 0) {
    parts.push(`Usage but nothing priced, so not drawn: ${flow.zeroCostModels.join(', ')}.`);
  }
  // AMENDED 2026-09-07 (CS-2). See `describeAgentGraph`: `> 0` treated an
  // unreadable total as an absent one, and the only signal this string carries
  // about unpriced usage is the presence of the sentence.
  if (!Number.isFinite(unpricedTokens)) {
    parts.push(
      `The unpriced-token total came back ${formatTokens(unpricedTokens)}, so how much sits outside this flow is unknown.`,
    );
  } else if (unpricedTokens > 0) {
    parts.push(`${formatTokens(unpricedTokens)} tokens carry no price and are outside this flow.`);
  }
  // CF-2: the hub, stated LAST. Last because everything above enumerates
  // ribbons the reader can trust one at a time, and this is the sentence that
  // says the node they all meet at does not add up - a caveat read before the
  // figures it qualifies is a caveat about nothing. Only the hub yields a
  // string, so the join is that one note or the empty string.
  const hubNote = flow.nodes.map((node) => hubImbalanceNote(node, flow)).join('');
  if (hubNote !== '') parts.push(hubNote);
  return parts.join(' ');
}
