/**
 * Per-session cost analysis (WP-C4 + WP-C5) - the UI consumer for
 * `GET /api/sessions/:id/cost-analysis`.
 *
 * The endpoint shipped without one, which meant the "Phase-4 exit gate: all
 * five daily questions answerable (server + UI)" claim was true of the server
 * and false of the dashboard. This panel is what makes it true.
 *
 * Two honesty rules drive the whole layout, and neither is cosmetic:
 *
 *  1. Delegation savings is a COUNTERFACTUAL. The schema pins `isEstimate` to
 *     the literal `true` precisely so it cannot be switched off, because the
 *     cache profile of the run that never happened is not observable. It is
 *     therefore rendered with a `~`, an explicit "estimate" badge and the
 *     hypothetical model named - never as a bare dollar amount that reads like
 *     the measured figures above it.
 *  2. `skippedAgentIds` are the subagents with no resolvable top-tier model.
 *     They are EXCLUDED from the estimate rather than guessed at, so the count
 *     is shown next to it. A savings figure quietly computed over a subset is
 *     the same class of lie as a silent $0.
 *
 * Compaction repricing, by contrast, is measured: naive and repriced are both
 * ground truth. Its `deltaUsd` is NOT a saving and must not be dressed as one -
 * on a complete substrate it should be ~0, and a materially nonzero delta is a
 * loud mispricing signal that the schema says is "served as-is, never averaged
 * away". So the panel calls a nonzero delta what it is: a discrepancy worth
 * looking at, not money anyone earned.
 *
 * AMENDED 2026-09-03 (CA-1..CA-4). The two rules above were right and were
 * enforced; what neither of them covered:
 *
 *  - CA-1. The two count cells in the segment table went to `toLocaleString`
 *    unguarded while the dollar cell next to them was guarded. Payloads reach
 *    this panel through an unchecked cast (see `formatTokens`' F-5 note), so
 *    those cells rendered `NaN`/`∞` as if they were counts, or threw and took
 *    the page down. A guard on the money and none on the tokens is backwards:
 *    tokens are the ground truth the money is derived FROM.
 *  - CA-2. Rule 2 showed the excluded COUNT but never its denominator, and the
 *    exclusion is wider than the text implied: `packages/core` skips an
 *    unpriceable subagent in all three sums, so its real, measured dollars are
 *    missing from the level labelled "measured" too. The label is now scoped to
 *    the subagents actually in it.
 *  - CA-3. `savingsUsd` is Σ max(0, hypothetical - actual) per subagent, so the
 *    three figures do not subtract when any subagent cost MORE than the
 *    alternative: the overspend is floored to zero and never netted. Read as a
 *    difference, "Saved" then overstates. Said outright, where it happens.
 *  - CA-4. Every caveat above was prose reachable only by reading the page in
 *    visual order, while the tables are landmarks a reader can jump straight
 *    into. Both tables and both figure groups now carry the caveats as their
 *    accessible description (the F-18 pattern from `CostView`), so the reader
 *    with the least context no longer gets the most confident numbers.
 */
import { useEffect, useState } from 'react';
import { fetchCostAnalysis } from '../api';
import type { CostAnalysisDto } from '../dto';
import { formatTokens, formatUsd, hasVisibleText, nameOrBlank, shortId } from '../format';
import { NO_FIGURE_META } from './status';

type AnalysisState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly analysis: CostAnalysisDto };

/**
 * Turn one failure into the sentence that names what actually went wrong.
 *
 * This route reads transcripts off disk, so its failures are NOT
 * interchangeable and must not collapse into "could not load": 503 means the
 * analysis is unavailable on this server, 404 means the corpus was searched and
 * holds no such transcript, 422 means the transcript itself yields nothing this
 * panel can show. Each one implies a different action by the reader, which is
 * why `ApiResult` carries the status at all.
 *
 * 503 and 422 FRAME the server's own sentence rather than restating a cause,
 * because each now has more than one: a 503 is "no provider wired", "no corpus
 * root on this machine" or "the corpus root could not be read", and a 422 is
 * either an unparseable
 * transcript, an unpriceable model, or a session that holds no analysable
 * records at all. An earlier version hard-coded one cause per status - so the
 * reader was told "this server has no corpus configured" about a machine whose
 * corpus was merely missing, and "could not be parsed or priced" about a
 * transcript that parsed perfectly and simply had nothing in it. Naming the
 * wrong cause is worse than naming none: it sends the reader to fix a thing
 * that is not broken.
 */
export function analysisErrorText(message: string, status: number | null): string {
  if (status === 503) {
    return `Per-session analysis is unavailable on this server: ${message}`;
  }
  if (status === 404) {
    return 'The corpus holds no transcript for this session - nothing to analyse.';
  }
  if (status === 422) {
    return `This session cannot be analysed: ${message}`;
  }
  return message;
}

/**
 * A signed dollar delta, so an over- and an under-count never look alike.
 *
 * The non-finite case is handed straight to `formatUsd`: `NaN >= 0` is false,
 * so without this the gap marker would come back wearing a minus sign, and
 * "-cost unreadable" claims a DIRECTION for a figure that has no value.
 */
function signedUsd(deltaUsd: number): string {
  if (!Number.isFinite(deltaUsd)) return formatUsd(deltaUsd);
  return deltaUsd >= 0 ? `+${formatUsd(deltaUsd)}` : `-${formatUsd(Math.abs(deltaUsd))}`;
}

/**
 * Sub-cent deltas are rounding, not signal. Anything at or above a cent is
 * called out, because the contract is that repricing agrees with the naive sum
 * on a complete substrate - so a real gap means the substrate or the pricing is
 * incomplete, and the reader should be told rather than shown a tidy number.
 */
const DELTA_SIGNAL_USD = 0.01;

/** The five priced buckets summed - what "tokens" means for one segment. */
function segmentTokens(tokens: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}): number {
  return (
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
  );
}

/**
 * A message count that is not a number at all. Worded like `UNREADABLE_USD` and
 * `UNREADABLE_TOKENS` - subject, then state - so the three gaps read as one
 * vocabulary and none of them can be mistaken for a quantity.
 */
const UNREADABLE_COUNT = 'messages unreadable';

/**
 * CA-1. `toLocaleString` does not throw on `NaN` or `Infinity`; it returns
 * "NaN" and "∞", right-aligned in a numeric column beside figures that are
 * real. On an absent field it throws instead, and with no error boundary in
 * this tree that blanks the whole page. One `Number.isFinite` covers all four
 * shapes (absent, null, NaN, infinite), which is also the only way to keep the
 * guard reachable from a test under this repo's 100% branch gate.
 */
function messageCountLabel(messageCount: number): string {
  return Number.isFinite(messageCount) ? messageCount.toLocaleString('en-US') : UNREADABLE_COUNT;
}

/**
 * CA-4. Ids for the caveat paragraphs, so they can be named as the accessible
 * DESCRIPTION of the figures they qualify - the F-18 pattern from `CostView`.
 * A table is a landmark: a reader can jump into "delegation savings per agent"
 * and hear its name and its cells without ever passing the prose above it. And
 * the `~` that carries "estimate" visually is punctuation most screen readers
 * drop at default verbosity, so for that reader the modelled figures arrive
 * looking exactly like the measured ones.
 */
const COMPACTION_SIGNAL_ID = 'analysis-compaction-signal';
const COMPACTION_UNKNOWN_ID = 'analysis-compaction-unknown';
const DELEGATION_BASIS_ID = 'analysis-delegation-basis';
const DELEGATION_SCOPE_ID = 'analysis-delegation-scope';
const DELEGATION_FLOOR_ID = 'analysis-delegation-floor';
const DELEGATION_SKIPPED_ID = 'analysis-delegation-skipped';

/**
 * The caveats in DOCUMENT order, which is the order a sighted reader meets
 * them. Only ids that are actually rendered may appear: `aria-describedby`
 * pointing at a missing element is silently dropped by some assistive
 * technology and read as an empty string by others, so a dangling id is a
 * caveat that disappears without anyone noticing.
 *
 * AMENDED 2026-09-23 (lane-M): the first parameter was `dearerAgentCount`, and
 * the rule it encodes has not changed - name the floor paragraph exactly when
 * the floor paragraph exists. What changed is when it exists: it now also
 * speaks for subagents whose figures could not be compared at all, so the
 * caller passes the number of rows the paragraph speaks for rather than the
 * number of dearer ones.
 */
function delegationDescribedBy(floorNoticeCount: number, skippedAgentCount: number): string {
  const ids = [DELEGATION_BASIS_ID, DELEGATION_SCOPE_ID];
  if (floorNoticeCount > 0) ids.push(DELEGATION_FLOOR_ID);
  if (skippedAgentCount > 0) ids.push(DELEGATION_SKIPPED_ID);
  return ids.join(' ');
}

/**
 * The "Would have run on" cell (2026-09-23, lane-P) - the per-session sibling
 * of `CostView`'s `ModelCell`, with the same marker for the same reason.
 *
 * `hypotheticalModel` is a plain string on the wire, and `isAgentSavingsRow`
 * in `dto-guards.ts` certifies the three dollar figures and the `agentId` and
 * deliberately not this, so a row naming no counterfactual model is
 * contract-valid. It rendered as an empty `<code></code>` between a real agent
 * id and three real dollar figures: the row went on claiming what the work
 * WOULD have cost while the cell that says what it would have run on said
 * nothing. The assumption is the only thing that makes the other three numbers
 * mean anything, so it is the last cell that may go quiet.
 */
function HypotheticalModelCell({ model }: { readonly model: string }) {
  if (hasVisibleText(model))
    return (
      <td>
        <code>{model}</code>
      </td>
    );
  return (
    <td data-testid="hypothetical-model-blank">
      <span className={NO_FIGURE_META.className} aria-hidden="true">
        {NO_FIGURE_META.symbol}
      </span>{' '}
      {nameOrBlank(model, 'model name')}
    </td>
  );
}

export interface SessionCostAnalysisProps {
  readonly token: string;
  readonly sessionId: string;
  readonly onAuthRejected: () => void;
}

export function SessionCostAnalysis({
  token,
  sessionId,
  onAuthRejected,
}: SessionCostAnalysisProps) {
  const [state, setState] = useState<AnalysisState>({ kind: 'loading' });
  // KK6. Bumped by the Retry button. Re-selecting the same session changes no
  // prop, so without a key of its own a failed analysis could never be re-run.
  const [requestKey, setRequestKey] = useState(0);

  useEffect(() => {
    // A new session id restarts the panel at `loading`; without this the
    // previous session's numbers would stay on screen under the new heading.
    setState({ kind: 'loading' });
    const controller = new AbortController();
    void fetchCostAnalysis(token, sessionId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setState({ kind: 'error', message: analysisErrorText(result.message, result.status) });
      } else {
        setState({ kind: 'ready', analysis: result.data });
      }
    });
    return () => controller.abort();
  }, [token, sessionId, onAuthRejected, requestKey]);

  if (state.kind === 'loading') {
    return (
      <p className="muted" data-testid="analysis-loading">
        Analysing session {shortId(sessionId)}…
      </p>
    );
  }

  if (state.kind === 'error') {
    return (
      <p className="empty-state" data-testid="analysis-error">
        <span className="status-error">✕</span> {state.message}{' '}
        <button
          type="button"
          onClick={() => {
            setRequestKey((key) => key + 1);
          }}
        >
          Retry
        </button>
      </p>
    );
  }

  const { compaction, delegationSavings } = state.analysis;

  // Derived once: the banner and the table's accessible description have to
  // agree about whether there is a signal, and two copies of the comparison is
  // how they stop agreeing.
  const hasDeltaSignal = Math.abs(compaction.deltaUsd) >= DELTA_SIGNAL_USD;
  // KK6. The comparison above is false for NaN, so on its own it went silent
  // exactly when the difference could not be read. Unknown is its own state.
  const deltaUnknown = !Number.isFinite(compaction.deltaUsd);
  const compactionDescribedBy = hasDeltaSignal
    ? COMPACTION_SIGNAL_ID
    : deltaUnknown
      ? COMPACTION_UNKNOWN_ID
      : undefined;

  // THREE delegation states, not two, because the middle one is a lie when it
  // is rendered like the others. `perAgent` is empty either because no subagent
  // ran - nothing to estimate - or because every subagent that DID run was
  // skipped for an unresolvable top-tier model: everything to estimate, none of
  // it priceable. The three sums are 0.00 in both cases, so the shared
  // rendering says "delegation saved you nothing" where the honest answer is
  // "not known", and the empty state says "no subagent ran" about a session
  // that delegated. A zero presented as a measurement is worse than a gap.
  const skippedAgentCount = delegationSavings.skippedAgentIds.length;
  const noDelegationRan = delegationSavings.perAgent.length === 0 && skippedAgentCount === 0;
  const allDelegationSkipped = delegationSavings.perAgent.length === 0 && skippedAgentCount > 0;
  const hasDelegationEstimate = !noDelegationRan && !allDelegationSkipped;

  // CA-2. The denominator the three delegation figures are computed over.
  // `packages/core` skips an unpriceable subagent with a `continue`, so it is
  // absent from the MEASURED sum as well as the two modelled ones - which the
  // panel's own labels ("measured, subagents only") did not admit. A ratio
  // whose denominator excludes rows has to say so where the ratio is printed,
  // and these three figures are exactly that ratio's numerator.
  const pricedAgentCount = delegationSavings.perAgent.length;
  const delegatingAgentCount = pricedAgentCount + skippedAgentCount;
  const coverageNote =
    skippedAgentCount === 0 ? '' : ` · ${pricedAgentCount} of ${delegatingAgentCount} subagents`;

  // CA-3. Subagents that cost MORE than the top-tier alternative would have.
  // Their overspend is floored to $0.00 per subagent before summing, so it is
  // never netted off "Saved" - which therefore is NOT the difference between
  // the two levels above it, however much the layout suggests it is.
  //
  // AMENDED 2026-09-23 (lane-M). `hypotheticalUsd < agent.actualUsd` answers
  // "is it dearer?" with false for BOTH "no" and "cannot tell", because every
  // comparison against a non-finite number is false - and `dto-guards.ts`
  // promises `typeof === 'number'`, which NaN satisfies, so such a row reaches
  // this line intact. A subagent whose estimate could not be read was therefore
  // counted with the cheap ones, and when it was the only candidate the whole
  // paragraph disappeared: the panel printed "Saved ~$X" with no caveat, which
  // on this page states that every priced subagent came out at or below the
  // top-tier alternative. The comparison is now made only over rows that can be
  // compared, and the rest are counted and said out loud - the same shape the
  // windows and `/api/cost/summary` use, the figure carrying the count of what
  // it leaves out.
  const comparableAgents = delegationSavings.perAgent.filter(
    (agent) => Number.isFinite(agent.hypotheticalUsd) && Number.isFinite(agent.actualUsd),
  );
  const uncomparableAgentCount = delegationSavings.perAgent.length - comparableAgents.length;
  const dearerAgentCount = comparableAgents.filter(
    (agent) => agent.hypotheticalUsd < agent.actualUsd,
  ).length;
  const delegationDescription = delegationDescribedBy(
    dearerAgentCount + uncomparableAgentCount,
    skippedAgentCount,
  );

  return (
    <div data-testid="session-analysis">
      <h3>Compaction repricing</h3>
      {compaction.compactionCount === 0 ? (
        <p className="empty-state" data-testid="no-compaction">
          This session was never compacted, so there is nothing to reprice.
        </p>
      ) : (
        <>
          <div className="kpis" role="group" aria-label="compaction repricing">
            <div className="kpi">
              <span className="kpi-label">Naive</span>
              <span className="kpi-value">{formatUsd(compaction.naiveUsd)}</span>
              <span className="muted kpi-note">one pass, boundaries ignored</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Repriced</span>
              <span className="kpi-value">{formatUsd(compaction.repricedUsd)}</span>
              <span className="muted kpi-note">summed per compaction segment</span>
            </div>
            <div className="kpi" data-testid="compaction-delta">
              <span className="kpi-label">Difference</span>
              <span className="kpi-value">{signedUsd(compaction.deltaUsd)}</span>
              <span className="muted kpi-note">
                across {compaction.compactionCount}{' '}
                {compaction.compactionCount === 1 ? 'compaction' : 'compactions'}
              </span>
            </div>
          </div>
          {hasDeltaSignal && (
            <p className="empty-state" id={COMPACTION_SIGNAL_ID} data-testid="delta-signal">
              <span className="status-error">✕</span> These two should agree. A difference this size
              means the substrate or the pricing is incomplete - it is a mispricing signal, not a
              saving.
            </p>
          )}
          {deltaUnknown && (
            <p className="empty-state" id={COMPACTION_UNKNOWN_ID} data-testid="delta-unknown">
              <span className={NO_FIGURE_META.className} aria-hidden="true">
                {NO_FIGURE_META.symbol}
              </span>{' '}
              The difference could not be computed, so whether this session is mispriced is unknown.
            </p>
          )}
          <table
            className="data-table"
            aria-label="compaction segments"
            aria-describedby={compactionDescribedBy}
          >
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Transcript</th>
                <th>Opened by</th>
                <th className="num">Messages</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {compaction.segments.map((segment) => (
                <tr key={`${segment.agentId ?? 'main'}-${String(segment.index)}`}>
                  <td className="num">{segment.index + 1}</td>
                  <td className={segment.agentId === null ? 'muted' : undefined}>
                    {segment.agentId === null ? 'main' : <code>{shortId(segment.agentId)}</code>}
                  </td>
                  {/* The first segment of any transcript is opened by nothing;
                      that is a fact about the stream, not missing data. */}
                  <td className={segment.boundary === null ? 'muted' : undefined}>
                    {segment.boundary === null
                      ? 'session start'
                      : (segment.boundary.trigger ?? 'compaction')}
                  </td>
                  <td className="num">{messageCountLabel(segment.messageCount)}</td>
                  <td className="num">{formatTokens(segmentTokens(segment.tokens))}</td>
                  <td className="num">{formatUsd(segment.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>
        Delegation savings{' '}
        <span className="badge-estimate" data-testid="estimate-badge">
          estimate
        </span>
      </h3>
      <p className="muted" id={DELEGATION_BASIS_ID}>
        What the <strong>delegated work</strong> would have cost with no subagents - every delegated
        turn run on <strong>the top-tier model</strong> instead. The cache profile of a run that
        never happened is not observable, so this is a modelled figure, not a measurement.
      </p>
      {/*
        SCOPE, stated because the two levels are NOT session totals. Both sums
        run over subagents only: the main agent's own turns are identical in
        both worlds (the routing decision never touched them), so they cancel
        in the difference and are deliberately in neither figure. That makes
        "Saved" exactly right and the two levels smaller than this session's
        cost - so they are labelled for the slice they measure. An earlier
        version labelled them "Actual" and "Without delegation", which read as
        session dollars and invited the reader to compare a subagent-only sum
        against the session total two panels up and conclude money was missing.
      */}
      {hasDelegationEstimate && (
        <>
          <p className="muted" id={DELEGATION_SCOPE_ID} data-testid="delegation-scope">
            Both levels below cover the delegated turns only. The main agent&apos;s own spend is in
            neither, because it is the same with or without delegation - which is why it cancels out
            and leaves the saving unaffected.
          </p>
          <div
            className="kpis"
            role="group"
            aria-label="delegation savings"
            aria-describedby={delegationDescription}
          >
            <div className="kpi">
              <span className="kpi-label">Delegated work, actual</span>
              <span className="kpi-value">{formatUsd(delegationSavings.actualUsd)}</span>
              {/* CA-2: the coverage suffix appears only when something was in
                  fact excluded. A denominator printed when the figure covers
                  everything is a caveat spent on a day nothing is wrong, and
                  it is spent on the day it is finally right. */}
              <span className="muted kpi-note">measured, subagents only{coverageNote}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Same work, no delegation</span>
              <span className="kpi-value">~ {formatUsd(delegationSavings.hypotheticalUsd)}</span>
              <span className="muted kpi-note">estimated, subagents only{coverageNote}</span>
            </div>
            <div className="kpi" data-testid="savings-kpi">
              <span className="kpi-label">Saved</span>
              <span className="kpi-value">~ {formatUsd(delegationSavings.savingsUsd)}</span>
              <span className="muted kpi-note">estimated{coverageNote}</span>
            </div>
          </div>
          {/* CA-3. Placed under the three figures it contradicts, because a
              reader who takes them as a subtraction is not wrong about
              arithmetic - the panel is wrong about what it is showing. */}
          {dearerAgentCount + uncomparableAgentCount > 0 && (
            <p className="empty-state" id={DELEGATION_FLOOR_ID} data-testid="delegation-floor">
              {dearerAgentCount > 0 && (
                <>
                  <span className="status-error">✕</span> {dearerAgentCount}{' '}
                  {dearerAgentCount === 1 ? 'subagent' : 'subagents'} cost MORE than the top-tier
                  alternative would have. Each subagent&apos;s saving is floored at $0.00 before the
                  sum, so that overspend is nowhere subtracted: &quot;Saved&quot; is a sum of floors
                  and does not equal the difference between the two levels above it.{' '}
                </>
              )}
              {/* The unknown half of the same question, and never folded into
                  the count above it: "cost more" and "could not be told" are
                  different claims, and a reader who is given one number has no
                  way to guess that the other exists. */}
              {uncomparableAgentCount > 0 && (
                <>
                  <span className={NO_FIGURE_META.className} aria-hidden="true">
                    {NO_FIGURE_META.symbol}
                  </span>{' '}
                  {uncomparableAgentCount} of {pricedAgentCount}{' '}
                  {pricedAgentCount === 1 ? 'subagent' : 'subagents'} could not be compared - a
                  figure arrived that is not a number - so whether{' '}
                  {uncomparableAgentCount === 1 ? 'it' : 'they'} cost more than the alternative is
                  unknown. The dearer count covers the other {comparableAgents.length}.
                </>
              )}
            </p>
          )}
        </>
      )}
      {/* Only meaningful alongside an estimate. When EVERY subagent was skipped
          there is no estimate for them to be excluded from, so that case gets
          its own message below instead of this footnote to nothing. */}
      {skippedAgentCount > 0 && hasDelegationEstimate && (
        <p className="empty-state" id={DELEGATION_SKIPPED_ID} data-testid="skipped-agents">
          {/* The gap marker, not the unrecognised-STATUS marker it used to
              borrow: nothing here is in an unknown state, a number could not be
              computed. `aria-hidden` because the sentence that follows says the
              same thing in words - a reader who hears "question mark" learns
              nothing the next clause does not spell out. */}
          <span className={NO_FIGURE_META.className} aria-hidden="true">
            {NO_FIGURE_META.symbol}
          </span>{' '}
          {skippedAgentCount} {skippedAgentCount === 1 ? 'subagent is' : 'subagents are'} excluded
          from this estimate: no top-tier model could be resolved for{' '}
          {skippedAgentCount === 1 ? 'it' : 'them'}, and a guess would be worse than a gap.{' '}
          {/* AMENDED 2026-09-03 (CA-2): the sentence above is unchanged; what
              it left out is how wide the exclusion is. The server skips such a
              subagent in ALL THREE sums, so its real, measured dollars are
              missing from the figure labelled "measured" too - the reader was
              told a modelled number had a hole in it, not that a measured one
              did. */}
          That is {skippedAgentCount} of {delegatingAgentCount} subagents this session delegated to,
          and the exclusion drops {skippedAgentCount === 1 ? 'it' : 'them'} from all three figures
          above - the measured one included - so those real dollars are missing from &quot;Delegated
          work, actual&quot; as well, not just from the estimate.
        </p>
      )}
      {noDelegationRan ? (
        <p className="empty-state" data-testid="no-delegation">
          No subagent ran in this session, so there was nothing to delegate.
        </p>
      ) : allDelegationSkipped ? (
        <p className="empty-state" data-testid="delegation-unpriceable">
          <span className={NO_FIGURE_META.className} aria-hidden="true">
            {NO_FIGURE_META.symbol}
          </span>{' '}
          This session delegated to {skippedAgentCount}{' '}
          {skippedAgentCount === 1 ? 'subagent' : 'subagents'}, but no top-tier model could be
          resolved for {skippedAgentCount === 1 ? 'it' : 'any of them'}, so the saving cannot be
          estimated at all. The figures are withheld rather than shown as $0.00, which would read as
          &quot;delegation saved nothing&quot; - a measurement this session does not support.
        </p>
      ) : (
        <table
          className="data-table"
          aria-label="delegation savings per agent"
          aria-describedby={delegationDescription}
        >
          <thead>
            <tr>
              <th>Agent</th>
              <th>Would have run on</th>
              <th className="num">Actual</th>
              <th className="num">Hypothetical</th>
              <th className="num">Saved</th>
            </tr>
          </thead>
          <tbody>
            {delegationSavings.perAgent.map((agent) => (
              <tr key={agent.agentId}>
                <td>
                  <code>{shortId(agent.agentId)}</code>
                </td>
                <HypotheticalModelCell model={agent.hypotheticalModel} />
                <td className="num">{formatUsd(agent.actualUsd)}</td>
                <td className="num">~ {formatUsd(agent.hypotheticalUsd)}</td>
                <td className="num">~ {formatUsd(agent.savingsUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
