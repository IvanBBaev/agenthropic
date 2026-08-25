/**
 * (d) Cost view (WP-U9): totals, per-model and per-day breakdowns, top
 * sessions, and a sankey of dollar flows (model -> all cost -> session).
 * Every dollar figure is server-side ground truth (tokens x dated price);
 * `unpricedTokens` is an honest gap and is surfaced EVERYWHERE it appears -
 * as its own headline tile, as a column in every table, and as a note on
 * flow nodes - never hidden, never rendered as $0.
 *
 * Two additions from the 2026-08-09 implementation review:
 *   - M-9: today / last-7-days KPIs, computed client-side from the served
 *     `perDay` rows with an explicitly UTC day basis (see cost-windows.ts) -
 *     the labels name the boundary instead of assuming the local timezone;
 *   - M-8: a "top agent burners" table ranking the served DAG nodes by token
 *     burn, so the biggest agent/subagent burner is readable without hovering
 *     SVG <title> tooltips (which keyboard and AT users cannot reach at all);
 *   - M-10: those windows are cut against the app's shared clock (clock.ts)
 *     rather than a per-render `Date.now()`, so a tab left open across UTC
 *     midnight rolls over instead of presenting yesterday's totals under a
 *     label that says today.
 */
import { useEffect, useState } from 'react';
import { fetchAggregateSavings, fetchCostSummary, fetchGlobalDag } from '../api';
import { useNowMs } from '../clock';
import type {
  AggregateDelegationSavingsDto,
  AggregateSavingsSkipDto,
  CostSummaryDto,
  GlobalDagDto,
} from '../dto';
import { agentTypeLabel, formatTokens, formatUsd, projectLabel, shortId } from '../format';
import { describeCostFlow } from './chart-summary';
import { computeCostWindows } from './cost-windows';
import { computeCostFlow, type FlowNode } from './layout/cost-flow';
import { SessionCostAnalysis } from './SessionCostAnalysis';
import { rankTopBurners } from './top-burners';
import type { ViewProps } from './types';

/** Top-N sessions requested from the summary endpoint. */
export const COST_TOP_N = 5;

/** Rows shown in the top-burners table. PROVISIONAL - enough for "who burned
 * the most?" without turning the table into a second DAG view. */
export const TOP_BURNERS_N = 10;

/**
 * Node cap for the burners' DAG fetch (same figure as the DAG view's cap).
 * PROVISIONAL. The server slices by RECENCY, not by burn, so when it
 * truncates, the true biggest burner may sit outside the returned slice -
 * the table carries a banner saying exactly that instead of pretending the
 * ranking is global.
 */
export const TOP_BURNERS_NODE_LIMIT = 1000;

/**
 * Id of the prose text alternative for the sankey. role="img" hides the SVG
 * subtree (its <title> elements included) from assistive tech, so the same
 * facts are published as visible prose and referenced with aria-describedby.
 */
const FLOW_SUMMARY_ID = 'cost-flow-summary';

type CostState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly summary: CostSummaryDto };

// The burners table has its own state machine: it rides a second endpoint
// (/api/dag/global), and a failure there must degrade ONE section, not take
// the whole cost view down with it.
type BurnersState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly dag: GlobalDagDto };

// Same reasoning for the M-9 aggregate: a third endpoint, a third state
// machine, so a failure there costs this view one section and nothing else.
type SavingsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly aggregate: AggregateDelegationSavingsDto };

function flowNodeClass(node: FlowNode): string {
  return node.colorIndex !== null ? `flow-node cat-${node.colorIndex}` : 'flow-node flow-neutral';
}

/** Unpriced cell: an explicit `~ n` marker, or a plain zero - never blank. */
function UnpricedCell({ tokens }: { readonly tokens: number }) {
  if (tokens === 0) return <td className="num muted">0</td>;
  return <td className="num unpriced">~ {formatTokens(tokens)}</td>;
}

/**
 * The M-8 burners table. Ranks the served DAG nodes by token burn (see
 * top-burners.ts for the key and why), and states its own scope out loud:
 * how many agents are ranked, how many were excluded for zero usage, and -
 * when the server truncated by recency - that the ranking covers a slice.
 */
function BurnersPanel({ dag }: { readonly dag: GlobalDagDto }) {
  const ranking = rankTopBurners(dag.nodes, TOP_BURNERS_N);
  if (ranking.rankedCount === 0) {
    return <p className="empty-state">No agent has recorded token usage yet.</p>;
  }
  return (
    <>
      {dag.counts.truncated && (
        <p className="truncation-banner" data-testid="burners-truncation">
          The server returned the {dag.counts.returnedAgents} most recently active of{' '}
          {dag.counts.totalAgents} agents (node limit {TOP_BURNERS_NODE_LIMIT}), so this ranking
          covers that slice only - an older agent may have burned more.
        </p>
      )}
      <p className="muted" data-testid="burners-scope">
        {ranking.entries.length < ranking.rankedCount
          ? `Top ${String(ranking.entries.length)} of ${String(ranking.rankedCount)} agents with recorded usage.`
          : `All ${String(ranking.rankedCount)} agent${ranking.rankedCount === 1 ? '' : 's'} with recorded usage.`}{' '}
        {ranking.zeroUsageCount > 0 &&
          `Not ranked: ${String(ranking.zeroUsageCount)} agent${ranking.zeroUsageCount === 1 ? '' : 's'} with zero recorded tokens. `}
        Usage unattributed to any persisted agent is outside this ranking.
      </p>
      <table className="data-table" aria-label="top agents by token burn">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Agent</th>
            <th>Session</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
            <th className="num">Unpriced</th>
          </tr>
        </thead>
        <tbody>
          {ranking.entries.map((agent, index) => (
            <tr key={agent.id}>
              <td className="num">{index + 1}</td>
              <td>
                {agentTypeLabel(agent.subagentType, agent.type)} <code>{shortId(agent.id)}</code>
              </td>
              <td>
                <code>{shortId(agent.sessionId)}</code>
              </td>
              <td className="num">{formatTokens(agent.totalTokens)}</td>
              <td className="num">{formatUsd(agent.costUsd)}</td>
              <UnpricedCell tokens={agent.unpricedTokens} />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** `1 session` / `2 sessions`. One branch, reused by all the scope copy. */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Wording for a skip reason, so the exclusion table never publishes a raw enum.
 * A lookup rather than a ternary chain: a reason added to the DTO then fails
 * the type check here instead of silently rendering the wrong sentence.
 */
const SKIP_REASON_LABEL: Record<AggregateSavingsSkipDto['reason'], string> = {
  unpriceable: 'No dated price',
  'undated-usage': 'Usage row carries no date',
};

/**
 * M-9 (aggregate half): the delegation-savings counterfactual summed across the
 * corpus, so the "was delegating worth it?" question has an answer that is not
 * one session at a time.
 *
 * Three honesty rules, all of them visible on screen rather than only in the
 * payload:
 *  1. it is an ESTIMATE - the cache profile of a run that never happened is not
 *     observable - hence the `~` prefixes and the badge, exactly like the
 *     per-session panel;
 *  2. it states its own SCOPE. An aggregate quietly computed over a subset is a
 *     lie, so the copy names how many sessions were priced, how many delegated
 *     at all, and how many exist - and says out loud that a session with no
 *     subagent is a measured zero rather than a gap;
 *  3. anything it could not price is NAMED, never dropped and never counted as
 *     $0 - by session id, with the reason the server gave. When the server caps
 *     that list, the cap is stated and the COUNT stays authoritative.
 *
 * The figures are what the included sessions' SUBAGENTS cost, not what those
 * sessions cost; the labels say so, because naming it wrong would turn a
 * subtotal into an apparent session total.
 */
function AggregateSavingsPanel({
  aggregate,
}: {
  readonly aggregate: AggregateDelegationSavingsDto;
}) {
  const subagentsSeen = aggregate.subagentsPriced + aggregate.subagentsSkipped;
  return (
    <>
      <p className="muted" data-testid="aggregate-savings-basis">
        Rebuilt from the stored usage rows, not from a re-read of the transcripts - so it moves with
        the database, exactly like every other figure on this page.
      </p>
      <div className="kpis" aria-label="aggregate delegation savings">
        <div className="kpi" data-testid="kpi-aggregate-savings">
          <span className="kpi-label">Saved by delegating</span>
          <span className="kpi-value">~ {formatUsd(aggregate.savingsUsd)}</span>
          <span className="muted kpi-note">
            estimated over {plural(aggregate.sessionsPriced, 'session')}
          </span>
        </div>
        <div className="kpi" data-testid="kpi-aggregate-actual">
          <span className="kpi-label">Subagent spend, actual</span>
          <span className="kpi-value">{formatUsd(aggregate.actualUsd)}</span>
          <span className="muted kpi-note">measured</span>
        </div>
        {/*
          Scoped in the LABEL, not only in the surrounding prose. Its sibling
          says "Subagent spend", so a bare "Without delegation" next to it reads
          as the counterfactual for the whole corpus - the one number on this
          panel a reader could take for a session-wide total. It is the same
          subagents-only counterfactual the session view calls "Same work, no
          delegation"; naming it the same way in both places is what stops the
          two views from looking like two different quantities.
        */}
        <div className="kpi" data-testid="kpi-aggregate-hypothetical">
          <span className="kpi-label">Same work, no delegation</span>
          <span className="kpi-value">~ {formatUsd(aggregate.hypotheticalUsd)}</span>
          <span className="muted kpi-note">
            {aggregate.hypotheticalModels.length === 0
              ? 'estimated, subagents only'
              : `estimated, subagents only, on ${aggregate.hypotheticalModels.join(', ')}`}
          </span>
        </div>
      </div>
      <p className="muted" data-testid="aggregate-savings-scope">
        Scope: {plural(aggregate.sessionsPriced, 'session')} priced of{' '}
        {plural(aggregate.sessionsWithSubagents, 'session')} that recorded a subagent, out of{' '}
        {plural(aggregate.sessionsTotal, 'session')} in the database. A session with no subagent had
        nothing to delegate and contributes a measured zero, not a gap.{' '}
        {aggregate.subagentsSkipped > 0 &&
          `${plural(aggregate.subagentsSkipped, 'subagent')} of ${String(subagentsSeen)} inside the priced sessions had no resolvable top-tier model and ${aggregate.subagentsSkipped === 1 ? 'is' : 'are'} left out - never guessed at. `}
        {aggregate.untypedAgents > 0 &&
          `${plural(aggregate.untypedAgents, 'agent row')} in the database carry no recorded type and count as neither main agent nor subagent here.`}
      </p>
      {aggregate.skippedSessionCount > 0 && (
        <>
          <p className="empty-state" data-testid="aggregate-savings-skipped">
            <span className="status-unknown">?</span>{' '}
            {plural(aggregate.skippedSessionCount, 'session')} could not be priced and{' '}
            {aggregate.skippedSessionCount === 1 ? 'is' : 'are'} excluded from the figures above
            rather than counted as $0.
          </p>
          <table className="data-table" aria-label="sessions excluded from the delegation estimate">
            <thead>
              <tr>
                <th>Session</th>
                <th>Reason</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {aggregate.skippedSessions.map((skip) => (
                <tr key={skip.sessionId}>
                  <td>
                    <code>{shortId(skip.sessionId)}</code>
                  </td>
                  <td>{SKIP_REASON_LABEL[skip.reason]}</td>
                  <td>{skip.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {aggregate.skippedSessionCount > aggregate.skippedSessions.length && (
            <p className="muted" data-testid="aggregate-savings-sample-note">
              Showing {aggregate.skippedSessions.length} of {aggregate.skippedSessionCount} excluded
              sessions - the list is a bounded sample, the count is authoritative.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function CostView({ token, onAuthRejected }: ViewProps) {
  const [state, setState] = useState<CostState>({ kind: 'loading' });
  const [burners, setBurners] = useState<BurnersState>({ kind: 'loading' });
  const [savings, setSavings] = useState<SavingsState>({ kind: 'loading' });
  // Per-session analysis (WP-C4/C5) reads transcripts off disk, so it is opt-in
  // per session rather than fetched for every row of the summary.
  const [analysedSessionId, setAnalysedSessionId] = useState<string | null>(null);
  // M-10: the reading that cuts the UTC windows below. It has to be read here,
  // above the early returns, because it is a hook - and it ticks, so this view
  // re-renders when the day boundary moves under a long-open tab.
  const nowMs = useNowMs();

  useEffect(() => {
    const controller = new AbortController();
    void fetchCostSummary(token, COST_TOP_N, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setState({ kind: 'error', message: result.message });
      } else {
        setState({ kind: 'ready', summary: result.data });
      }
    });
    return () => controller.abort();
  }, [token, onAuthRejected]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchGlobalDag(token, TOP_BURNERS_NODE_LIMIT, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setBurners({ kind: 'error', message: result.message });
      } else {
        setBurners({ kind: 'ready', dag: result.data });
      }
    });
    return () => controller.abort();
  }, [token, onAuthRejected]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAggregateSavings(token, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setSavings({ kind: 'error', message: result.message });
      } else {
        setSavings({ kind: 'ready', aggregate: result.data });
      }
    });
    return () => controller.abort();
  }, [token, onAuthRejected]);

  if (state.kind === 'loading') {
    return (
      <section aria-label="cost summary">
        <p className="muted">Loading cost summary…</p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section aria-label="cost summary">
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load cost summary: {state.message}
        </p>
      </section>
    );
  }

  const { summary } = state;
  const flow = computeCostFlow(summary);
  const maxDailyCost = Math.max(0, ...summary.perDay.map((day) => day.costUsd));
  // No tokens at all - priced or not - means nothing was ever recorded. That
  // is a different fact from "usage exists but none of it is priced", and the
  // copy must not let a $0.00 headline be read as the second.
  const nothingRecorded = summary.totals.tokens === 0 && summary.totals.unpricedTokens === 0;
  // M-10, closed: the boundary rides the shared clock, so a tab left open
  // across UTC midnight rolls the window over within one tick instead of
  // labelling yesterday's total "today". Label and figures are cut from the
  // SAME reading, so the two can never name different days. What the tiles do
  // NOT claim is freshness of the DATA: the perDay rows are as old as the last
  // summary fetch, exactly as they are one minute after any other render.
  const windows = computeCostWindows(summary.perDay, nowMs);

  return (
    <section aria-label="cost summary">
      <div className="kpis" aria-label="totals">
        <div className="kpi">
          <span className="kpi-label">Total cost</span>
          <span className="kpi-value">{formatUsd(summary.totals.costUsd)}</span>
          <span className="muted kpi-note">all time</span>
          {summary.totals.unpricedTokens > 0 && (
            <span className="muted kpi-note">priced tokens only</span>
          )}
        </div>
        <div className="kpi">
          <span className="kpi-label">Total tokens</span>
          <span className="kpi-value">{formatTokens(summary.totals.tokens)}</span>
          <span className="muted kpi-note">all time</span>
        </div>
        <div className="kpi" data-testid="kpi-unpriced">
          <span className="kpi-label">Unpriced tokens</span>
          <span className={summary.totals.unpricedTokens > 0 ? 'kpi-value unpriced' : 'kpi-value'}>
            {formatTokens(summary.totals.unpricedTokens)}
          </span>
          {summary.totals.unpricedTokens > 0 && (
            <span className="muted kpi-note">no price row matched - not counted in $</span>
          )}
        </div>
        {nothingRecorded && (
          <p className="empty-state" data-testid="no-usage-note">
            No usage recorded yet - these zeros are an empty database, not a measured $0.00.
          </p>
        )}
      </div>

      {/*
        The gap `unpricedTokens` cannot express. Unpriced tokens are rows the
        database HAS but cannot price; these are sessions whose bytes it could
        not carry, so part or all of their spend is in no figure on this page -
        and the omission only ever makes the totals look SMALLER. Rendered only
        when the server actually reported a nonzero count: `coverage` is absent
        when no ingest seam is wired, and a "0 sessions excluded" reassurance
        nobody measured would be the same lie in the opposite direction.

        WORDED to what the number actually supports. `sessionsExcluded` is
        `IngestExclusions.failing`, the size of the watcher's retry-budget map -
        i.e. sessions whose LATEST pass failed, which is not the same as
        sessions that were never ingested. One that ingested cleanly and only
        failed on a later append still has all its earlier rows in the database
        and its earlier spend in these totals; only the newest turns are absent.
        Claiming its spend is "missing from every figure" would be an overclaim
        in the honest direction, which is still an overclaim - a banner that
        overstates a gap gets discounted, and then it fails to be believed on
        the session that really did produce nothing. The lower-bound conclusion
        is the part that holds for both cases, so it is the part asserted.
      */}
      {summary.coverage !== undefined && summary.coverage.sessionsExcluded > 0 && (
        <p className="truncation-banner" data-testid="coverage-banner">
          {`${plural(summary.coverage.sessionsExcluded, 'session')} could not be ingested on the latest pass, so ${
            summary.coverage.sessionsExcluded === 1 ? 'its' : 'their'
          } spend is incomplete or absent in every figure on this page - these totals are a lower bound, not a complete one.`}
          {summary.coverage.sessionsQuarantined > 0 &&
            ` ${String(summary.coverage.sessionsQuarantined)} of those will not be retried until the corpus or the pricing table changes (usually a model with no price row).`}
        </p>
      )}

      <div className="kpis" aria-label="recent windows">
        <div className="kpi" data-testid="kpi-today">
          <span className="kpi-label">Today (UTC)</span>
          <span className="kpi-value">{formatUsd(windows.today.costUsd)}</span>
          <span className="muted kpi-note">
            {windows.todayUtc} · {formatTokens(windows.today.tokens)} tokens
          </span>
          {windows.today.unpricedTokens > 0 && (
            <span className="kpi-note unpriced">
              ~ {formatTokens(windows.today.unpricedTokens)} unpriced
            </span>
          )}
        </div>
        <div className="kpi" data-testid="kpi-week">
          <span className="kpi-label">Last 7 days (UTC)</span>
          <span className="kpi-value">{formatUsd(windows.last7Days.costUsd)}</span>
          <span className="muted kpi-note">
            {windows.weekStartUtc} → {windows.todayUtc} · {formatTokens(windows.last7Days.tokens)}{' '}
            tokens
          </span>
          {windows.last7Days.unpricedTokens > 0 && (
            <span className="kpi-note unpriced">
              ~ {formatTokens(windows.last7Days.unpricedTokens)} unpriced
            </span>
          )}
        </div>
      </div>
      <p className="muted windows-note" data-testid="windows-basis">
        Windows are UTC calendar days over the recorded usage timestamps - not your local timezone.{' '}
        {windows.unknownDay.tokens > 0 &&
          `${formatTokens(windows.unknownDay.tokens)} tokens carry no timestamp and sit outside every window (listed as "unknown" below).`}
      </p>

      <h2>
        Delegation savings, whole corpus{' '}
        <span className="badge-estimate" data-testid="aggregate-estimate-badge">
          estimate
        </span>
      </h2>
      {savings.kind === 'loading' && <p className="muted">Loading delegation savings…</p>}
      {savings.kind === 'error' && (
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load delegation savings:{' '}
          {savings.message}
        </p>
      )}
      {savings.kind === 'ready' && <AggregateSavingsPanel aggregate={savings.aggregate} />}

      <h2>Cost flow</h2>
      {flow.hasFlow ? (
        <>
          <div className="chart-scroll">
            <svg
              role="img"
              aria-label="cost flow from models to sessions"
              aria-describedby={FLOW_SUMMARY_ID}
              width={flow.width}
              height={flow.height}
              viewBox={`0 0 ${String(flow.width)} ${String(flow.height)}`}
            >
              {flow.links.map((link) => (
                <path
                  key={`${link.sourceId}->${link.targetId}`}
                  className={
                    link.colorIndex !== null
                      ? `flow-link cat-${link.colorIndex}`
                      : 'flow-link flow-neutral'
                  }
                  d={link.path}
                  strokeWidth={link.width}
                >
                  <title>{`${link.sourceId} -> ${link.targetId}: ${formatUsd(link.value)}`}</title>
                </path>
              ))}
              {flow.nodes.map((node) => (
                <g key={node.id} className={flowNodeClass(node)}>
                  <title>
                    {`${node.label}: ${formatUsd(node.value)}${node.unpricedTokens > 0 ? ` (+ ~${formatTokens(node.unpricedTokens)} unpriced tokens)` : ''}`}
                  </title>
                  <rect
                    x={node.x0}
                    y={node.y0}
                    width={node.x1 - node.x0}
                    height={Math.max(1, node.y1 - node.y0)}
                    fill="currentColor"
                  />
                  <text
                    className="node-label"
                    x={
                      node.kind === 'model' || node.kind === 'other-models'
                        ? node.x1 + 6
                        : node.x0 - 6
                    }
                    y={(node.y0 + node.y1) / 2 + 4}
                    textAnchor={
                      node.kind === 'model' || node.kind === 'other-models' ? 'start' : 'end'
                    }
                  >
                    {node.label}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <p className="chart-summary" id={FLOW_SUMMARY_ID}>
            {describeCostFlow(flow, summary.totals.unpricedTokens)}
          </p>
          <ul className="chart-legend" aria-label="model legend">
            {flow.nodes
              .filter((node) => node.kind === 'model' || node.kind === 'other-models')
              .map((node) => (
                <li key={node.id}>
                  <span className={flowNodeClass(node)} aria-hidden="true">
                    ■
                  </span>{' '}
                  {node.label}
                </li>
              ))}
          </ul>
        </>
      ) : (
        <p className="empty-state">
          Nothing priced yet - no dollar flow to draw. Token usage may still exist as unpriced
          tokens (see the tables below).
        </p>
      )}
      {flow.zeroCostModels.length > 0 && (
        <p className="muted" data-testid="zero-cost-models">
          Not in the flow (usage but $0 priced): {flow.zeroCostModels.join(', ')}.
        </p>
      )}

      <h2>Per model</h2>
      {summary.perModel.length === 0 ? (
        <p className="empty-state">No per-model usage recorded yet.</p>
      ) : (
        <table className="data-table" aria-label="cost per model">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Unpriced</th>
            </tr>
          </thead>
          <tbody>
            {summary.perModel.map((model) => (
              <tr key={model.model}>
                <td>{model.model}</td>
                <td className="num">{formatTokens(model.tokens)}</td>
                <td className="num">{formatUsd(model.costUsd)}</td>
                <UnpricedCell tokens={model.unpricedTokens} />
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Per day</h2>
      {summary.perDay.length === 0 ? (
        <p className="empty-state">No daily usage recorded yet.</p>
      ) : (
        <table className="data-table" aria-label="cost per day">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Unpriced</th>
              <th aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {summary.perDay.map((day) => (
              <tr key={day.day}>
                <td className={day.day === 'unknown' ? 'muted' : undefined}>{day.day}</td>
                <td className="num">{formatTokens(day.tokens)}</td>
                <td className="num">{formatUsd(day.costUsd)}</td>
                <UnpricedCell tokens={day.unpricedTokens} />
                <td className="bar-cell" aria-hidden="true">
                  <span
                    className="bar-fill"
                    style={{
                      width:
                        maxDailyCost > 0 ? `${String((day.costUsd / maxDailyCost) * 100)}%` : '0%',
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Top agent burners</h2>
      {burners.kind === 'loading' && <p className="muted">Loading agent burners…</p>}
      {burners.kind === 'error' && (
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load agent burners: {burners.message}
        </p>
      )}
      {burners.kind === 'ready' && <BurnersPanel dag={burners.dag} />}

      <h2>Top sessions</h2>
      {summary.topSessions.length === 0 ? (
        <p className="empty-state">No sessions recorded yet.</p>
      ) : (
        <table className="data-table" aria-label="top sessions by cost">
          <thead>
            <tr>
              <th>Session</th>
              <th>Project</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Unpriced</th>
            </tr>
          </thead>
          <tbody>
            {summary.topSessions.map((session) => (
              <tr
                key={session.sessionId}
                aria-selected={session.sessionId === analysedSessionId}
                className={session.sessionId === analysedSessionId ? 'row-selected' : undefined}
              >
                <td>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setAnalysedSessionId(session.sessionId);
                    }}
                  >
                    <code>{shortId(session.sessionId)}</code>
                  </button>
                </td>
                <td className={session.projectSlug === null ? 'muted' : undefined}>
                  {projectLabel(session.projectSlug)}
                </td>
                <td className="num">{formatTokens(session.tokens)}</td>
                <td className="num">{formatUsd(session.costUsd)}</td>
                <UnpricedCell tokens={session.unpricedTokens} />
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Session analysis</h2>
      {analysedSessionId === null ? (
        <p className="empty-state" data-testid="analysis-prompt">
          Pick a session above to reprice it across its compaction boundaries and estimate what it
          would have cost without delegation.
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
