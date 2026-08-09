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
 * Prose summary of an agent graph: what the nodes are doing, which edges are
 * observed vs inferred (and from which signal), and how many tokens carry no
 * price. Empty inputs say so rather than producing a confident empty phrase.
 */
export function describeAgentGraph(
  agents: readonly AgentNodeDto[],
  edges: readonly OrchestrationEdgeDto[],
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

  const unpriced = agents.reduce((sum, agent) => sum + agent.unpricedTokens, 0);
  const unpricedPart =
    unpriced > 0
      ? ` ${formatTokens(unpriced)} tokens carry no price and are excluded from every dollar figure.`
      : '';

  return `${statusPart} ${edgePart}${unpricedPart}`;
}

function describeFlowNode(node: FlowNode): string {
  const unpriced =
    node.unpricedTokens > 0 ? ` (plus ~${formatTokens(node.unpricedTokens)} unpriced)` : '';
  return `${node.label} ${formatUsd(node.value)}${unpriced}`;
}

/**
 * Prose summary of the cost sankey: the dollar entering from each model, the
 * dollar leaving to each session, the models that have usage but no price
 * (so they are absent from the picture), and the unpriced total that sits
 * outside every flow.
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
  if (unpricedTokens > 0) {
    parts.push(`${formatTokens(unpricedTokens)} tokens carry no price and are outside this flow.`);
  }
  return parts.join(' ');
}
