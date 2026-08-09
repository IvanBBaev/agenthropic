/**
 * (b) Session-scoped subagent tree (WP-U7): pick a session, see its agent
 * hierarchy exactly as PERSISTED - the layout only places the nodes and
 * edges the API served, it never reconstructs relationships client-side.
 * Provenance is always visible: solid edges are observed (`tool_use`),
 * dashed edges are inferred (`directory` / `task_notification` /
 * `queue_operation`), and the session's unattributed usage bucket is shown
 * even when it is zero.
 */
import { useEffect, useState } from 'react';
import { fetchSessions, fetchSessionTree } from '../api';
import type { AgentNodeDto, OrchestrationEdgeDto, SessionSummaryDto, SessionTreeDto } from '../dto';
import { agentTypeLabel, formatTokens, formatUsd, projectLabel, shortId } from '../format';
import { describeAgentGraph } from './chart-summary';
import { computeLayeredLayout } from './layout/layered';
import { statusMeta } from './status';
import type { ViewProps } from './types';

/** Page size for the selectable session list. */
export const SESSION_LIST_LIMIT = 50;

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly sessions: readonly SessionSummaryDto[];
      readonly total: number;
    };

type TreeState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly tree: SessionTreeDto };

function agentLabel(agent: AgentNodeDto): string {
  return agentTypeLabel(agent.subagentType, agent.type);
}

function edgeTitle(edge: OrchestrationEdgeDto): string {
  const provenance = edge.source === 'tool_use' ? 'observed' : 'inferred';
  return `${provenance} (${edge.source})`;
}

/** SVG tree of the persisted agents + edges; a pure render of the layout. */
function TreePanel({ tree }: { readonly tree: SessionTreeDto }) {
  const layout = computeLayeredLayout(
    tree.agents,
    tree.edges.map((edge) => ({
      parentId: edge.parentAgentId,
      childId: edge.childAgentId,
      payload: edge,
    })),
  );
  // role="img" hides the SVG subtree (its <title> elements included) from
  // assistive tech, so the same facts are published as prose next to it and
  // pointed at with aria-describedby.
  const summaryId = `tree-chart-summary-${tree.sessionId}`;
  return (
    <div>
      <p className="muted">
        {tree.agentCount} agent{tree.agentCount === 1 ? '' : 's'}, {tree.edgeCount} edge
        {tree.edgeCount === 1 ? '' : 's'} (persisted).
      </p>
      {layout.droppedEdges > 0 && (
        <p className="muted">
          {layout.droppedEdges} edge{layout.droppedEdges === 1 ? '' : 's'} reference agents outside
          this payload and are not drawn.
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
          aria-label={`agent tree for session ${tree.sessionId}`}
          aria-describedby={summaryId}
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
              <title>{edgeTitle(edge.payload)}</title>
            </line>
          ))}
          {layout.nodes.map((placed) => {
            const agent = placed.node;
            const meta = statusMeta(agent.status);
            return (
              <g key={agent.id} className={meta.className} data-testid={`tree-node-${agent.id}`}>
                <title>
                  {`${agentLabel(agent)} ${shortId(agent.id)} - ${meta.label} - ${formatTokens(agent.totalTokens)} tokens, ${formatUsd(agent.costUsd)}${agent.unpricedTokens > 0 ? `, ~${formatTokens(agent.unpricedTokens)} unpriced` : ''}`}
                </title>
                <circle cx={placed.x} cy={placed.y} r={8} fill="currentColor" />
                <text className="node-symbol" x={placed.x} y={placed.y + 4} textAnchor="middle">
                  {meta.symbol}
                </text>
                <text className="node-label" x={placed.x} y={placed.y + 24} textAnchor="middle">
                  {agentLabel(agent)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="chart-summary" id={summaryId}>
        {describeAgentGraph(tree.agents, tree.edges)}
      </p>
      <p className="legend-inline muted" aria-label="edge provenance legend">
        — observed (tool_use) ┄ inferred (directory, task_notification, queue_operation)
      </p>
      <p className="unattributed" data-testid="unattributed">
        Unattributed to any agent: {formatTokens(tree.unattributed.totalTokens)} tokens ·{' '}
        {formatUsd(tree.unattributed.costUsd)}
        {tree.unattributed.unpricedTokens > 0 && (
          <>
            {' '}
            ·{' '}
            <span className="unpriced">
              ~ {formatTokens(tree.unattributed.unpricedTokens)} unpriced
            </span>
          </>
        )}
      </p>
    </div>
  );
}

export function SessionsView({ token, onAuthRejected }: ViewProps) {
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [treeState, setTreeState] = useState<TreeState>({ kind: 'idle' });

  useEffect(() => {
    const controller = new AbortController();
    void fetchSessions(token, { limit: SESSION_LIST_LIMIT }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setList({ kind: 'error', message: result.message });
      } else {
        setList({ kind: 'ready', sessions: result.data.sessions, total: result.data.total });
      }
    });
    return () => controller.abort();
  }, [token, onAuthRejected]);

  useEffect(() => {
    if (selectedId === null) {
      setTreeState({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    setTreeState({ kind: 'loading' });
    void fetchSessionTree(token, selectedId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setTreeState({ kind: 'error', message: result.message });
      } else {
        setTreeState({ kind: 'ready', tree: result.data });
      }
    });
    return () => controller.abort();
  }, [token, selectedId, onAuthRejected]);

  if (list.kind === 'loading') {
    return (
      <section aria-label="session tree">
        <p className="muted">Loading sessions…</p>
      </section>
    );
  }
  if (list.kind === 'error') {
    return (
      <section aria-label="session tree">
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load sessions: {list.message}
        </p>
      </section>
    );
  }
  if (list.sessions.length === 0) {
    return (
      <section aria-label="session tree">
        <p className="empty-state">No sessions ingested yet - nothing to drill into.</p>
      </section>
    );
  }

  return (
    <section aria-label="session tree">
      <div className="split">
        <div>
          <h2>Sessions</h2>
          {list.total > list.sessions.length && (
            <p className="muted">
              Showing {list.sessions.length} of {list.total} sessions.
            </p>
          )}
          <ul className="session-list" aria-label="session list">
            {list.sessions.map((session) => {
              const meta = statusMeta(session.status);
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={
                      session.id === selectedId ? 'session-row session-active' : 'session-row'
                    }
                    aria-pressed={session.id === selectedId}
                    onClick={() => setSelectedId(session.id)}
                  >
                    <code>{shortId(session.id)}</code>{' '}
                    <span className={session.projectSlug === null ? 'muted' : undefined}>
                      {projectLabel(session.projectSlug)}
                    </span>{' '}
                    <span className={`session-status ${meta.className}`}>
                      <span aria-hidden="true">{meta.symbol}</span> {meta.label}
                    </span>{' '}
                    <span className="muted">
                      {session.agentCount} agent{session.agentCount === 1 ? '' : 's'} ·{' '}
                      {formatUsd(session.totalCostUsd)}
                    </span>
                    {session.unpricedTokens > 0 && (
                      <span className="unpriced">
                        {' '}
                        · ~ {formatTokens(session.unpricedTokens)} unpriced
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <h2>Agent tree</h2>
          {treeState.kind === 'idle' && (
            <p className="empty-state">Select a session to see its persisted agent tree.</p>
          )}
          {treeState.kind === 'loading' && <p className="muted">Loading tree…</p>}
          {treeState.kind === 'error' && (
            <p className="empty-state">
              <span className="status-error">✕</span> Could not load tree: {treeState.message}
            </p>
          )}
          {treeState.kind === 'ready' && <TreePanel tree={treeState.tree} />}
        </div>
      </div>
    </section>
  );
}
