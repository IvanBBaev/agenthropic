/**
 * Recent-window aggregation over the served `perDay` rows (review item M-9).
 *
 * The server buckets usage as `substr(occurred_at, 1, 10)` where `occurred_at`
 * is the ISO-8601 UTC timestamp of the JSONL line - so a "day" here is a UTC
 * calendar date, full stop. The browser's local timezone plays NO part, and
 * the UI copy must say so: a KPI silently labelled "today" that means UTC-today
 * to the server and local-today to the reader is a quiet lie about boundaries.
 *
 * Definitions (explicit, because M-9 forbids a silent timezone assumption):
 *   - "today"       = the UTC calendar date containing `nowMs`;
 *   - "last 7 days" = the 7 UTC calendar dates ending with today, inclusive
 *     (todayUtc - 6 days .. todayUtc);
 *   - rows dated AFTER todayUtc are excluded from both windows. A future date
 *     is reachable when the machine that wrote the transcript and the machine
 *     viewing it disagree on the clock, and folding it into "last 7 days"
 *     would inflate a window it is not in. AMENDED 2026-09-03 (CA-5): that
 *     spend is now summed into `futureDated` rather than falling out of the
 *     result entirely. The exclusion was right; being unable to SAY it happened
 *     was not. A row dated after today is evidence that the writer's clock and
 *     the reader's disagree, which is precisely the assumption a tile labelled
 *     "today" rests on - so the caller must be able to put it on screen;
 *   - rows with day 'unknown' (no timestamp on any line) sit outside every
 *     window and are returned separately so the view can disclose them.
 *
 * Day strings are compared lexicographically: for the fixed `YYYY-MM-DD`
 * format that IS chronological order, so no Date parsing (and no timezone
 * re-interpretation) happens here.
 *
 * WHAT THE WINDOWS CANNOT SEE (F-1). The rows are a snapshot, taken when the
 * summary was fetched; the windows are cut against a clock that keeps ticking
 * afterwards. Those are two different times. Once the clock crosses UTC
 * midnight, `todayUtc` names a date that NO row in the snapshot can carry, and
 * the sum over it is zero for a reason that has nothing to do with spending:
 * the window moved past the data. A zero produced that way is indistinguishable
 * - inside `perDay` - from a genuinely idle day, because both are the empty
 * set. So the discriminator cannot come from the rows; it has to come from
 * WHEN they were read. `observedAtMs` carries that, and `todayObserved` is
 * false exactly when the today window has moved past everything the snapshot
 * could cover. Callers must render the difference: a structural zero printed
 * as a measured $0.00 is precisely the class of claim this project exists not
 * to make.
 */
import type { DailyCostDto } from '../dto';

/** One window's summed usage - same three-field shape as the server totals. */
export interface WindowTotals {
  readonly tokens: number;
  readonly costUsd: number;
  readonly unpricedTokens: number;
}

export interface CostWindows {
  /** The UTC calendar date of `nowMs`, as `YYYY-MM-DD`. */
  readonly todayUtc: string;
  /** First day of the 7-day window (todayUtc - 6 days), as `YYYY-MM-DD`. */
  readonly weekStartUtc: string;
  /** The UTC calendar date on which `perDay` was read, as `YYYY-MM-DD`. */
  readonly observedUtc: string;
  /**
   * True when the snapshot was read on the day the window names.
   *
   * Read it as exactly that and nothing more. It is NOT "no row is dated
   * today": a writer whose clock runs ahead of the viewer's puts future-dated
   * rows in the snapshot (the same skew the exclusion rule above exists for),
   * so a false flag can still sit over a non-empty `today` bucket. What false
   * does guarantee is that nothing recorded after the read is in there - so
   * `today` is a lower bound, and an EMPTY `today` under a false flag is a
   * structural zero rather than a measured one. Those two cases want different
   * copy, and the caller owes the reader both.
   *
   * True says nothing about ordinary staleness WITHIN the day: a snapshot read
   * this morning still covers today, incompletely, which is an understatement
   * rather than a fiction.
   */
  readonly todayObserved: boolean;
  readonly today: WindowTotals;
  readonly last7Days: WindowTotals;
  /** Usage with no timestamp at all - outside every window, never hidden. */
  readonly unknownDay: WindowTotals;
  /**
   * Usage dated after `todayUtc` - outside every window, and never hidden
   * either. Non-zero here means the corpus carries dates the viewer's clock
   * says have not happened, so "today" and "last 7 days" are cut against a
   * calendar the data does not share.
   */
  readonly futureDated: WindowTotals;
}

const DAY_MS = 86_400_000;

/** The number of UTC days in the "recent" window, today inclusive. PROVISIONAL. */
export const WEEK_WINDOW_DAYS = 7;

const ZERO: WindowTotals = { tokens: 0, costUsd: 0, unpricedTokens: 0 };

/** `toISOString` is UTC by definition, so this is the server's day basis. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function add(totals: WindowTotals, row: DailyCostDto): WindowTotals {
  return {
    tokens: totals.tokens + row.tokens,
    costUsd: totals.costUsd + row.costUsd,
    unpricedTokens: totals.unpricedTokens + row.unpricedTokens,
  };
}

export function computeCostWindows(
  perDay: readonly DailyCostDto[],
  nowMs: number,
  observedAtMs: number,
): CostWindows {
  const todayUtc = utcDay(nowMs);
  const weekStartUtc = utcDay(nowMs - (WEEK_WINDOW_DAYS - 1) * DAY_MS);
  const observedUtc = utcDay(observedAtMs);
  let today = ZERO;
  let last7Days = ZERO;
  let unknownDay = ZERO;
  let futureDated = ZERO;
  for (const row of perDay) {
    // 'unknown' must be routed before any comparison: lexicographically it
    // sorts after every date ('u' > '9'), so a comparison would misfile it.
    if (row.day === 'unknown') {
      unknownDay = add(unknownDay, row);
      continue;
    }
    // Routed before the window tests for the same reason: a date that has not
    // arrived belongs to no window, and dropping it silently would leave the
    // view unable to disclose the clock disagreement that produced it.
    if (row.day > todayUtc) {
      futureDated = add(futureDated, row);
      continue;
    }
    if (row.day === todayUtc) today = add(today, row);
    if (row.day >= weekStartUtc && row.day <= todayUtc) last7Days = add(last7Days, row);
  }
  return {
    todayUtc,
    weekStartUtc,
    observedUtc,
    // `>=`, not `===`: a snapshot stamped after today still covers today. That
    // needs the two readings to disagree, which they should not - but if they
    // ever do, the safe direction is to keep quiet rather than announce a gap
    // that is not there. A warning that fires when nothing is wrong is spent
    // credibility, and it is spent on the day it is finally right.
    todayObserved: observedUtc >= todayUtc,
    today,
    last7Days,
    unknownDay,
    futureDated,
  };
}
