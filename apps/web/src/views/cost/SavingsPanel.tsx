/**
 * The cost view's corpus-wide delegation-savings estimate (M-9, aggregate
 * half). Split out of CostView.tsx in UX-16 (2026-11-19).
 */
import type { AggregateDelegationSavingsDto, AggregateSavingsSkipDto } from '../../dto';
import { formatUsd, quoteRawValue, shortId } from '../../format';
import { NO_FIGURE_META } from '../status';
import { plural, USD_EPSILON } from './shared';

// Same reasoning for the M-9 aggregate: a third endpoint, a third state
// machine, so a failure there costs this view one section and nothing else.
export type SavingsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly aggregate: AggregateDelegationSavingsDto };

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
/**
 * AMENDED 2026-09-23 (lane-P). The fallback named the raw word, and a raw word
 * of `''` names nothing: the cell read `unrecognised reason: ` - a sentence
 * stopped at its colon, in the column whose entire job is to say why a session
 * was excluded. Quoted through the shared `quoteRawValue`, the same convention
 * `status.ts` uses for an unrecognised status word, so `""` reads as the empty
 * string the server sent and `"  "` shows its spaces.
 */
function skipReasonLabel(reason: string): string {
  // Indexed through a widened view on purpose: `Record<Union, string>` types
  // the lookup as `string`, and that assumption is exactly what fails here.
  const known: Readonly<Record<string, string | undefined>> = SKIP_REASON_LABEL;
  return known[reason] ?? `unrecognised reason: ${quoteRawValue(reason)}`;
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
  // RR2 (2026-09-30): the per-session panel's CA-3, on the aggregate. The
  // schema defines `savingsUsd` as a sum of per-subagent floors, so it exceeds
  // `hypotheticalUsd - actualUsd` exactly when some subagent cost more than its
  // top-tier alternative. The payload carries no per-agent rows here, so the
  // overspend is detected from the three served figures rather than counted.
  const flooredOverspend =
    aggregate.savingsUsd - (aggregate.hypotheticalUsd - aggregate.actualUsd) > USD_EPSILON;
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
      {/* Placed under the three figures it qualifies, as CA-3 is: a reader who
          subtracts them is not wrong about arithmetic. */}
      {flooredOverspend && (
        <p className="empty-state" data-testid="aggregate-savings-floor">
          <span className="status-error">✕</span> Some subagents cost more than the top-tier
          alternative would have. Each subagent&apos;s saving is floored at $0.00 before the sum, so
          that overspend is nowhere subtracted: &quot;Saved by delegating&quot; is a sum of floors
          and does not equal the difference between the two levels beside it.
        </p>
      )}
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

/** The "Delegation savings, whole corpus" section, in each state of its read. */
export function SavingsSection({ savings }: { readonly savings: SavingsState }) {
  return (
    <>
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
    </>
  );
}
