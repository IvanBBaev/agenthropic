/**
 * The cost view's headline figures: the all-time totals row with the
 * ingest-coverage banners and the page-wide honesty note under it, and the
 * UTC today / last-7-days windows with the paragraph stating their basis.
 * Split out of CostView.tsx in UX-16 (2026-11-19).
 */
import type { CostSummaryDto } from '../../dto';
import { formatTokens, formatUsd, impossibleCountText, isImpossibleCount } from '../../format';
import { computeCostWindows } from '../cost-windows';
import type { WindowTotals } from '../cost-windows';
import { DroppedUsageNote, MalformedLinesNote, PartialAggregateNote } from '../session-honesty';
import { UnpricedModelsBanner } from '../unpriced';
import { COST_HONESTY_ID, plural, REFRESH_LABEL } from './shared';

/**
 * What joins the unreadable-line note (OPS-14) to the notes before it. The
 * dropped-usage sentence is the only one that ends without a full stop - it is
 * also printed bare beside a session row - so the join supplies it.
 */
function malformedLinesLead(partialSessions: number, usageRecordsDropped: number): string {
  if (usageRecordsDropped !== 0 && !isImpossibleCount(usageRecordsDropped)) return '. ';
  return partialSessions === 0 && usageRecordsDropped === 0 ? '' : ' ';
}

/**
 * A1 (2026-09-23). The unpriced line under a window KPI.
 *
 * Both window tiles gated this clause on `unpricedTokens > 0`, which is the
 * test CV-4 took out of the Total cost tile one row above them - and here it
 * fails for a second reason as well. `computeCostWindows` sums whole `perDay`
 * rows with `+`, so ONE row whose `unpricedTokens` arrived non-finite (shape
 * is all `dto-guards.ts` promises) poisons the window total; the sum is then
 * NaN, `NaN > 0` is silently false, and the tile renders a confident dollar
 * figure with no note - the exact rendering that means "this window is fully
 * priced". The Total cost tile beside it would be saying the opposite about
 * the same corpus.
 *
 * Zero is the silent case, matching `UnpricedCell` above: a negative count is
 * as impossible as a NaN one and is shown rather than swallowed.
 *
 * AMENDED 2026-09-23 (lane-M), and renamed from `UnpricedWindowNote`, because
 * the hole the NaN arm disclosed is now closed one layer down and a wider one
 * took its place. `computeCostWindows` sums figure by figure and skips what it
 * cannot read, so no window total arrives non-finite any more - one bad row can
 * no longer destroy six good days, and `unpricedTokens` can no longer be NaN.
 * What a bad row still does is leave the window covering fewer days than it was
 * handed, which the bucket now reports as `unreadableRows`. So the disclosure
 * did not go away; it moved and widened. It used to say the unpriced count was
 * unreadable; it now says how many of this window's days are missing from EVERY
 * figure on the tile - the dollar value and the token count included, which is
 * where the confident rendering actually did its damage.
 */
function WindowCoverageNote({
  totals,
  testId,
}: {
  readonly totals: WindowTotals;
  readonly testId: string;
}) {
  return (
    <>
      {totals.unreadableRows > 0 && (
        <span className="muted kpi-note" data-testid={testId}>
          {plural(totals.unreadableRows, 'day')} of {String(totals.rows)} in this window could not
          be read - every figure on this tile is a lower bound
        </span>
      )}
      {totals.unpricedTokens > 0 && (
        <span className="kpi-note unpriced">~ {formatTokens(totals.unpricedTokens)} unpriced</span>
      )}
    </>
  );
}

/**
 * W-1 (2026-10-12): the quarantine clause of the ingest-coverage banner. `> 0`
 * kept it silent for NaN and for a negative, printed "Infinity of those will
 * not be retried" for an infinity, and "20 of those" beside an excluded count
 * of 3 - a sentence that cannot be true. Each case is named; a measured zero
 * stays silent because nothing is quarantined. Only reached from the arm that
 * has already established a readable, positive `sessionsExcluded`.
 */
function quarantinedClause(coverage: {
  readonly sessionsExcluded: number;
  readonly sessionsQuarantined: number;
}): string {
  const { sessionsExcluded, sessionsQuarantined } = coverage;
  if (isImpossibleCount(sessionsQuarantined)) {
    return ` How many of those will not be retried came back as ${impossibleCountText(sessionsQuarantined)}.`;
  }
  if (sessionsQuarantined === 0) return '';
  if (sessionsQuarantined > sessionsExcluded) {
    return ` The quarantined count says ${String(sessionsQuarantined)} will not be retried until the corpus or the pricing table changes, which is more than the ${plural(sessionsExcluded, 'session')} excluded - the two served counts disagree.`;
  }
  return ` ${String(sessionsQuarantined)} of those will not be retried until the corpus or the pricing table changes (usually a model with no price row).`;
}

/** The all-time totals row, the coverage banners and the honesty note. */
export function TotalsKpis({
  summary,
  hasCostHonesty,
  costHonestyDescribedBy,
}: {
  readonly summary: CostSummaryDto;
  readonly hasCostHonesty: boolean;
  readonly costHonestyDescribedBy: string | undefined;
}) {
  // No tokens at all - priced or not - means nothing was ever recorded. That
  // is a different fact from "usage exists but none of it is priced", and the
  // copy must not let a $0.00 headline be read as the second.
  const nothingRecorded = summary.totals.tokens === 0 && summary.totals.unpricedTokens === 0;
  return (
    <>
      {/* `role="group"`: a plain div exposes neither its label nor its
          description, so the honesty note it names would reach nobody. */}
      <div
        className="kpis"
        role="group"
        aria-label="totals"
        aria-describedby={costHonestyDescribedBy}
      >
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
      {/* WEB-4 (2026-10-10): `> 0` is false of NaN and of a negative exactly as
          it is of a measured zero, so an unreadable excluded count rendered the
          page as if every session had ingested - the hole the unpriced KPI
          closed in CV-3, in the banner next to it. Unreadable is its own case,
          and it still ends on the lower-bound conclusion. */}
      {summary.coverage !== undefined && isImpossibleCount(summary.coverage.sessionsExcluded) && (
        <p className="truncation-banner" data-testid="coverage-banner">
          {`The excluded-session count came back as ${impossibleCountText(summary.coverage.sessionsExcluded)}, so how many sessions the latest pass left out is unknown - these totals are a lower bound, not a complete one.`}
        </p>
      )}
      {/* W-1 (2026-10-12): the two arms were independent conditions, and an
          infinity satisfies both - the page named the count unreadable and
          then said "Infinity sessions could not be ingested" in a second
          banner under the same test id. This arm is the complement of the
          one above, so exactly one of them can render. */}
      {summary.coverage !== undefined &&
        !isImpossibleCount(summary.coverage.sessionsExcluded) &&
        summary.coverage.sessionsExcluded > 0 && (
          <p className="truncation-banner" data-testid="coverage-banner">
            {`${plural(summary.coverage.sessionsExcluded, 'session')} could not be ingested on the latest pass, so ${
              summary.coverage.sessionsExcluded === 1 ? 'its' : 'their'
            } spend is incomplete or absent in every figure on this page - these totals are a lower bound, not a complete one.`}
            {quarantinedClause(summary.coverage)}
          </p>
        )}
      {/* R2 (2026-11-08): which models the unpriced KPI is about. Ingest stores
          a session whose model has no price row instead of refusing it, so
          this is where that gap surfaces. */}
      <UnpricedModelsBanner perModel={summary.perModel} />
      {/* Owner decisions 1 and 2: every total on this page is a lower bound
          while any session is partial, and excludes usage records that had no
          dedupe key; OPS-14 adds the transcript lines ingest could not read.
          Corpus-wide, not per slice, so it sits with the totals rather than
          under any one breakdown, and the groups, tables and diagram below
          name it by id. See views/session-honesty.tsx. */}
      {hasCostHonesty && (
        <p className="muted" id={COST_HONESTY_ID} data-testid="cost-honesty">
          <PartialAggregateNote count={summary.partialSessions} />
          <DroppedUsageNote
            count={summary.usageRecordsDropped}
            lead={summary.partialSessions === 0 ? '' : ' '}
          />
          <MalformedLinesNote
            sessions={summary.sessionsWithMalformedLines}
            lines={summary.malformedLinesSkipped}
            lead={malformedLinesLead(summary.partialSessions, summary.usageRecordsDropped)}
          />
        </p>
      )}
    </>
  );
}

/** The UTC today / last-7-days tiles and the paragraph stating their basis. */
export function WindowKpis({
  summary,
  observedAtMs,
  nowMs,
  costHonestyDescribedBy,
}: {
  readonly summary: CostSummaryDto;
  readonly observedAtMs: number;
  readonly nowMs: number;
  readonly costHonestyDescribedBy: string | undefined;
}) {
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
  const windows = computeCostWindows(summary.perDay, nowMs, observedAtMs);
  // Only meaningful together with `!todayObserved`: an empty bucket the
  // snapshot could not have filled is a structural zero, a non-empty one is a
  // real (if incomplete) figure. Both count, because "0 tokens, $0.00" and
  // "0 tokens, some unpriced" are different states everywhere else on this page.
  // AMENDED 2026-09-23 (lane-M): a third operand, because the first two ask
  // only what the window MEASURED and the tile below claims something stronger
  // - that nothing was dated today at all. A row dated today whose figures were
  // unreadable sums to zero on both counts, so the old test called it empty and
  // the page answered "no usage was dated today", about a row it was holding.
  // Unmeasured is not absent, and only the third clause can tell them apart.
  const todayEmpty =
    windows.today.tokens === 0 &&
    windows.today.unpricedTokens === 0 &&
    windows.today.unreadableRows === 0;
  // RR2 (2026-09-30): the week tile's twin of the pair above. The read predates
  // the window's FIRST day, so every day in it is unread; an empty bucket is
  // then a structural zero, exactly as `todayEmpty` is for the today tile.
  const weekUnread = windows.observedUtc < windows.weekStartUtc;
  const weekEmpty =
    windows.last7Days.tokens === 0 &&
    windows.last7Days.unpricedTokens === 0 &&
    windows.last7Days.unreadableRows === 0;
  return (
    <>
      <div
        className="kpis"
        role="group"
        aria-label="recent windows"
        aria-describedby={costHonestyDescribedBy}
      >
        <div className="kpi" data-testid="kpi-today">
          <span className="kpi-label">Today (UTC)</span>
          {windows.todayObserved ? (
            <>
              <span className="kpi-value">{formatUsd(windows.today.costUsd)}</span>
              <span className="muted kpi-note">
                {windows.todayUtc} · {formatTokens(windows.today.tokens)} tokens
              </span>
              <WindowCoverageNote totals={windows.today} testId="kpi-today-coverage" />
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
                {windows.observedUtc} - use {REFRESH_LABEL} to measure it
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
              {/* A1 (2026-09-23): this arm printed cost and tokens with no
                  unpriced line at all, so a window that is BOTH stale and
                  partly unpriced disclosed only the staleness. The partial
                  note above is about time; this one is about coverage, and a
                  reader told about one gap reasonably assumes there is no
                  other. */}
              <WindowCoverageNote totals={windows.today} testId="kpi-today-partial-coverage" />
            </>
          )}
        </div>
        <div className="kpi" data-testid="kpi-week">
          <span className="kpi-label">Last 7 days (UTC)</span>
          {weekUnread && weekEmpty ? (
            // RR2 (2026-09-30): the premise of the arm below - "six measured
            // days" - is gone once the read is older than the window itself.
            // Same refusal, same wording, as the today tile's structural zero.
            <>
              <span className="kpi-value unpriced" data-testid="kpi-week-unread">
                not measured
              </span>
              <span className="muted kpi-note">
                {windows.weekStartUtc} → {windows.todayUtc} · no usage was dated in this window when
                this page was read on {windows.observedUtc} - use {REFRESH_LABEL} to measure it
              </span>
            </>
          ) : (
            <>
              <span className="kpi-value">{formatUsd(windows.last7Days.costUsd)}</span>
              <span className="muted kpi-note">
                {windows.weekStartUtc} → {windows.todayUtc} ·{' '}
                {formatTokens(windows.last7Days.tokens)} tokens
              </span>
              <WindowCoverageNote totals={windows.last7Days} testId="kpi-week-coverage" />
              {/*
                Weaker than the today tile on purpose. While the read falls
                inside the window, the window still holds measured days, so the
                figure is a real lower bound rather than an artefact - it is
                only the tail of the range that is unread. Blanking it would
                hide more truth than it protects.
                AMENDED 2026-09-30 (RR2): that premise holds only while the read
                falls inside the window. Once it does not, an empty bucket takes
                the arm above; a non-empty one (rows a fast writer clock dated
                ahead of the read) keeps its real figure and this note.
              */}
              {!windows.todayObserved && (
                <span className="kpi-note unpriced" data-testid="kpi-week-partial">
                  read on {windows.observedUtc} · a lower bound, the rest of this window is unread
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <p className="muted windows-note" data-testid="windows-basis">
        Windows are UTC calendar days over the recorded usage timestamps - not your local timezone.{' '}
        {/* A1 (2026-09-23): was `windows.unknownDay.tokens > 0 && ...`. The
            bucket is a SUM over `perDay`, so a single undated row with a
            non-finite token count makes the whole bucket NaN, the test false
            and this sentence absent - and its absence is the page's way of
            saying every recorded token fell inside a window.

            AMENDED 2026-09-23 (lane-M): the NaN arm is gone because the bucket
            can no longer BE NaN - the sums skip the figures they cannot read
            and count the rows instead. The test moved from the token sum to
            `rows`, which is the honest trigger: a bucket holding rows whose
            tokens were all unreadable sums to zero, and zero tokens was still
            being read here as "no undated usage exists". The row count knows
            the rows are there; the token sum only knows it could not add them.
            `unreadableRows` then qualifies the number instead of replacing the
            sentence, so the reader is told the same fact and how much of it
            is missing. */}
        {windows.unknownDay.rows > 0
          ? `${formatTokens(windows.unknownDay.tokens)} tokens carry no timestamp and sit outside every window (listed as "unknown" below).${
              windows.unknownDay.unreadableRows > 0
                ? ` ${plural(windows.unknownDay.unreadableRows, 'row')} of those could not be read, so that count is a lower bound.`
                : ''
            }`
          : ''}{' '}
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
        {/* A1 (2026-09-23): same withdrawal as the clause above, on the
            disclosure CA-5 exists to make. Silence here asserts that every
            recorded row is dated no later than today.

            AMENDED 2026-09-23 (lane-M): same move as the clause above - the
            trigger is the row count, the NaN arm is gone, and `unreadableRows`
            qualifies the figure. This sentence had a second bug besides: it
            fired on any day string that merely SORTED above today, so an
            August date written `2026-8-5` had the page reporting a disagreement
            about the calendar on the evidence of a ten-day-old row. Days that
            do not read as dates are now routed to their own bucket (below) and
            never reach this claim. */}
        {windows.futureDated.rows > 0
          ? `${formatUsd(windows.futureDated.costUsd)} across ${formatTokens(windows.futureDated.tokens)} tokens is dated after ${windows.todayUtc} - later than this machine's clock - and is in neither window: the corpus and this browser disagree about what day it is.${
              windows.futureDated.unreadableRows > 0
                ? ` ${plural(windows.futureDated.unreadableRows, 'row')} of those could not be read, so that figure is a lower bound.`
                : ''
            }`
          : ''}{' '}
        {/*
          M1 (2026-09-23, lane-M). The bucket that had no sentence because it
          had no bucket. A `day` the server did not write as a UTC date - empty,
          unpadded, shaped like a date but naming no day - used to be ordered
          against the window boundaries as a string anyway, and fell wherever
          the comparison dropped it: out of all four totals if it sorted low,
          into the clock-skew sentence above if it sorted high. Neither outcome
          was visible to the reader, which is the whole defect - four totals
          that looked like a partition of the corpus, silently covering less
          than it. The rows now have somewhere to be, and this is where the
          page says so.
        */}
        {windows.unreadableDay.rows > 0
          ? `${plural(windows.unreadableDay.rows, 'row')} ${
              windows.unreadableDay.rows === 1 ? 'carries' : 'carry'
            } a date this page cannot read - neither "unknown" nor a UTC calendar day - so ${formatUsd(windows.unreadableDay.costUsd)} across ${formatTokens(windows.unreadableDay.tokens)} tokens sits in no window at all.`
          : ''}
      </p>
    </>
  );
}
