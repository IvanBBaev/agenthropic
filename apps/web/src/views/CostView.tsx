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
 *   - F-1 (2026-09-01): rolling the window over is only half the problem. The
 *     rows do NOT roll over with it - they are fetched once - so past midnight
 *     the today tile summed a day the snapshot could not contain and printed
 *     the result as $0.00. The summary now carries the moment it was read, and
 *     the tile prints "not measured" rather than a zero it never measured.
 */
import { useEffect, useState } from 'react';
import { fetchAggregateSavings, fetchCostSummary, fetchGlobalDag } from '../api';
import { readNowMs, useNowMs } from '../clock';
import type {
  AggregateDelegationSavingsDto,
  AggregateSavingsSkipDto,
  CostSummaryDto,
  GlobalDagDto,
} from '../dto';
import { agentTypeLabel, formatTokens, formatUsd, projectLabel, shortId } from '../format';
import { describeCostFlow, hubImbalanceNote } from './chart-summary';
import { computeCostWindows } from './cost-windows';
import { computeCostFlow, type CostFlowLayout, type FlowNode } from './layout/cost-flow';
import { SessionCostAnalysis } from './SessionCostAnalysis';
import { NO_FIGURE_META } from './status';
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

/**
 * Ids of the two notices ABOVE the diagram, so they can be named as part of
 * its description (F-18).
 */
const FLOW_BALANCE_ID = 'cost-flow-balance';
const FLOW_UNDRAWABLE_ID = 'cost-flow-undrawable';

/**
 * What describes the sankey, in document order (F-18).
 *
 * The two notices are ordinary prose above the picture, so a reader going
 * down the page meets them before it. A reader who reaches the picture as a
 * picture - jumped to by image, or handed it by a screen reader that reads
 * `role="img"` and its description and nothing of the subtree - met only
 * `describeCostFlow`, which enumerates a confident, self-consistent flow and
 * has no idea the numbers behind it fail to reconcile or that a served cost
 * was left out of the drawing entirely. That is the honesty gap exactly
 * inverted: the reader with the least context got the most confident text.
 *
 * `aria-describedby` takes a LIST, so the fix is to name the notices rather
 * than to restate them. Restating would have put the same paragraph on screen
 * twice for a sighted reader, and two copies of a caveat that can drift apart
 * are worse than one.
 */
function flowDescribedBy(flow: CostFlowLayout): string {
  const ids: string[] = [];
  if (!flow.balance.balanced) ids.push(FLOW_BALANCE_ID);
  if (flow.undrawable.length > 0) ids.push(FLOW_UNDRAWABLE_ID);
  ids.push(FLOW_SUMMARY_ID);
  return ids.join(' ');
}

type CostState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  // `observedAtMs` is not decoration: without it the view cannot tell a day
  // with no spend from a day the snapshot predates. See the F-1 note below.
  | { readonly kind: 'ready'; readonly summary: CostSummaryDto; readonly observedAtMs: number };

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

/**
 * A dollar difference small enough that both sides of it print identically.
 * The same 1e-4 the layout balances the diagram with, and the same scale as
 * `formatUsd`'s four-decimal floor: below it a notice announcing a gap would
 * quote two figures the reader cannot tell apart.
 */
const USD_EPSILON = 1e-4;

/**
 * CV-2 (2026-09-08), AMENDED 2026-09-09 (CF-2). The hub's hover figure is
 * d3-sankey's `node.value`, which is the LARGER of the node's two sides when
 * they disagree, and the hub's two sides are served independently. The note
 * that states both sides and the gap between them used to be built here and
 * appended by this view; it now lives with the prose summary in
 * chart-summary.ts, for the reason CS-4 records there - a qualification kept
 * by the call site is a convention, not a property of the string, and the next
 * caller inherits the confident sentence without it. The full account of the
 * defect, of what was deliberately NOT changed (the max() itself), and of what
 * CF-2 closed at the source is in the docblock over `hubImbalanceNote`.
 *
 * This view still calls it for the hover, so the picture and its prose
 * alternative remain one string.
 */

/**
 * The hover text of one flow node: its label, its dollar figure, the unpriced
 * tokens sitting behind that figure, and - on the hub - what its two sides
 * carry (CV-2, above).
 *
 * AMENDED 2026-09-08 (CV-3). The unpriced clause was gated on
 * `unpricedTokens > 0`, the same test chart-summary.ts removed from its prose
 * in CS-2 and this picture kept. A count that arrives unreadable fails `> 0`
 * exactly as a measured zero does, so hovering a node whose unpriced gap is
 * unknown read identically to hovering one with no gap at all - while the
 * prose alternative for that same node said the count could not be read. One
 * page, two stories, decided by whether the reader can hover. Unreadable is
 * now its own case in both places, and the wording follows the prose.
 */
function flowNodeTitle(node: FlowNode, flow: CostFlowLayout): string {
  const unpriced = !Number.isFinite(node.unpricedTokens)
    ? ` (+ unpriced: ${formatTokens(node.unpricedTokens)})`
    : node.unpricedTokens > 0
      ? ` (+ ~${formatTokens(node.unpricedTokens)} unpriced tokens)`
      : '';
  const hubNote = hubImbalanceNote(node, flow);
  return `${node.label}: ${formatUsd(node.value)}${unpriced}${hubNote === '' ? '' : ` - ${hubNote}`}`;
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
  // AMENDED 2026-09-02 (F-6). The truncation banner used to live INSIDE the
  // ranked branch, below an early return for `rankedCount === 0`. The
  // reasoning was tidy - no ranking, nothing to qualify - and it inverted the
  // disclosure exactly where it mattered most: when the server returns a
  // recency slice in which nothing happens to carry tokens, the page dropped
  // the "this is a slice" warning and printed the confident global claim "No
  // agent has recorded token usage yet" over a corpus it had not seen. The
  // banner is now hoisted above every branch (the DAG view's own ordering),
  // and the empty copy no longer speaks for agents outside the slice.
  const truncationNotice = dag.counts.truncated ? (
    <p className="truncation-banner" data-testid="burners-truncation">
      The server returned the {dag.counts.returnedAgents} most recently active of{' '}
      {dag.counts.totalAgents} agents (node limit {TOP_BURNERS_NODE_LIMIT}), so this ranking covers
      that slice only - an older agent may have burned more.
    </p>
  ) : null;
  if (ranking.rankedCount === 0) {
    return (
      <>
        {truncationNotice}
        <p className="empty-state" data-testid="burners-empty">
          {dag.counts.truncated
            ? 'No agent in the returned slice has a recorded token count. That is a statement about the slice above, not about the agents outside it.'
            : 'No agent has a recorded token count yet. Usage unattributed to any persisted agent is outside this ranking either way.'}
        </p>
      </>
    );
  }
  return (
    <>
      {truncationNotice}
      <p className="muted" data-testid="burners-scope">
        {ranking.entries.length < ranking.rankedCount
          ? `Top ${String(ranking.entries.length)} of ${String(ranking.rankedCount)} agents with recorded usage.`
          : `All ${String(ranking.rankedCount)} agent${ranking.rankedCount === 1 ? '' : 's'} with recorded usage.`}{' '}
        {ranking.zeroUsageCount > 0 &&
          `Not ranked: ${String(ranking.zeroUsageCount)} agent${ranking.zeroUsageCount === 1 ? '' : 's'} with zero recorded tokens. `}
        {/*
          CA-6 (2026-09-03). Kept as its own sentence rather than added to the
          count above it. "We measured nothing" and "we cannot read what we
          measured" are different facts, and only the first is a statement
          about the agent: the second is a statement about our own figure.
          Summing them would let a parse failure be read as an idle agent.
        */}
        {ranking.unreadableUsageCount > 0 &&
          `Not ranked: ${String(ranking.unreadableUsageCount)} agent${ranking.unreadableUsageCount === 1 ? '' : 's'} whose recorded token count could not be read - that is a gap in our figure, not a measured zero. `}
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
 * The wording for a skip reason, or an explicit marker naming the raw word
 * when this build does not recognise it.
 *
 * AMENDED 2026-09-02 (F-9). The docblock above is right that a reason added to
 * the DTO fails the type check here - but that check runs at BUILD time,
 * against the DTO this bundle was compiled with. A browser holding an older
 * bundle against a newer server gets a word that is not in the map, the lookup
 * yields `undefined`, and React renders `undefined` as nothing at all: a blank
 * cell in a column headed "Reason", which reads as "excluded, for no stated
 * reason". An unknown wearing the costume of an absence, in the one table
 * whose entire job is to say why something was left out.
 */
function skipReasonLabel(reason: string): string {
  // Indexed through a widened view on purpose: `Record<Union, string>` types
  // the lookup as `string`, and that assumption is exactly what fails here.
  const known: Readonly<Record<string, string | undefined>> = SKIP_REASON_LABEL;
  return known[reason] ?? `unrecognised reason: ${reason}`;
}

/**
 * Width of a day's bar, or `null` when the served cost is not something a bar
 * can express at all.
 *
 * F-15 (2026-09-02). A bar has no length for a negative amount, and the CSS
 * width string `NaN%` is simply ignored - so a negative or unreadable day used
 * to render as an EMPTY cell, pixel-identical to a quiet $0.00 day. That is
 * the failure in a single cell: an impossible figure wearing the costume of an
 * ordinary one. `null` routes the cell to an explicit marker instead.
 */
function dailyBarWidth(costUsd: number, maxDailyCost: number): string | null {
  if (!Number.isFinite(costUsd) || costUsd < 0) return null;
  if (maxDailyCost <= 0) return '0%';
  return `${String((costUsd / maxDailyCost) * 100)}%`;
}

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
            {/* The gap marker, not the unrecognised-STATUS marker this line
                used to borrow. Nothing here is in an unknown state - a number
                could not be computed, which is a different fact and now has
                its own glyph in the shell legend. `aria-hidden` because the
                sentence beside it says the same thing in words. */}
            <span className={NO_FIGURE_META.className} aria-hidden="true">
              {NO_FIGURE_META.symbol}
            </span>{' '}
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
                  <td>{skipReasonLabel(skip.reason)}</td>
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
        // Stamped here, at the moment the rows arrive - not at render, where
        // it would drift, and not from the ticking store, whose reading can be
        // half a minute old and so can name the wrong UTC day near midnight.
        setState({ kind: 'ready', summary: result.data, observedAtMs: readNowMs() });
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
  // AMENDED 2026-09-02 (F-15). The `Math.max(0, ...)` seed stays load-bearing
  // - spreading an empty `perDay` without it yields -Infinity - but the spread
  // now takes finite costs only. A single unreadable day used to poison the
  // max, which then failed `maxDailyCost > 0` and flattened EVERY bar in the
  // table to 0%: one bad row silently erasing the whole column's information.
  const maxDailyCost = Math.max(
    0,
    ...summary.perDay.filter((day) => Number.isFinite(day.costUsd)).map((day) => day.costUsd),
  );
  // Days whose served cost no bar can express. Silent unless one exists - a
  // $0.00 day is a genuine zero-width bar, not a fault, and warning about it
  // would spend the credibility this notice needs when it does fire.
  const undrawableDays = summary.perDay.filter(
    (day) => !Number.isFinite(day.costUsd) || day.costUsd < 0,
  );
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
  //
  // AMENDED 2026-09-01 (F-1). The paragraph above is right about the mechanism
  // and wrong about what it buys. One reading makes the label and the figures
  // mutually CONSISTENT; it does not make either of them true. `perDay` is
  // fetched once, so past the rollover the window names a UTC day that no row
  // in the snapshot can carry, and "Today $0.00" is then guaranteed by the
  // shape of the data instead of measured from it - a structural zero in the
  // costume of a measured one. "The rows are as old as the last fetch" was
  // true and insufficient: ordinary staleness understates a NUMBER, this
  // overstates the CONFIDENCE in one, and the second is the failure this
  // dashboard exists to refuse. The discriminator is not inside `perDay` - an
  // idle day and an unread day are the same empty set - so the observation
  // time travels with the rows and `todayObserved` separates them.
  const windows = computeCostWindows(summary.perDay, nowMs, state.observedAtMs);
  // Only meaningful together with `!todayObserved`: an empty bucket the
  // snapshot could not have filled is a structural zero, a non-empty one is a
  // real (if incomplete) figure. Both count, because "0 tokens, $0.00" and
  // "0 tokens, some unpriced" are different states everywhere else on this page.
  const todayEmpty = windows.today.tokens === 0 && windows.today.unpricedTokens === 0;
  // CV-5: what the top-sessions table covers, in dollars, and what it does
  // not. Both are arithmetic on the served payload - no second endpoint is
  // consulted, so neither figure can be fresher or staler than the rows.
  const shownSessionsUsd = summary.topSessions.reduce((sum, session) => sum + session.costUsd, 0);
  const outsideTopSessionsUsd = summary.totals.costUsd - shownSessionsUsd;

  return (
    <section aria-label="cost summary">
      <div className="kpis" aria-label="totals">
        <div className="kpi">
          <span className="kpi-label">Total cost</span>
          <span className="kpi-value">{formatUsd(summary.totals.costUsd)}</span>
          <span className="muted kpi-note">all time</span>
          {/*
            AMENDED 2026-09-08 (CV-4). `> 0` treated an unpriced count that
            arrived unreadable exactly as it treats a measured zero: the note
            disappeared and this tile presented its total as covering every
            token. The Unpriced tokens tile two columns over prints "tokens
            unreadable" for the same field, so the page contradicted itself
            within one row of KPIs, and the tile a reader trusts for the
            bottom line was the confident one. Unreadable is now its own case.
            The total itself is untouched - it is a real sum of real priced
            tokens - but nothing here claims to know what it leaves out.
          */}
          {!Number.isFinite(summary.totals.unpricedTokens) ? (
            <span className="muted kpi-note" data-testid="kpi-total-unpriced-unknown">
              the unpriced-token count came back unreadable - what this leaves out is unknown
            </span>
          ) : summary.totals.unpricedTokens > 0 ? (
            <span className="muted kpi-note">priced tokens only</span>
          ) : null}
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
          {windows.todayObserved ? (
            <>
              <span className="kpi-value">{formatUsd(windows.today.costUsd)}</span>
              <span className="muted kpi-note">
                {windows.todayUtc} · {formatTokens(windows.today.tokens)} tokens
              </span>
              {windows.today.unpricedTokens > 0 && (
                <span className="kpi-note unpriced">
                  ~ {formatTokens(windows.today.unpricedTokens)} unpriced
                </span>
              )}
            </>
          ) : todayEmpty ? (
            // The tab outlived its fetch by a UTC day AND the snapshot holds
            // nothing dated today, so the sum is zero by construction. Printing
            // $0.00 here would be the one thing worse than printing nothing: a
            // number nobody measured, in the format reserved for numbers
            // somebody did.
            <>
              <span className="kpi-value unpriced" data-testid="kpi-today-unread">
                not measured
              </span>
              <span className="muted kpi-note">
                {windows.todayUtc} · no usage was dated today when this page was read on{' '}
                {windows.observedUtc} - reload to measure it
              </span>
            </>
          ) : (
            // Same stale snapshot, but the bucket is NOT empty - a writer whose
            // clock ran ahead dated rows into today before the read. The figure
            // is real, so blanking it would destroy information; it just cannot
            // be complete, because nothing recorded since the read is here.
            <>
              <span className="kpi-value">{formatUsd(windows.today.costUsd)}</span>
              <span className="muted kpi-note">
                {windows.todayUtc} · {formatTokens(windows.today.tokens)} tokens
              </span>
              <span className="kpi-note unpriced" data-testid="kpi-today-partial">
                read on {windows.observedUtc} · a lower bound, anything since is unread
              </span>
            </>
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
          {/*
            Weaker than the today tile on purpose. This window still holds six
            measured days, so the figure is a real lower bound rather than an
            artefact - it is only the tail of the range that is unread. Blanking
            it would hide more truth than it protects.
          */}
          {!windows.todayObserved && (
            <span className="kpi-note unpriced" data-testid="kpi-week-partial">
              read on {windows.observedUtc} · a lower bound, the rest of this window is unread
            </span>
          )}
        </div>
      </div>
      <p className="muted windows-note" data-testid="windows-basis">
        Windows are UTC calendar days over the recorded usage timestamps - not your local timezone.{' '}
        {windows.unknownDay.tokens > 0 &&
          `${formatTokens(windows.unknownDay.tokens)} tokens carry no timestamp and sit outside every window (listed as "unknown" below).`}{' '}
        {/*
          CA-5 (2026-09-03). `computeCostWindows` keeps rows dated after today
          out of both windows, and that exclusion is right: folding them into
          "last 7 days" would inflate a window they are not in. What was
          missing is the admission that it happened at all. A future-dated row
          is evidence that the machine which wrote the transcript and the
          machine reading it disagree about the clock - which is exactly the
          assumption the tile labelled "today" rests on. Dropping the row kept
          the sums honest and left the reader trusting a boundary the data had
          just contradicted.
        */}
        {windows.futureDated.tokens > 0 &&
          `${formatUsd(windows.futureDated.costUsd)} across ${formatTokens(windows.futureDated.tokens)} tokens is dated after ${windows.todayUtc} - later than this machine's clock - and is in neither window: the corpus and this browser disagree about what day it is.`}
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
      {/*
        F-7 / F-8 (2026-09-02). Both notices sit ABOVE the diagram and outside
        the `hasFlow` branch: an undrawable cost is undrawable whether or not
        anything else could be drawn, and the balance check is precisely what
        the reader needs BEFORE reading the picture. They are ordinary prose
        outside the role="img" subtree, so assistive tech reaches them in
        document order (the sankey's own text alternative is built by
        describeCostFlow, which does not know these facts - see the report).

        AMENDED 2026-09-02 (F-18): "assistive tech reaches them in document
        order" was true only of a reader who travels in document order. Reaching
        the sankey AS an image - jumped to, or read as `role="img"` plus its
        description - skipped both notices and delivered only the confident
        summary. Fixed by naming these two paragraphs in the diagram's own
        `aria-describedby` list (see flowDescribedBy) rather than by teaching
        describeCostFlow to repeat them, which would have printed the same
        caveat twice on screen.
      */}
      {!flow.balance.balanced && (
        <p className="truncation-banner" id={FLOW_BALANCE_ID} data-testid="flow-balance">
          This diagram does not account for itself - read it as a sketch and the tables below as the
          record.{' '}
          {!flow.balance.totalReadable &&
            'The served all-time total is not a readable amount, so nothing here can be reconciled against it. '}
          {flow.balance.modelsMinusTotalUsd !== 0 &&
            `The per-model rows sum to ${formatUsd(flow.balance.perModelUsd)} while the served total is ${formatUsd(flow.balance.totalUsd)}; the left side of the diagram is drawn from the first and the right side from the second, and they differ by ${formatUsd(flow.balance.modelsMinusTotalUsd)}. `}
          {flow.balance.sessionsOverTotalUsd > 0 &&
            `The top sessions alone sum to ${formatUsd(flow.balance.sessionsUsd)}, more than the served total ${formatUsd(flow.balance.totalUsd)}; the ${formatUsd(flow.balance.sessionsOverTotalUsd)} excess cannot be drawn as a remainder, so the sessions shown are not a subset of that total. `}
        </p>
      )}
      {flow.undrawable.length > 0 && (
        <p className="truncation-banner" id={FLOW_UNDRAWABLE_ID} data-testid="flow-undrawable">
          Not drawn, because no ribbon can carry the amount served:{' '}
          {flow.undrawable.map((entry) => `${entry.label} ${formatUsd(entry.costUsd)}`).join(', ')}.
          The figure is printed here exactly as it arrived rather than dropped from the diagram in
          silence.
        </p>
      )}
      {flow.hasFlow ? (
        <>
          <div className="chart-scroll">
            <svg
              role="img"
              aria-label="cost flow from models to sessions"
              aria-describedby={flowDescribedBy(flow)}
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
                  <title>{flowNodeTitle(node, flow)}</title>
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
          {/*
            CV-2 (2026-09-08). The hub note is published here as well as in the
            hover, from the same builder, for the reason F-18 gives above:
            `role="img"` hides the <title> elements from assistive tech, and a
            caveat only a mouse can reach has not been published. This
            paragraph is already named in the diagram's aria-describedby list,
            so no id and no list changes. One string rendered twice cannot
            drift; two strings could, which is why there is one.

            AMENDED 2026-09-09 (CF-2). Still one string, from one builder - but
            this paragraph no longer appends it. `describeCostFlow` states the
            hub itself, last, so the caveat travels with the summary instead of
            being re-attached by every view that renders one. The rendered
            paragraph is byte-for-byte what it was.
          */}
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
      {undrawableDays.length > 0 && (
        <p className="truncation-banner" data-testid="perday-undrawable">
          Not drawable as a bar:{' '}
          {undrawableDays.map((day) => `${day.day} (${formatUsd(day.costUsd)})`).join(', ')}. The
          bar column is scaled from the drawable days only, so a missing bar there means the cost
          could not be expressed - not that the day was quiet.
        </p>
      )}
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
            {summary.perDay.map((day) => {
              const barWidth = dailyBarWidth(day.costUsd, maxDailyCost);
              return (
                <tr key={day.day}>
                  <td className={day.day === 'unknown' ? 'muted' : undefined}>{day.day}</td>
                  <td className="num">{formatTokens(day.tokens)}</td>
                  <td className="num">{formatUsd(day.costUsd)}</td>
                  <UnpricedCell tokens={day.unpricedTokens} />
                  <td className="bar-cell" aria-hidden="true">
                    {barWidth === null ? (
                      <span className="status-error">✕</span>
                    ) : (
                      <span className="bar-fill" style={{ width: barWidth }} />
                    )}
                  </td>
                </tr>
              );
            })}
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
      {/*
        CV-5 (2026-09-08). The heading said "Top sessions" and the table said
        nothing else: five rows, no statement that five is all this view ever
        asked for, and no hint that the corpus might hold five hundred. The
        server slices `bySession` to `topN` by cost (queries.ts), so a full
        table is a slice by construction - and the dollars outside it were
        computable from the same payload the whole time. They are the same
        remainder the sankey draws as "other sessions"; a reader who never
        reaches the picture, or reaches it on a corpus with no drawable flow,
        met the truncated table with no scope at all.

        The count is deliberately hedged rather than asserted: this payload
        cannot distinguish a corpus of exactly COST_TOP_N sessions from one
        with far more, and inventing a total from the savings endpoint would
        be a figure from another read presented as this one's.
      */}
      {summary.topSessions.length >= COST_TOP_N && (
        <p className="muted" data-testid="top-sessions-scope">
          {`The ${String(COST_TOP_N)} costliest sessions: this view asks for ${String(COST_TOP_N)} and the server returned ${String(summary.topSessions.length)}, so these rows are a slice unless the corpus holds exactly that many - nothing in this payload says which. They account for ${formatUsd(shownSessionsUsd)} of the ${formatUsd(summary.totals.costUsd)} all-time total.`}
          {outsideTopSessionsUsd > USD_EPSILON &&
            ` The other ${formatUsd(outsideTopSessionsUsd)} was spent in sessions this table does not list.`}
        </p>
      )}
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
