/**
 * (c) Global orchestration DAG (WP-U8): every persisted agent across all
 * sessions, laid out by the pure layered module - the hierarchy drawn is
 * exactly the edge set the API served. Truncation is surfaced honestly:
 * when the node limit cuts the graph, the banner says "showing N of M",
 * never pretending the visible slice is the whole story. Solid edges are
 * observed (`tool_use`); dashed edges are inferred.
 *
 * AMENDED 2026-09-23 (lane-EP): "dashed edges are inferred" described a binary
 * this view no longer draws. It asked `source === 'tool_use'` and dashed
 * everything else, so a source outside the served union - a newer server, a
 * renamed literal, a field that stopped arriving - was drawn as a derived join
 * and titled with a derivation this build had not read. There is a third
 * stroke now, dotted, for a source this build cannot place; see
 * `views/provenance.ts` for why `inferred` was the wrong answer rather than an
 * imprecise one.
 *
 * AMENDED 2026-09-02 (F-4): "surfaced honestly" was believed to settle the
 * truncation disclosure. It did not, for two compounding reasons. The view
 * fetched once, on mount, and nothing could re-run it - so every node status,
 * token count and dollar figure below was frozen at mount while still being
 * painted as a present-tense claim. And the server slices BY RECENCY, so the
 * banner's "showing N of M" was the most-recent-N as of that one read: after an
 * hour of activity the picture was an hour-old slice AND the disclosure of its
 * incompleteness understated it, because agents created since counted in
 * neither N nor M.
 *
 * What is true now: the fetch stamps `fetchedAtMs` from the event clock, the
 * view ages that stamp on screen against the shared clock, and once the read
 * outlives the app's own "just now" window (see `snapshot.ts` - the boundary is
 * borrowed from `formatRelativeMs`, not invented here) the disclosure says that
 * the counts as well as the figures are remembered rather than observed, and
 * that the slice is the newest one AS OF THAT READ. A refresh control re-reads
 * and re-stamps; before it, the only way to re-read was an unsignposted full
 * page reload. The view still does NOT subscribe to SSE - whether the
 * fetch-once views should consume the stream is an open owner decision, and
 * this wave only makes their staleness visible and actionable.
 */
import { useEffect, useState } from 'react';
import { fetchGlobalDag } from '../api';
import { readNowMs, useNowMs } from '../clock';
import type { GlobalDagDto } from '../dto';
import { agentTypeLabel, formatTokens, formatUsd, shortId } from '../format';
import { describeAgentGraph } from './chart-summary';
import { computeLayeredLayout, fallbackLayerNotice } from './layout/layered';
import { edgeProvenance, EDGE_PROVENANCE_LEGEND } from './provenance';
import { snapshotAge } from './snapshot';
import { statusMeta } from './status';
import type { ViewProps } from './types';
import { unpricedTitleSuffix } from './unpriced';

/** Node cap requested from the server (its own max is higher). */
export const DAG_NODE_LIMIT = 1000;

/**
 * Id of the prose text alternative. role="img" hides the SVG subtree (its
 * <title> elements included) from assistive tech, so the same facts are
 * published as visible prose and referenced with aria-describedby.
 */
const DAG_SUMMARY_ID = 'dag-chart-summary';

/**
 * Id of the cycle notice. Added 2026-09-08 (DG-3): the notice is a second
 * description of the same picture, not decoration beside it, so the SVG names
 * it too. Referenced ONLY while the notice is rendered - see the
 * `aria-describedby` below.
 */
const DAG_CYCLE_ID = 'dag-cycle-notice';

type DagState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly dag: GlobalDagDto;
      /**
       * When this slice was read. Stamped with `readNowMs` (the event clock)
       * rather than the render clock, because a reading up to
       * CLOCK_INTERVAL_MS old would date the snapshot before it arrived - and
       * this number's whole job is to be compared against now.
       */
      readonly fetchedAtMs: number;
    };

export function DagView({ token, onAuthRejected }: ViewProps) {
  const [state, setState] = useState<DagState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  // The shared app clock (see clock.ts): the age label must keep moving while
  // nothing else re-renders, which is exactly this view's condition.
  const nowMs = useNowMs();
  const refresh = () => setReload((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    void fetchGlobalDag(token, DAG_NODE_LIMIT, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setState({ kind: 'error', message: result.message });
      } else {
        setState({ kind: 'ready', dag: result.data, fetchedAtMs: readNowMs() });
      }
    });
    return () => controller.abort();
  }, [token, reload, onAuthRejected]);

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
        <button type="button" onClick={refresh}>
          Retry
        </button>
      </section>
    );
  }

  const { dag } = state;
  const age = snapshotAge(state.fetchedAtMs, nowMs);
  // The caveat escalates with the fact rather than sitting at one volume: quiet
  // inside the app's own "just now" window (where it is a truism), promoted to
  // the warning banner outside it (where it marks drift the reader is about to
  // act on). The slice sentence is a property of the ENDPOINT, not of the age,
  // so it is stated whenever the graph is cut - it is what makes "showing N of
  // M" readable as a fact about one moment.
  const provenance = (
    <p
      className={age.aged ? 'truncation-banner' : 'muted card-provenance'}
      data-testid="dag-provenance"
    >
      Read {age.label}
      {age.aged
        ? ' - everything here is remembered, not observed: the counts above, and every node status, token count and dollar figure below. An agent still drawn as working may have finished or failed since.'
        : '.'}{' '}
      {dag.counts.truncated
        ? 'The server returns the most recent agents first, so this is the newest slice as of that read: agents started since are in neither the picture nor the "showing N of M" figures above. '
        : ''}
      <button type="button" onClick={refresh}>
        Refresh DAG
      </button>
    </p>
  );

  // Hoisted out of the return below so the empty branch can render it too.
  // DG-2 (2026-09-07): the provenance sentence sends the reader to the
  // "showing N of M" figures ABOVE, and in the empty branch those figures were
  // not rendered at all - a pointer to a disclosure that was not on the page.
  const truncationBanner = (
    <p className="truncation-banner" data-testid="truncation-banner">
      Truncated: showing {dag.counts.returnedAgents} of {dag.counts.totalAgents} agents and{' '}
      {dag.counts.returnedEdges} of {dag.counts.totalEdges} edges (node limit {DAG_NODE_LIMIT}).
    </p>
  );

  if (dag.nodes.length === 0) {
    return (
      <section aria-label="global dag">
        {dag.counts.truncated ? truncationBanner : null}
        {/* DG-2: "no agents persisted" is a claim about the DATABASE, and this
            branch only knows that the returned array is empty. The same
            payload carries the server's own count, and the server itself
            contemplates a zero-node selection over a non-empty agents table
            (queries.ts, getGlobalDag: "honestly truncated"). Reading the
            emptiness off the array told the reader their corpus was empty on
            a payload that said it holds 1200 agents. */}
        <p className="empty-state" data-testid="dag-empty">
          {dag.counts.totalAgents === 0
            ? 'No agents persisted yet - the DAG appears with the first ingest.'
            : `No agents came back in this slice, though the same read counts ${String(dag.counts.totalAgents)} persisted - a gap in the answer, not an empty database.`}
        </p>
        {provenance}
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
  // Appended to each node's hover text only once the snapshot is aged: a node
  // read a second ago needs no qualifier, and a qualifier on every node in
  // every state is the kind of uniform caveat that stops being read.
  const asOf = age.aged ? ` - as recorded ${age.label}` : '';
  // DG-1 (2026-09-07): the prose alternative stands in for those hidden
  // titles, and it was carrying neither of the two qualifications they carry.
  // The image is NAMED "global orchestration dag" while showing a slice, so
  // its description said "Agents by status: 1 working" about a corpus of 1200
  // - and said it in the present tense about a reading minutes old. A sighted
  // reader has the banner and the hover text; this is the only channel the
  // other reader has.
  //
  // AMENDED 2026-09-08 (CS-4). DG-1's two clauses were built here, as strings
  // appended to the summary element AFTER the call that produced the sentence
  // they correct - so `describeAgentGraph` returned an unqualified tally and
  // this view was the only reason the rendered paragraph was true. The clauses
  // are now arguments: same wording, same order, same rendered paragraph, but
  // the qualification travels with the claim instead of being re-attached by
  // whoever calls next. What is deliberately still decided HERE is *whether*
  // each clause applies - truncation is a fact of this payload and the age is
  // a fact of this view's clock; the summary module is told, never left to
  // guess.
  // AMENDED 2026-09-23 (A4). The scope clause was published only when the
  // server SAID it truncated. A payload that draws fewer agents than it counts
  // while leaving `truncated` false is a slice all the same, and the reader who
  // has only this paragraph was the one told nothing about it.
  const countsDisagree = dag.nodes.length !== dag.counts.totalAgents;
  // RR1 (2026-09-26). The check above is an inequality, but the sentence it
  // gated described one direction only: fewer drawn than counted, "a slice".
  // More drawn than counted passes the same shape guard, and "3 of the 2
  // agents ... are drawn ... so this picture is a slice" is a false claim. The
  // direction picks the sentence; the disagreement is reported either way.
  const drawnOverCount = dag.nodes.length > dag.counts.totalAgents;
  // SA-Z4 (2026-09-23). A second disagreement, on the other axis, that
  // `countsDisagree` cannot see: `totalEdges` counts the whole edge table while
  // `edges` carries only the edges whose endpoints are among the returned
  // agents, and the table has no foreign key to agents - so an edge naming an
  // agent id with no stored row is counted forever and returned never. That
  // produces returnedEdges 0 against totalEdges 1 with `truncated` false, which
  // is none of the three states the caption below distinguished: it fell to the
  // untruncated arm and printed the corpus count as the number of edges drawn.
  // The node limit cannot be the explanation when the answer is not marked
  // truncated, and what IS the explanation is a fact about the server's join
  // that this view does not hold. So it reports the gap and declines to name a
  // cause.
  const edgeCountsDisagree = dag.counts.returnedEdges !== dag.counts.totalEdges;
  // RR1: same split for edges - the banner below subtracts the two counts, and
  // that is a count of missing edges only when returned <= total.
  const edgesOverCount = dag.counts.returnedEdges > dag.counts.totalEdges;
  const summary = describeAgentGraph(dag.nodes, dag.edges, {
    sliceOf:
      dag.counts.truncated || countsDisagree
        ? { returnedAgents: dag.counts.returnedAgents, totalAgents: dag.counts.totalAgents }
        : undefined,
    unreturnedEdges: edgeCountsDisagree
      ? { returnedEdges: dag.counts.returnedEdges, totalEdges: dag.counts.totalEdges }
      : undefined,
    asOf: age.aged ? age.label : undefined,
  });
  // DG-3 (2026-09-08): the summary was the WHOLE accessible description of the
  // diagram, and it says nothing about cycles - so a reader who cannot see the
  // notice above was handed a status tally for a picture in which some agents
  // are not in their real position at all, but parked on a fallback layer. The
  // hierarchy is the entire point of this image: being given the tally and not
  // told that part of the geometry is a stand-in leaves a confidently wrong
  // picture, and the one channel that could have said so named only the
  // summary. `aria-describedby` takes a space-separated list, so the notice is
  // added to it rather than replacing anything, and it is named FIRST because
  // it qualifies what the diagram is before the summary counts what is in it.
  // The reference appears only when the notice does: an idref pointing at an
  // absent element describes nothing while reading, to anyone auditing the
  // markup, as though the caveat had been given.
  const chartDescribedBy =
    layout.cyclicNodes > 0 ? `${DAG_CYCLE_ID} ${DAG_SUMMARY_ID}` : DAG_SUMMARY_ID;

  return (
    <section aria-label="global dag">
      {/*
        A4 (2026-09-23). The else arm below prints the CORPUS counts with no
        qualifier, and it was reached whenever `truncated` was false - so a
        payload that returned five nodes while counting 1200 agents, without
        setting the flag, captioned a five-node picture "1200 agents across 30
        sessions". DG-2 already refuses exactly this contradiction one row
        over, in the zero-node branch ("a gap in the answer, not an empty
        database"); the same read with one node left it unsaid. The flag is a
        claim about the answer and the node array is the answer, so when they
        disagree the view reports the disagreement instead of choosing.
      */}
      {dag.counts.truncated ? (
        truncationBanner
      ) : countsDisagree ? (
        <p className="truncation-banner" data-testid="dag-count-disagreement">
          {drawnOverCount ? (
            <>
              {dag.nodes.length} agents are drawn, but this same read counts only{' '}
              {dag.counts.totalAgents} - the drawn graph and the served count disagree, and this
              page cannot say which is right.
            </>
          ) : (
            <>
              {dag.nodes.length} of the {dag.counts.totalAgents} agents this same read counts are
              drawn, and the answer was not marked truncated - the drawn graph and the served count
              disagree, so this picture is a slice of unknown size.
            </>
          )}
        </p>
      ) : (
        <p className="muted">
          {dag.counts.totalAgents} agent{dag.counts.totalAgents === 1 ? '' : 's'} across{' '}
          {dag.counts.totalSessions} session{dag.counts.totalSessions === 1 ? '' : 's'},{' '}
          {/* SA-Z4: the bare corpus count reads as the number of edges in the
              picture, because every other figure in this sentence is. When the
              answer returned fewer than it counted, both numbers go in. */}
          {edgesOverCount
            ? `${dag.counts.returnedEdges} edges returned against ${dag.counts.totalEdges} counted`
            : edgeCountsDisagree
              ? `${dag.counts.returnedEdges} of ${dag.counts.totalEdges} edges`
              : `${dag.counts.totalEdges} edge${dag.counts.totalEdges === 1 ? '' : 's'}`}
          .
        </p>
      )}
      {/* Only when the server did NOT claim truncation: the truncation banner
          already prints both edge counts, and a second paragraph saying the
          same numbers over again buys nothing. */}
      {edgeCountsDisagree && !dag.counts.truncated && (
        <p className="truncation-banner" data-testid="dag-edge-count-disagreement">
          {edgesOverCount ? (
            <>
              {dag.counts.returnedEdges} edges came back with this read, but the same read counts
              only {dag.counts.totalEdges} - the answer and its own count disagree, and this page
              cannot say which is right.
            </>
          ) : (
            <>
              {dag.counts.totalEdges - dag.counts.returnedEdges} of the {dag.counts.totalEdges}{' '}
              edges this read counts were not returned with it, and the answer was not marked
              truncated - so the node limit is not the reason and this page cannot say what is. They
              are not in the picture below.
            </>
          )}
        </p>
      )}
      {provenance}
      {layout.droppedEdges > 0 && (
        <p className="muted">
          {layout.droppedEdges} edge{layout.droppedEdges === 1 ? '' : 's'} reference agents outside
          the returned slice and are not drawn.
        </p>
      )}
      {/* DG-3 (2026-09-08): the id exists so the SVG below can name this
          paragraph in its accessible description. It is rendered under exactly
          the condition that puts the id in `aria-describedby`, so the two can
          never disagree - an id referenced while this branch is false would
          point at nothing, and a description that resolves to nothing is worse
          than none: it reads as if the caveat had been given. */}
      {layout.cyclicNodes > 0 && (
        <p className="muted" id={DAG_CYCLE_ID}>
          {fallbackLayerNotice(layout.cyclicNodes, layout.belowCycleNodes)}
        </p>
      )}
      <div className="chart-scroll">
        <svg
          role="img"
          aria-label="global orchestration dag"
          aria-describedby={chartDescribedBy}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        >
          {layout.edges.map((edge) => {
            const sourceProvenance = edgeProvenance(edge.payload.source);
            return (
              <line
                key={edge.payload.id}
                className={sourceProvenance.className}
                x1={edge.x1}
                y1={edge.y1}
                x2={edge.x2}
                y2={edge.y2}
              >
                <title>{sourceProvenance.title}</title>
              </line>
            );
          })}
          {layout.nodes.map((placed) => {
            const agent = placed.node;
            const meta = statusMeta(agent.status);
            return (
              <g key={agent.id} className={meta.className} data-testid={`dag-node-${agent.id}`}>
                <title>
                  {`${agentTypeLabel(agent.subagentType, agent.type)} ${shortId(agent.id)} - session ${shortId(agent.sessionId)} - ${meta.label} - ${formatTokens(agent.totalTokens)} tokens, ${formatUsd(agent.costUsd)}${unpricedTitleSuffix(agent.unpricedTokens)}${asOf}`}
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
      <p className="chart-summary" id={DAG_SUMMARY_ID}>
        {summary}
      </p>
      <p className="legend-inline muted" aria-label="edge provenance legend">
        {EDGE_PROVENANCE_LEGEND}
      </p>
    </section>
  );
}
