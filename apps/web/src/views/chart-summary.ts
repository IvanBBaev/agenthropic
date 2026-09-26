/**
 * Text alternatives for the D3 charts (WP-U7..U9).
 *
 * `role="img"` hides an SVG's whole subtree from assistive technology, so the
 * `<title>` elements inside the tree, the DAG and the sankey are invisible to
 * a screen reader and to anyone who cannot hover. These pure functions build
 * the same honesty facts as prose: the status mix (including `unknown`,
 * unrecorded and unrecognised states), the observed/inferred/unrecognised edge
 * split with the inferring source named, and the unpriced-token gap. The views render
 * the string visibly AND point at it with `aria-describedby`, so the
 * uncertainty is never carried by colour or geometry alone.
 */
import type { AgentNodeDto, OrchestrationEdgeDto } from '../dto';
import { formatTokens, formatUsd } from '../format';
import type { CostFlowLayout, FlowNode } from './layout/cost-flow';
import { isPlaceableEdge } from './layout/layered';
import { edgeProvenance, type EdgeProvenanceKind } from './provenance';
import { statusMeta, UNRECOGNISED_STATUS_LABEL } from './status';

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
   * Set when the payload was truncated, or when the agents it returned and the
   * agents it counted disagree in either direction: how many agents came back,
   * and how many the same read counted. Absent means "this is the whole
   * graph", which is a claim - so a caller that does not know must not set it.
   *
   * AMENDED 2026-09-26 (RR1). Fewer returned than counted is a slice and is
   * said as one. More returned than counted is not a slice of anything; it is
   * stated as a disagreement between the answer and its own count, and this
   * module declines to say which number is right.
   */
  readonly sliceOf?: {
    readonly returnedAgents: number;
    readonly totalAgents: number;
  };
  /**
   * Set when the edges the read returned and the edges it counted disagree in
   * either direction: how many came back, and how many the same read counted.
   * Absent means "the answer carried every edge it counted", which is a claim -
   * so a caller that does not know must not set it. Fewer returned than counted
   * is stated as edges not returned; more returned than counted (RR1,
   * 2026-09-26) is stated as a disagreement, never as a negative gap.
   *
   * Added 2026-09-23 (SA-Z4). Distinct from the `Not drawn` clause this module
   * already computes, and the distinction is the point. That one counts edges
   * that ARE in the payload and cannot be placed, and it is derived from the
   * payload, so this module can find it alone. This one counts edges that
   * never reached the payload at all - `totalEdges` is a COUNT over the whole
   * table while `edges` keeps only those whose endpoints are among the
   * returned agents, and the table carries no foreign key, so an edge naming
   * an agent id with no stored row is counted and can never be returned. No
   * inspection of `edges` can see an edge that is not in `edges`; only the
   * caller holds both numbers.
   */
  readonly unreturnedEdges?: {
    readonly returnedEdges: number;
    readonly totalEdges: number;
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

  // AMENDED 2026-09-23 (lane-EP). This census used to be a two-way split on
  // `source === 'tool_use'`, which made `edges.length - observed` the count of
  // "inferred" edges and folded any unreadable source into it - the paragraph
  // then named that source inside the inferred parenthetical, so the text
  // alternative asserted a join path the server had not claimed. Since this
  // string is what a screen-reader user gets INSTEAD of the picture, it has to
  // draw the same three-way distinction the strokes now do. It routes through
  // `edgeProvenance` rather than repeating the test, so the paragraph and the
  // two charts cannot answer differently about the same edge.
  const provenances = edges.map((edge) => edgeProvenance(edge.source));
  const countOf = (kind: EdgeProvenanceKind): number =>
    provenances.filter((entry) => entry.kind === kind).length;
  const detailsOf = (kind: EdgeProvenanceKind): readonly string[] => [
    ...new Set(provenances.filter((entry) => entry.kind === kind).map((entry) => entry.detail)),
  ];

  const observed = countOf('observed');
  const inferred = countOf('inferred');
  const unrecognised = countOf(UNRECOGNISED_STATUS_LABEL);
  const inferredSources = detailsOf('inferred');
  const inferredDetail = inferredSources.length > 0 ? ` (${inferredSources.join(', ')})` : '';
  // Appended only when there is something to append: a graph whose sources are
  // all readable reads exactly as it did before, byte for byte.
  const unrecognisedDetail =
    unrecognised === 0
      ? ''
      : `, ${String(unrecognised)} ${UNRECOGNISED_STATUS_LABEL} (${detailsOf(UNRECOGNISED_STATUS_LABEL).join(', ')})`;
  const edgePart =
    edges.length === 0
      ? 'No edges.'
      : `Edges: ${String(observed)} observed (tool_use), ${String(inferred)} inferred${inferredDetail}${unrecognisedDetail}.`;

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
  //
  // AMENDED 2026-09-25 (KK5). The clause summed every agent's count and then
  // tested the SUM, so one negative agent (-50) or two that cancel (+100 and
  // -100) produced a total of <= 0 and no sentence at all - while each node's
  // hover title (`unpricedTitleSuffix`) shows that count, by unpriced.tsx's rule
  // that a negative count is as impossible as a NaN one and is shown rather
  // than swallowed. Anomalies are now judged PER AGENT (non-finite or < 0) and
  // named with their values; only the valid positive counts are summed, and
  // that sum is stated as a floor whenever an anomaly sits beside it.
  const anomalous = agents.filter((agent) => isImpossibleUnpriced(agent.unpricedTokens));
  const unpriced = agents
    .filter((agent) => Number.isFinite(agent.unpricedTokens) && agent.unpricedTokens > 0)
    .reduce((sum, agent) => sum + agent.unpricedTokens, 0);
  const anomalyPart =
    anomalous.length === 0
      ? ''
      : ` ${String(anomalous.length)} agent${anomalous.length === 1 ? '' : 's'} reported an unpriced-token count that cannot be right (${anomalous.map((agent) => formatTokens(agent.unpricedTokens)).join(', ')}), so how much of this graph is excluded from every dollar figure is unknown.`;
  const positivePart =
    unpriced > 0
      ? ` ${anomalous.length === 0 ? '' : 'At least '}${formatTokens(unpriced)} tokens carry no price and are excluded from every dollar figure.`
      : '';
  const unpricedPart = `${positivePart}${anomalyPart}`;

  // CS-4 (2026-09-08). Order matches the order the two call sites appended
  // these clauses in, so the paragraph a reader hears is the same paragraph:
  // scope of the count first ("this is 1 of 1200"), then its age ("and it was
  // true two minutes ago"). Both are stated only when the caller knows them -
  // an absent clause here means the caller had nothing to disclose, never that
  // it was dropped on the way.
  // RR1 (2026-09-26): "N of M" is a slice only when N <= M. The other way
  // round is a disagreement, and the clause says so without picking a side.
  const slicePart =
    context.sliceOf === undefined
      ? ''
      : context.sliceOf.returnedAgents <= context.sliceOf.totalAgents
        ? ` This counts the returned slice only: ${String(context.sliceOf.returnedAgents)} of ${String(context.sliceOf.totalAgents)} agents.`
        : ` This counts ${String(context.sliceOf.returnedAgents)} agents while the same read counts only ${String(context.sliceOf.totalAgents)} - the returned graph and the served count disagree, and this page cannot say which is right.`;
  const asOfPart = context.asOf === undefined ? '' : ` As recorded ${context.asOf}, not as of now.`;
  // SA-Z4 (2026-09-23). Sits with `undrawnPart` rather than with the scope
  // clause: both are statements about edges this picture does not contain, and
  // a reader who has only this paragraph needs them next to each other to hear
  // that they are two different gaps rather than one counted twice. It says
  // what it knows and stops - the reason an edge was counted but not returned
  // is a fact about the server's join, and the client holding two numbers
  // cannot tell a dangling reference from anything else that produced the same
  // arithmetic.
  // RR1 (2026-09-26): the subtraction is only a count of missing edges when
  // returned <= total; more returned than counted is stated as what it is.
  const unreturnedPart =
    context.unreturnedEdges === undefined
      ? ''
      : context.unreturnedEdges.returnedEdges <= context.unreturnedEdges.totalEdges
        ? ` Not returned: ${String(context.unreturnedEdges.totalEdges - context.unreturnedEdges.returnedEdges)} of the ${String(context.unreturnedEdges.totalEdges)} edges this same read counts were not in the answer, so they are neither drawn nor described here.`
        : ` The answer carried ${String(context.unreturnedEdges.returnedEdges)} edges while the same read counts only ${String(context.unreturnedEdges.totalEdges)} - the two disagree, and this page cannot say which is right.`;

  return `${statusPart} ${edgePart}${undrawnPart}${unreturnedPart}${unpricedPart}${slicePart}${asOfPart}`;
}

/**
 * KK6 (2026-09-25). An unpriced count no real usage can produce: unreadable
 * (non-finite) or below zero. unpriced.tsx's rule is that such a count is
 * shown rather than swallowed, and `describeAgentGraph` (KK5) judges its
 * agents by this same test; the sankey's prose and hover share it from here so
 * the three cannot drift apart.
 */
export function isImpossibleUnpriced(tokens: number): boolean {
  return !Number.isFinite(tokens) || tokens < 0;
}

/**
 * How an impossible unpriced count is spoken. An unreadable one already says
 * so through `formatTokens`; a negative one prints as a plain number, which a
 * reader could take for a measured figure, so it carries the same "cannot be
 * right" wording the agent-graph prose uses.
 */
export function impossibleUnpricedText(tokens: number): string {
  return Number.isFinite(tokens)
    ? `${formatTokens(tokens)}, a count that cannot be right`
    : formatTokens(tokens);
}

function describeFlowNode(node: FlowNode): string {
  // AMENDED 2026-09-07 (CS-2). Same hole as the graph total, per node: a
  // non-finite unpriced count failed `> 0` and printed the node as if its
  // whole usage were priced. An unreadable count is now said out loud.
  //
  // AMENDED 2026-09-25 (KK6). A negative count failed `> 0` the same way. Every
  // impossible count is now named with its value; only a measured zero is
  // silent.
  const tokens = node.unpricedTokens;
  const unpriced = isImpossibleUnpriced(tokens)
    ? ` (plus unpriced: ${impossibleUnpricedText(tokens)})`
    : tokens === 0
      ? ''
      : ` (plus ~${formatTokens(tokens)} unpriced)`;
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
  //
  // AMENDED 2026-09-25 (KK6). A negative total failed `> 0` as silently, and
  // the total was never read against the nodes it sums: +100 on one node and
  // -100 on another serve a total of 0 and produced no sentence while the
  // node list above named the -100. By KK5's rule for `describeAgentGraph`,
  // an impossible total is named with its value; otherwise every impossible
  // node count (the hub is excluded - it carries this same total) is named in
  // one sentence, and a positive total beside one is stated as a floor.
  const nodeAnomalies = flow.nodes.filter(
    (node) => node.kind !== 'hub' && isImpossibleUnpriced(node.unpricedTokens),
  );
  if (isImpossibleUnpriced(unpricedTokens)) {
    parts.push(
      `The unpriced-token total came back ${impossibleUnpricedText(unpricedTokens)}, so how much sits outside this flow is unknown.`,
    );
  } else {
    if (unpricedTokens > 0) {
      parts.push(
        `${nodeAnomalies.length === 0 ? '' : 'At least '}${formatTokens(unpricedTokens)} tokens carry no price and are outside this flow.`,
      );
    }
    if (nodeAnomalies.length > 0) {
      parts.push(
        `${String(nodeAnomalies.length)} node${nodeAnomalies.length === 1 ? '' : 's'} reported an unpriced-token count that cannot be right (${nodeAnomalies.map((node) => `${node.label} ${formatTokens(node.unpricedTokens)}`).join(', ')}), so how much sits outside this flow is unknown.`,
      );
    }
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
