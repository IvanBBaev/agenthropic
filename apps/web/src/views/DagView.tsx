/**
 * (c) Global orchestration DAG (WP-U8): every persisted agent across all
 * sessions, laid out by the pure layered module - the hierarchy drawn is
 * exactly the edge set the API served. Truncation is surfaced honestly:
 * when the node limit cuts the graph, the banner says "showing N of M",
 * never pretending the visible slice is the whole story. Solid edges are
 * observed (`tool_use`); dashed edges are inferred.
 */
import { useEffect, useState } from 'react';
import { fetchGlobalDag } from '../api';
import type { GlobalDagDto } from '../dto';
import { formatTokens, formatUsd, shortId } from '../format';
import { computeLayeredLayout } from './layout/layered';
import { statusMeta } from './status';
import type { ViewProps } from './types';

/** Node cap requested from the server (its own max is higher). */
export const DAG_NODE_LIMIT = 1000;

type DagState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly dag: GlobalDagDto };

export function DagView({ token, onAuthRejected }: ViewProps) {
  const [state, setState] = useState<DagState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void fetchGlobalDag(token, DAG_NODE_LIMIT, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setState({ kind: 'error', message: result.message });
      } else {
        setState({ kind: 'ready', dag: result.data });
      }
    });
    return () => controller.abort();
  }, [token, onAuthRejected]);

  if (state.kind === 'loading') {
    return (
      <section aria-label="global dag">
        <p className="muted">Loading DAG…</p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section aria-label="global dag">
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load DAG: {state.message}
        </p>
      </section>
    );
  }

  const { dag } = state;
  if (dag.nodes.length === 0) {
    return (
      <section aria-label="global dag">
        <p className="empty-state">
          No agents persisted yet - the DAG appears with the first ingest.
        </p>
      </section>
    );
  }

  const layout = computeLayeredLayout(
    dag.nodes,
    dag.edges.map((edge) => ({
      parentId: edge.parentAgentId,
      childId: edge.childAgentId,
      payload: edge,
    })),
  );

  return (
    <section aria-label="global dag">
      {dag.counts.truncated ? (
        <p className="truncation-banner" data-testid="truncation-banner">
          Truncated: showing {dag.counts.returnedAgents} of {dag.counts.totalAgents} agents and{' '}
          {dag.counts.returnedEdges} of {dag.counts.totalEdges} edges (node limit {DAG_NODE_LIMIT}).
        </p>
      ) : (
        <p className="muted">
          {dag.counts.totalAgents} agent{dag.counts.totalAgents === 1 ? '' : 's'} across{' '}
          {dag.counts.totalSessions} session{dag.counts.totalSessions === 1 ? '' : 's'},{' '}
          {dag.counts.totalEdges} edge{dag.counts.totalEdges === 1 ? '' : 's'}.
        </p>
      )}
      {layout.droppedEdges > 0 && (
        <p className="muted">
          {layout.droppedEdges} edge{layout.droppedEdges === 1 ? '' : 's'} reference agents outside
          the returned slice and are not drawn.
        </p>
      )}
      {layout.cyclicNodes > 0 && (
        <p className="muted">
          {layout.cyclicNodes} agent{layout.cyclicNodes === 1 ? '' : 's'} sit in a cycle and are
          placed on a fallback layer.
        </p>
      )}
      <div className="chart-scroll">
        <svg
          role="img"
          aria-label="global orchestration dag"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        >
          {layout.edges.map((edge) => (
            <line
              key={edge.payload.id}
              className={
                edge.payload.source === 'tool_use' ? 'edge edge-observed' : 'edge edge-inferred'
              }
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
            >
              <title>
                {edge.payload.source === 'tool_use'
                  ? 'observed (tool_use)'
                  : `inferred (${edge.payload.source})`}
              </title>
            </line>
          ))}
          {layout.nodes.map((placed) => {
            const agent = placed.node;
            const meta = statusMeta(agent.status);
            return (
              <g key={agent.id} className={meta.className} data-testid={`dag-node-${agent.id}`}>
                <title>
                  {`${agent.subagentType ?? agent.type ?? 'agent'} ${shortId(agent.id)} - session ${shortId(agent.sessionId)} - ${meta.label} - ${formatTokens(agent.totalTokens)} tokens, ${formatUsd(agent.costUsd)}${agent.unpricedTokens > 0 ? `, ~${formatTokens(agent.unpricedTokens)} unpriced` : ''}`}
                </title>
                <circle cx={placed.x} cy={placed.y} r={7} fill="currentColor" />
                <text className="node-symbol" x={placed.x} y={placed.y + 3.5} textAnchor="middle">
                  {meta.symbol}
                </text>
                <text className="node-label" x={placed.x} y={placed.y + 22} textAnchor="middle">
                  {shortId(agent.sessionId)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="legend-inline muted" aria-label="edge provenance legend">
        — observed (tool_use) ┄ inferred (directory, task_notification, queue_operation)
      </p>
    </section>
  );
}
