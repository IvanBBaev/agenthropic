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
 *     would inflate a window it is not in;
 *   - rows with day 'unknown' (no timestamp on any line) sit outside every
 *     window and are returned separately so the view can disclose them.
 *
 * Day strings are compared lexicographically: for the fixed `YYYY-MM-DD`
 * format that IS chronological order, so no Date parsing (and no timezone
 * re-interpretation) happens here.
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
  readonly today: WindowTotals;
  readonly last7Days: WindowTotals;
  /** Usage with no timestamp at all - outside every window, never hidden. */
  readonly unknownDay: WindowTotals;
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

export function computeCostWindows(perDay: readonly DailyCostDto[], nowMs: number): CostWindows {
  const todayUtc = utcDay(nowMs);
  const weekStartUtc = utcDay(nowMs - (WEEK_WINDOW_DAYS - 1) * DAY_MS);
  let today = ZERO;
  let last7Days = ZERO;
  let unknownDay = ZERO;
  for (const row of perDay) {
    // 'unknown' must be routed before any comparison: lexicographically it
    // sorts after every date ('u' > '9'), so a comparison would misfile it.
    if (row.day === 'unknown') {
      unknownDay = add(unknownDay, row);
      continue;
    }
    if (row.day === todayUtc) today = add(today, row);
    if (row.day >= weekStartUtc && row.day <= todayUtc) last7Days = add(last7Days, row);
  }
  return { todayUtc, weekStartUtc, today, last7Days, unknownDay };
}
