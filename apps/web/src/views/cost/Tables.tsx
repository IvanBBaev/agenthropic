/**
 * The cost view's breakdown tables: per model, per day and top sessions.
 * Split out of CostView.tsx in UX-16 (2026-11-19).
 */
import type { CostSummaryDto } from '../../dto';
import {
  formatTokens,
  formatUsd,
  hasVisibleText,
  nameOrBlank,
  projectLabel,
  shortId,
} from '../../format';
import { isReadableDay } from '../cost-windows';
import { DroppedUsageNote, PartialBadge } from '../session-honesty';
import { NO_FIGURE_META } from '../status';
import { plural, UnpricedCell, USD_EPSILON } from './shared';

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
 * L-O1 (2026-09-23). How this view NAMES a served day it could not read.
 *
 * The quotes are load-bearing, and they are the reason this is one string
 * rather than two arms. `day` is `Type.String()` on the wire and the client
 * guards check strings for being strings, so the value that arrives can be
 * `''` - and an empty raw value interpolated bare produces `unreadable day ()`,
 * a sentence whose subject has gone missing in the very cell that is supposed
 * to say what the server sent. Quoted, `""` reads as the empty string it is,
 * `"  "` shows its spaces, and `"2026-8-5"` is reproduced exactly so a reader
 * who goes to ask the server can quote it back. Nothing is paraphrased, which
 * is what keeps this honest about a value we are admitting we cannot read.
 */
function unreadableDayLabel(day: string): string {
  return `unreadable day ("${day}")`;
}

/**
 * The day as this view is willing to print it, for the places that name a day
 * inside prose rather than in its own cell.
 *
 * 'unknown' passes through untouched on purpose. It is a value the SERVER
 * chose - "these usage rows carry no timestamp" - and it is as readable as any
 * date: the page knows exactly what it means and says so elsewhere. A day that
 * does not round-trip as a UTC calendar date is the other fact entirely, that
 * the `day` column is not what the contract describes, and only that one is
 * marked. See the same split in cost-windows.ts, where `unknownDay` and
 * `unreadableDay` are deliberately two buckets.
 */
function dayLabel(day: string): string {
  return day === 'unknown' || isReadableDay(day) ? day : unreadableDayLabel(day);
}

/**
 * The day column's cell (L-O1).
 *
 * Lane M's `windows-basis` paragraph already discloses the AGGREGATE - "N rows
 * carry a date this page cannot read" - so the fact was on the page. What was
 * not on the page was WHICH rows: a `day` of `''` rendered an empty cell
 * beside real tokens and real dollars and said nothing, and `'2026-8-5'`
 * rendered exactly like a date the windows could place. A count in one
 * paragraph cannot be matched to a row in a table by a reader scanning it, and
 * a qualification that is not next to the claim it qualifies has not reached
 * the person making a decision on that row.
 *
 * The marker is the shared gap vocabulary (`NO_FIGURE_META`), not a new glyph:
 * the shell legend is generated from what `status.ts` exports, and this file's
 * rule is that nothing may paint a symbol the legend has not explained. The
 * glyph is `aria-hidden` and carries no meaning of its own - the words beside
 * it do - so a screen-reader user and a sighted one are told the same thing.
 */
function DayCell({ day }: { readonly day: string }) {
  if (day === 'unknown' || isReadableDay(day)) {
    // The muted class stays on 'unknown' alone. It is the one day string that
    // is legitimately not a date, and it has read that way since WP-U9.
    return <td className={day === 'unknown' ? 'muted' : undefined}>{day}</td>;
  }
  return (
    <td data-testid="perday-unreadable-day">
      <span className={NO_FIGURE_META.className} aria-hidden="true">
        {NO_FIGURE_META.symbol}
      </span>{' '}
      {unreadableDayLabel(day)}
    </td>
  );
}

/**
 * The model column's cell (2026-09-23, lane-P) - the model-axis sibling of
 * `DayCell` above, for the same reason and with the same marker.
 *
 * `perModel[].model` is `Type.String()` on the wire and `dto-guards.ts` checks
 * containers and load-bearing numbers and deliberately NOT strings, so a row
 * naming no model is contract-valid. It rendered as an empty cell beside real
 * tokens and a real dollar figure: money attributed to nothing, in the table
 * whose rows ARE the attribution. A reader cannot tell that from a column this
 * page failed to paint.
 *
 * The marker is the shared gap vocabulary (`NO_FIGURE_META`), never a new
 * glyph - the shell legend is generated from what `status.ts` exports, and
 * nothing here may paint a symbol the legend has not explained. The glyph is
 * `aria-hidden` and carries no meaning of its own; the words beside it do.
 */
function ModelCell({ model }: { readonly model: string }) {
  if (hasVisibleText(model)) return <td>{model}</td>;
  return (
    <td data-testid="permodel-blank-name">
      <span className={NO_FIGURE_META.className} aria-hidden="true">
        {NO_FIGURE_META.symbol}
      </span>{' '}
      {nameOrBlank(model, 'model name')}
    </td>
  );
}

/** The "Per model" section. */
export function PerModelTable({
  summary,
  costHonestyDescribedBy,
}: {
  readonly summary: CostSummaryDto;
  readonly costHonestyDescribedBy: string | undefined;
}) {
  return (
    <>
      <h2>Per model</h2>
      {summary.perModel.length === 0 ? (
        <p className="empty-state">No per-model usage recorded yet.</p>
      ) : (
        <table
          className="data-table"
          aria-label="cost per model"
          aria-describedby={costHonestyDescribedBy}
        >
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
                <ModelCell model={model.model} />
                <td className="num">{formatTokens(model.tokens)}</td>
                <td className="num">{formatUsd(model.costUsd)}</td>
                <UnpricedCell tokens={model.unpricedTokens} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** The "Per day" section, with its notice for days no bar can express. */
export function PerDayTable({
  summary,
  costHonestyDescribedBy,
}: {
  readonly summary: CostSummaryDto;
  readonly costHonestyDescribedBy: string | undefined;
}) {
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
  return (
    <>
      <h2>Per day</h2>
      {undrawableDays.length > 0 && (
        <p className="truncation-banner" data-testid="perday-undrawable">
          Not drawable as a bar:{' '}
          {/* L-O1: through `dayLabel`, because this notice exists to NAME the
              days it could not draw and a row carrying `day: ''` had it
              printing "Not drawable as a bar:  (cost unreadable)" - the naming
              sentence naming nothing. A readable day and 'unknown' are
              unchanged. */}
          {undrawableDays
            .map((day) => `${dayLabel(day.day)} (${formatUsd(day.costUsd)})`)
            .join(', ')}
          . The bar column is scaled from the drawable days only, so a missing bar there means the
          cost could not be expressed - not that the day was quiet.
        </p>
      )}
      {summary.perDay.length === 0 ? (
        <p className="empty-state">No daily usage recorded yet.</p>
      ) : (
        <table
          className="data-table"
          aria-label="cost per day"
          aria-describedby={costHonestyDescribedBy}
        >
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
                // `key` stays the served day. Duplicate days would make a
                // duplicate key, but `perDay` is built server-side by
                // accumulating into a `Map` keyed by day (api/queries.ts) and
                // emitted with one entry per key, so two rows cannot carry the
                // same day. Keying by index instead would trade a condition
                // the producer rules out for one that reorders badly on every
                // refetch.
                <tr key={day.day}>
                  <DayCell day={day.day} />
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
    </>
  );
}

/**
 * The "Top sessions" section: the scope sentence and the table, whose session
 * ids pick the session the analysis below reprices.
 */
export function TopSessionsTable({
  summary,
  costHonestyDescribedBy,
  analysedSessionId,
  onAnalyse,
}: {
  readonly summary: CostSummaryDto;
  readonly costHonestyDescribedBy: string | undefined;
  readonly analysedSessionId: string | null;
  readonly onAnalyse: (sessionId: string) => void;
}) {
  // CV-5: what the top-sessions table covers, in dollars, and what it does
  // not. Both are arithmetic on the served payload - no second endpoint is
  // consulted, so neither figure can be fresher or staler than the rows.
  // WEB-6 (2026-10-10): a row whose cost is not a finite number used to poison
  // the reduce - the sentence then read "The rows account for cost unreadable
  // of the $10.00 all-time total", and the remainder clause, which the same NaN
  // silenced, vanished with it. Such rows are counted and named; the readable
  // rows are summed; and no remainder is claimed over a sum that is not whole.
  const unreadableCostRows = summary.topSessions.filter(
    (session) => !Number.isFinite(session.costUsd),
  ).length;
  const shownSessionsUsd = summary.topSessions.reduce(
    (sum, session) => (Number.isFinite(session.costUsd) ? sum + session.costUsd : sum),
    0,
  );
  const outsideTopSessionsUsd = summary.totals.costUsd - shownSessionsUsd;
  // CV-5 amendment (2026-09-09): the two counts the scope sentence needs. The
  // first is the size of the SLICE (the rows on screen), the second the size of
  // the part of the corpus that never reached it - `sessionCount` is the
  // population, so the subtraction is the only place either number is derived.
  const listedSessionCount = summary.topSessions.length;
  const unlistedSessionCount = summary.sessionCount - listedSessionCount;
  // CV-5 second pass (2026-09-09): whether the totals themselves report any
  // usage. `sessionCount === 0` says no session in the corpus carries any, so
  // a non-zero here is the payload disagreeing with itself - the same
  // impossible-from-a-consistent-server case the remainder sentence below
  // already handles, at the other end of the same table.
  const totalsReportUsage =
    summary.totals.tokens > 0 ||
    summary.totals.unpricedTokens > 0 ||
    summary.totals.costUsd > USD_EPSILON;
  return (
    <>
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

        AMENDED 2026-09-09 (L1/L2, CV-5). The hedge above was the right call
        for the payload it was written against - `topSessions` arrived with no
        population beside it, so "a slice unless the corpus holds exactly that
        many" was the strongest true sentence available, and asserting a count
        would have meant inventing one. What removed its reason is not a better
        turn of phrase but a new field: `sessionCount`, the POPULATION the
        slice was cut from, not the length of the slice. With it the scope is a
        statement - either the table is whole ("all 3 sessions") or it is a
        named fraction of a named total ("the 5 costliest of 51"). The
        `>= COST_TOP_N` gate went with the hedge: it only ever asked "is this
        table full?", which was a proxy for "might it be truncated?", and the
        proxy is obsolete now that the payload answers the question directly. A
        3-row table out of 3 sessions has a scope worth stating as much as a
        5-row table out of 51 does.

        The remainder sentence keeps its own gate on the DOLLARS, because
        dollars are what it claims. `hasMore` decides how those dollars are
        ATTRIBUTED, and the two are separate facts. With `hasMore` true the
        remainder belongs to the unlisted sessions and the sentence can now
        count them. With `hasMore` false and a remainder above USD_EPSILON the
        payload contradicts itself: the server accumulates `totals` and the
        per-session buckets in a single row loop (queries.ts), so every priced
        dollar lands in exactly one bucket and a table holding every bucket
        cannot come up short. Attributing that money to unlisted sessions would
        print a sentence this same payload denies, so the view states the
        discrepancy instead and names it as unaccounted for. A gap that is
        detected and then swallowed is the exact defect class this project
        exists to refuse.

        The empty state is split for the same reason. "No sessions recorded
        yet." is true only of an empty corpus; with `sessionCount > 0` and an
        empty slice it asserted an empty database while the payload was
        reporting sessions this view was simply not served.

        AMENDED 2026-09-09 (CV-5, second pass). That split left one arm still
        claiming more than it knew. With `sessionCount === 0` the sentence
        "No sessions recorded yet." was reached whatever the totals said, so a
        payload reporting tokens or dollars beside a session count of nought
        printed a denial of the very usage the KPIs above it were rendering -
        the reader's two halves of one screen contradicting each other with
        nothing on the page admitting it. This is the same self-contradicting
        payload the remainder sentence handles at the other end of the table,
        and it gets the same treatment: state the disagreement, name both
        served figures, attribute nothing. The scope paragraph stays gated on
        `sessionCount > 0` because it counts sessions and there are none to
        count; the contradiction is a fact about the totals, so it is told
        where the totals are denied.
      */}
      {summary.sessionCount > 0 && (
        <p className="muted" data-testid="top-sessions-scope">
          {listedSessionCount === 0
            ? `None of the ${plural(summary.sessionCount, 'session')} with recorded usage reached this table.`
            : summary.hasMore
              ? `The ${String(listedSessionCount)} costliest of ${plural(summary.sessionCount, 'session')} with recorded usage.`
              : `Every session with recorded usage is listed here - all ${plural(summary.sessionCount, 'session')}.`}
          {/* W-4 (2026-10-12): "1 of the 1 rows carries" inflected the verb and
              not the noun, and when every row was unreadable "the readable rows
              account for $0.00" summed a set with nothing in it. The all-
              unreadable case is its own sentence; the partial case always has
              two or more rows, so "rows" is right there. */}
          {unreadableCostRows > 0 && unreadableCostRows === listedSessionCount
            ? ` ${
                listedSessionCount === 1
                  ? 'The only row carries'
                  : `All ${String(listedSessionCount)} rows carry`
              } an unreadable cost, so none of the ${formatUsd(summary.totals.costUsd)} all-time total can be placed.`
            : unreadableCostRows > 0
              ? ` ${String(unreadableCostRows)} of the ${String(listedSessionCount)} rows ${
                  unreadableCostRows === 1 ? 'carries' : 'carry'
                } an unreadable cost, so the readable rows account for ${formatUsd(shownSessionsUsd)} of the ${formatUsd(summary.totals.costUsd)} all-time total and where the rest of it went cannot be said.`
              : ` The rows account for ${formatUsd(shownSessionsUsd)} of the ${formatUsd(summary.totals.costUsd)} all-time total.`}
          {unreadableCostRows === 0 &&
            outsideTopSessionsUsd > USD_EPSILON &&
            (summary.hasMore
              ? ` The other ${formatUsd(outsideTopSessionsUsd)} was spent in the ${plural(unlistedSessionCount, 'session')} this table does not list.`
              : ` The remaining ${formatUsd(outsideTopSessionsUsd)} is unaccounted for: this payload lists every session with recorded usage, so there is no unlisted session to attribute it to - the served total and the served rows disagree.`)}
        </p>
      )}
      {listedSessionCount === 0 ? (
        <p className="empty-state" data-testid="top-sessions-empty">
          {summary.sessionCount > 0
            ? 'No session rows were served for this table.'
            : totalsReportUsage
              ? `No session carries recorded usage, yet the totals above report ${formatTokens(summary.totals.tokens)} tokens and ${formatUsd(summary.totals.costUsd)}: the served totals and the served session count disagree.`
              : 'No sessions recorded yet.'}
        </p>
      ) : (
        <table
          className="data-table"
          aria-label="top sessions by cost"
          aria-describedby={costHonestyDescribedBy}
        >
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
                      onAnalyse(session.sessionId);
                    }}
                  >
                    <code>{shortId(session.sessionId)}</code>
                  </button>
                  <PartialBadge partial={session.partial} lead=" " />
                  <DroppedUsageNote count={session.usageRecordsDropped} lead=" " />
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
    </>
  );
}
