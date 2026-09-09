/**
 * (b) Session-scoped subagent tree (WP-U7): pick a session, see its agent
 * hierarchy exactly as PERSISTED - the layout only places the nodes and
 * edges the API served, it never reconstructs relationships client-side.
 * Provenance is always visible: solid edges are observed (`tool_use`),
 * dashed edges are inferred (`directory` / `task_notification` /
 * `queue_operation` / `legacy_explore`), and the session's unattributed usage
 * bucket is shown even when it is zero.
 *
 * Review item M-9: every listed session also carries an "analyse" action that
 * opens the same per-session cost analysis the cost view offers for its top-5,
 * so cost analysability is not limited to the sessions that happen to rank.
 *
 * AMENDED 2026-09-02 (F-3): the paragraph above says provenance is "always
 * visible", and that was believed to be true because the EDGE provenance is.
 * It was not true of the figures. Both fetches here run once - the list on
 * mount, the tree on selection - and nothing re-ran either, so the view kept
 * painting `statusMeta(agent.status)` as a hard claim about the present: a
 * session selected while it was running showed its subagents `working` for as
 * long as the tab stayed open, while the live board one click away showed them
 * finished or errored. Two views of one database disagreeing, with the wrong
 * one looking more authoritative for being the drill-down. The session rows'
 * dollars and the tree's unattributed totals froze the same way.
 *
 * What is true now: each fetch stamps `fetchedAtMs` from the event clock, both
 * panes age that stamp on screen against the shared clock, and once a snapshot
 * outlives the app's own "just now" window (see `snapshot.ts` - the boundary is
 * borrowed, not invented) the pane says its figures are remembered rather than
 * observed. Each pane also carries a refresh control, because before this the
 * only way to re-read was an unsignposted full page reload. The view still does
 * NOT subscribe to SSE: making these views live is an open owner decision, and
 * this wave only makes their staleness visible and actionable.
 */
import { useEffect, useState } from 'react';
import { fetchSessions, fetchSessionTree } from '../api';
import { readNowMs, useNowMs } from '../clock';
import type { AgentNodeDto, OrchestrationEdgeDto, SessionSummaryDto, SessionTreeDto } from '../dto';
import { agentTypeLabel, formatTokens, formatUsd, projectLabel, shortId } from '../format';
import { describeAgentGraph } from './chart-summary';
import { computeLayeredLayout } from './layout/layered';
import { SessionCostAnalysis } from './SessionCostAnalysis';
import { snapshotAge } from './snapshot';
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
      /**
       * When these rows were read from the server. Stamped with `readNowMs`
       * (the event clock) rather than the render clock, because a reading up to
       * CLOCK_INTERVAL_MS old would date the snapshot before it arrived - and
       * this number's whole job is to be compared against now.
       */
      readonly fetchedAtMs: number;
    };

type TreeState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly tree: SessionTreeDto; readonly fetchedAtMs: number };

function agentLabel(agent: AgentNodeDto): string {
  return agentTypeLabel(agent.subagentType, agent.type);
}

function edgeTitle(edge: OrchestrationEdgeDto): string {
  const provenance = edge.source === 'tool_use' ? 'observed' : 'inferred';
  return `${provenance} (${edge.source})`;
}

/** SVG tree of the persisted agents + edges; a pure render of the layout. */
function TreePanel({
  tree,
  fetchedAtMs,
  nowMs,
  onRefresh,
}: {
  readonly tree: SessionTreeDto;
  readonly fetchedAtMs: number;
  readonly nowMs: number;
  readonly onRefresh: () => void;
}) {
  const layout = computeLayeredLayout(
    tree.agents,
    tree.edges.map((edge) => ({
      parentId: edge.parentAgentId,
      childId: edge.childAgentId,
      payload: edge,
    })),
  );
  const age = snapshotAge(fetchedAtMs, nowMs);
  // Appended to each node's hover text only once the snapshot is aged. A node
  // read a second ago needs no qualifier, and a qualifier on every node in
  // every state is the kind of uniform caveat that stops being read.
  const asOf = age.aged ? ` - as recorded ${age.label}` : '';
  // SV-2 (2026-09-07): the SAME qualifier, in the prose that stands in for
  // those hidden titles. role="img" hides the SVG subtree, so a reader who
  // cannot hover gets the status mix from the summary alone - and until this
  // line existed that summary stated a two-minute-old tally in the present
  // tense while the hover text beside it was dated. The caveat was carried on
  // exactly the channel that assistive tech cannot reach.
  //
  // AMENDED 2026-09-08 (CS-4). That clause was a string built here and printed
  // after the summary, so the sentence `describeAgentGraph` returned was an
  // undated tally and this panel was the only reason the rendered paragraph
  // was not one. It is now an argument: same wording, same position in the
  // paragraph, but a caller can no longer produce the claim without the
  // qualification attached to it. Whether the read is old enough to date is
  // still decided here - that is a fact about this panel's clock, not about
  // the payload.
  //
  // role="img" hides the SVG subtree (its <title> elements included) from
  // assistive tech, so the same facts are published as prose next to it and
  // pointed at with aria-describedby.
  const summary = describeAgentGraph(tree.agents, tree.edges, {
    asOf: age.aged ? age.label : undefined,
  });
  const summaryId = `tree-chart-summary-${tree.sessionId}`;
  // DG-3 (2026-09-08): the summary was the whole accessible description of
  // this tree, and it says nothing about cycles - so a reader who cannot see
  // the notice below was told the status mix of a picture in which some agents
  // are not where the hierarchy would put them, but parked on a fallback
  // layer. For a view whose stated promise is the tree "exactly as PERSISTED",
  // a stand-in position that only sighted readers hear about is the picture
  // being quietly wrong for those nodes. `aria-describedby` takes a
  // space-separated id list, so the notice is added to the summary rather than
  // displacing it, and it is named first because it qualifies what the diagram
  // is before the summary counts what is in it. The id is referenced only
  // while the notice is rendered: an idref that resolves to nothing describes
  // nothing, and reads to an auditor as though the caveat had been given.
  const cycleNoticeId = `tree-cycle-notice-${tree.sessionId}`;
  const chartDescribedBy = layout.cyclicNodes > 0 ? `${cycleNoticeId} ${summaryId}` : summaryId;
  return (
    <div>
      {/* The caveat escalates with the fact rather than sitting at one volume:
          quiet while the read is inside the app's own "just now" window (where
          it is a truism), promoted to the warning banner once it is outside
          (where it marks real drift the reader is about to act on). */}
      <p
        className={age.aged ? 'truncation-banner' : 'muted card-provenance'}
        data-testid="tree-provenance"
      >
        Tree read {age.label}
        {age.aged
          ? ' - everything below is remembered, not observed: each agent status, token count and dollar figure, and how many agents there were. An agent still drawn as working may have finished or failed since.'
          : '.'}{' '}
        <button type="button" onClick={onRefresh}>
          Refresh tree
        </button>
      </p>
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
      {/* DG-3 (2026-09-08): rendered under exactly the condition that puts
          `cycleNoticeId` into `aria-describedby`, so the reference and the
          element can never disagree. */}
      {layout.cyclicNodes > 0 && (
        <p className="muted" id={cycleNoticeId}>
          {layout.cyclicNodes} agent{layout.cyclicNodes === 1 ? '' : 's'} sit in a cycle and are
          placed on a fallback layer.
        </p>
      )}
      <div className="chart-scroll">
        <svg
          role="img"
          aria-label={`agent tree for session ${tree.sessionId}`}
          aria-describedby={chartDescribedBy}
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
                  {`${agentLabel(agent)} ${shortId(agent.id)} - ${meta.label} - ${formatTokens(agent.totalTokens)} tokens, ${formatUsd(agent.costUsd)}${agent.unpricedTokens > 0 ? `, ~${formatTokens(agent.unpricedTokens)} unpriced` : ''}${asOf}`}
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
        {summary}
      </p>
      <p className="legend-inline muted" aria-label="edge provenance legend">
        — observed (tool_use) ┄ inferred (directory, task_notification, queue_operation,
        legacy_explore)
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
  // Cost analysis reprices transcripts off disk (WP-C4/C5), so like the cost
  // view it is opt-in per session, never fetched for every listed row.
  const [analysedSessionId, setAnalysedSessionId] = useState<string | null>(null);
  // F-3: the two panes are read at different moments (the list on mount, the
  // tree on selection) and therefore age independently, so each owns its own
  // reload counter rather than sharing one that would re-read both.
  const [listReload, setListReload] = useState(0);
  const [treeReload, setTreeReload] = useState(0);
  // The shared app clock (see clock.ts): the age labels below must keep moving
  // while nothing else re-renders, which is exactly the condition - a view that
  // never refetches - under which this view went stale in silence.
  const nowMs = useNowMs();
  const refreshList = () => setListReload((value) => value + 1);
  const refreshTree = () => setTreeReload((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSessions(token, { limit: SESSION_LIST_LIMIT }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setList({ kind: 'error', message: result.message });
      } else {
        setList({
          kind: 'ready',
          sessions: result.data.sessions,
          total: result.data.total,
          fetchedAtMs: readNowMs(),
        });
      }
    });
    return () => controller.abort();
  }, [token, listReload, onAuthRejected]);

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
        setTreeState({ kind: 'ready', tree: result.data, fetchedAtMs: readNowMs() });
      }
    });
    return () => controller.abort();
  }, [token, selectedId, treeReload, onAuthRejected]);

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
        <button type="button" onClick={refreshList}>
          Retry
        </button>
      </section>
    );
  }

  const listAge = snapshotAge(list.fetchedAtMs, nowMs);
  // One line for the whole list: every row came out of the same response, so a
  // per-row copy of it would be uniform noise. The wording covers the EMPTY
  // list too - "no sessions yet" is itself a claim with an age, and it is
  // rendered in the branch below where there is nothing else to qualify.
  const listProvenance = (
    <p
      className={listAge.aged ? 'truncation-banner' : 'muted card-provenance'}
      data-testid="list-provenance"
    >
      Session list read {listAge.label}
      {listAge.aged
        ? ' - everything from it is remembered, not observed: each row status, agent count and dollar figure, and whether a session exists at all.'
        : '.'}{' '}
      <button type="button" onClick={refreshList}>
        Refresh sessions
      </button>
    </p>
  );

  if (list.sessions.length === 0) {
    return (
      <section aria-label="session tree">
        <p className="empty-state">No sessions ingested yet - nothing to drill into.</p>
        {listProvenance}
      </section>
    );
  }

  return (
    <section aria-label="session tree">
      <div className="split">
        <div>
          <h2>Sessions</h2>
          {listProvenance}
          {/* SV-1 (2026-09-07): the denominator is not a bare count. The
              endpoint pages by most recent activity (SESSION_PAGE_ORDER), so
              the rows NOT shown are the least recently active rather than an
              arbitrary remainder, and both figures were taken in the one read
              the line above dates. Saying only "1 of 80" let a reader who
              could not find a session conclude it was not ingested, when it
              was simply older than the page. LiveView already discloses this
              ordering for the same endpoint. */}
          {list.total > list.sessions.length && (
            <p className="muted" data-testid="list-truncation">
              Showing {list.sessions.length} of {list.total} sessions - the server pages by most
              recent activity first, so this is the newest slice as of that read: the rest are
              older, and a session started since is in neither figure.
            </p>
          )}
          <ul className="session-list" aria-label="session list">
            {list.sessions.map((session) => {
              const meta = statusMeta(session.status);
              return (
                <li key={session.id} className="session-item">
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
                  <button
                    type="button"
                    className="link-button analyse-button"
                    aria-pressed={session.id === analysedSessionId}
                    aria-label={`analyse cost of session ${shortId(session.id)}`}
                    onClick={() => setAnalysedSessionId(session.id)}
                  >
                    analyse
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
            <>
              <p className="empty-state">
                <span className="status-error">✕</span> Could not load tree: {treeState.message}
              </p>
              <button type="button" onClick={refreshTree}>
                Retry
              </button>
            </>
          )}
          {treeState.kind === 'ready' && (
            <TreePanel
              tree={treeState.tree}
              fetchedAtMs={treeState.fetchedAtMs}
              nowMs={nowMs}
              onRefresh={refreshTree}
            />
          )}
        </div>
      </div>

      <h2>Session cost analysis</h2>
      {analysedSessionId === null ? (
        <p className="empty-state" data-testid="analysis-prompt">
          Pick “analyse” on a session row to reprice it across its compaction boundaries and
          estimate what it would have cost without delegation.
        </p>
      ) : (
        <SessionCostAnalysis
          token={token}
          sessionId={analysedSessionId}
          onAuthRejected={onAuthRejected}
        />
      )}
    </section>
  );
}
