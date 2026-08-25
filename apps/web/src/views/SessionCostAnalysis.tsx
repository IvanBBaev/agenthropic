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
 */
import { useEffect, useState } from 'react';
import { fetchCostAnalysis } from '../api';
import type { CostAnalysisDto } from '../dto';
import { formatUsd, shortId } from '../format';

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
 * because each now has more than one: a 503 is either "no provider wired" or
 * "no corpus root on this machine", and a 422 is either an unparseable
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

/** A signed dollar delta, so an over- and an under-count never look alike. */
function signedUsd(deltaUsd: number): string {
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
  }, [token, sessionId, onAuthRejected]);

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
        <span className="status-error">✕</span> {state.message}
      </p>
    );
  }

  const { compaction, delegationSavings } = state.analysis;

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

  return (
    <div data-testid="session-analysis">
      <h3>Compaction repricing</h3>
      {compaction.compactionCount === 0 ? (
        <p className="empty-state" data-testid="no-compaction">
          This session was never compacted, so there is nothing to reprice.
        </p>
      ) : (
        <>
          <div className="kpis" aria-label="compaction repricing">
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
          {Math.abs(compaction.deltaUsd) >= DELTA_SIGNAL_USD && (
            <p className="empty-state" data-testid="delta-signal">
              <span className="status-error">✕</span> These two should agree. A difference this size
              means the substrate or the pricing is incomplete - it is a mispricing signal, not a
              saving.
            </p>
          )}
          <table className="data-table" aria-label="compaction segments">
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
                  <td className="num">{segment.messageCount.toLocaleString('en-US')}</td>
                  <td className="num">{segmentTokens(segment.tokens).toLocaleString('en-US')}</td>
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
      <p className="muted">
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
          <p className="muted" data-testid="delegation-scope">
            Both levels below cover the delegated turns only. The main agent&apos;s own spend is in
            neither, because it is the same with or without delegation - which is why it cancels out
            and leaves the saving unaffected.
          </p>
          <div className="kpis" aria-label="delegation savings">
            <div className="kpi">
              <span className="kpi-label">Delegated work, actual</span>
              <span className="kpi-value">{formatUsd(delegationSavings.actualUsd)}</span>
              <span className="muted kpi-note">measured, subagents only</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Same work, no delegation</span>
              <span className="kpi-value">~ {formatUsd(delegationSavings.hypotheticalUsd)}</span>
              <span className="muted kpi-note">estimated, subagents only</span>
            </div>
            <div className="kpi" data-testid="savings-kpi">
              <span className="kpi-label">Saved</span>
              <span className="kpi-value">~ {formatUsd(delegationSavings.savingsUsd)}</span>
              <span className="muted kpi-note">estimated</span>
            </div>
          </div>
        </>
      )}
      {/* Only meaningful alongside an estimate. When EVERY subagent was skipped
          there is no estimate for them to be excluded from, so that case gets
          its own message below instead of this footnote to nothing. */}
      {skippedAgentCount > 0 && hasDelegationEstimate && (
        <p className="empty-state" data-testid="skipped-agents">
          <span className="status-unknown">?</span> {skippedAgentCount}{' '}
          {skippedAgentCount === 1 ? 'subagent is' : 'subagents are'} excluded from this estimate:
          no top-tier model could be resolved for {skippedAgentCount === 1 ? 'it' : 'them'}, and a
          guess would be worse than a gap.
        </p>
      )}
      {noDelegationRan ? (
        <p className="empty-state" data-testid="no-delegation">
          No subagent ran in this session, so there was nothing to delegate.
        </p>
      ) : allDelegationSkipped ? (
        <p className="empty-state" data-testid="delegation-unpriceable">
          <span className="status-unknown">?</span> This session delegated to {skippedAgentCount}{' '}
          {skippedAgentCount === 1 ? 'subagent' : 'subagents'}, but no top-tier model could be
          resolved for {skippedAgentCount === 1 ? 'it' : 'any of them'}, so the saving cannot be
          estimated at all. The figures are withheld rather than shown as $0.00, which would read as
          &quot;delegation saved nothing&quot; - a measurement this session does not support.
        </p>
      ) : (
        <table className="data-table" aria-label="delegation savings per agent">
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
                <td>
                  <code>{agent.hypotheticalModel}</code>
                </td>
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
