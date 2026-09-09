/**
 * Pure display formatters shared by the dashboard views (WP-U6..U9). All are
 * deterministic (fixed locale, injected clock) so the visual vocabulary is
 * unit-testable. Dollar figures always come from server-side ground truth;
 * these helpers only shape digits, they never estimate.
 */

/**
 * A token count that is not a number at all - the counterpart of
 * `UNREADABLE_USD` below, worded the same way so the two gaps read as one
 * vocabulary.
 */
export const UNREADABLE_TOKENS = 'tokens unreadable';

/**
 * Token counts: compact above 10k (`56.8k`, `1.2M`), grouped digits below.
 *
 * AMENDED 2026-09-02 (F-5): the non-finite guard is new, and the type
 * annotation is not the reason it can be dropped. Every payload reaches these
 * formatters through `body as T` in `api.ts` - an unchecked cast, with no
 * runtime schema anywhere in this app - so `tokens` is whatever the server
 * actually sent. A renamed or newly-absent field made this function throw
 * `Cannot read properties of undefined (reading 'toLocaleString')`, and with no
 * error boundary in the tree that took the WHOLE page down. `NaN` and
 * `Infinity` were the quieter half of the same hole: they did not throw, they
 * rendered - `NaN` and `InfinityM` - as if they were counts.
 *
 * `Number.isFinite` is the one predicate that covers all four (absent, null,
 * NaN, infinite) without a separate arm per shape, which matters here because
 * an arm that cannot be reached from a test is an arm this repo's coverage gate
 * rejects.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return UNREADABLE_TOKENS;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toLocaleString('en-US');
}

/**
 * A figure that is not a number at all. `toFixed` would happily render `NaN`
 * and `Infinity` into a currency string, and `$NaN` in one cell of a table of
 * twenty correct ones scrolls past unnoticed. Worded like the other gap
 * markers in this module - subject, then state - so it cannot be mistaken for
 * an amount.
 */
export const UNREADABLE_USD = 'cost unreadable';

/**
 * USD amounts: cents precision normally, four decimals for sub-cent amounts
 * so a real-but-tiny cost never rounds to a misleading `$0.00`. An exact zero
 * renders as `$0.00` - genuinely nothing priced, not a rounding artifact - and
 * an amount below the four-decimal floor renders as `<$0.0001` (or `>-$0.0001`)
 * so it can never round DOWN to the same string as that honest zero.
 *
 * The floor guard used to read `costUsd > 0 &&`, which protected one side of
 * zero only: `-0.00004` came out as `$-0.0000`, a non-zero amount wearing four
 * zeros and a minus sign, which reads as "essentially nothing" - precisely the
 * misreading the arm exists to prevent, arriving from the direction nobody
 * checked. The same one-sidedness sent every negative through the sub-cent arm,
 * so a -$12.50 bill printed as `$-12.5000`. Negative bills are not
 * hypothetical: the server is documented to serve them with HTTP 200 rather
 * than hide them. Branching on MAGNITUDE makes the two sides of zero symmetric,
 * which is the only way the reader can trust the shape of either.
 */
export function formatUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd)) return UNREADABLE_USD;
  if (costUsd === 0) return '$0.00';
  const magnitude = Math.abs(costUsd);
  if (magnitude < 0.0001) return costUsd > 0 ? '<$0.0001' : '>-$0.0001';
  if (magnitude < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

/**
 * How far ahead of this machine's clock a timestamp may sit and still be read
 * as jitter rather than as a fault. Deliberately the same 90 s as the "just
 * now" window below, so the two sides of `nowMs` are one symmetric band
 * instead of a bounded past and an unbounded future.
 */
export const FUTURE_SKEW_TOLERANCE_MS = 90_000;

/** A timestamp further ahead of this clock than skew can explain. */
export const AHEAD_OF_CLOCK = 'ahead of this clock';

/**
 * Relative recency for an ISO timestamp against an injected clock. `null` in,
 * or an unparseable value, -> `null` (the caller renders the honest "no
 * timestamp" copy instead of inventing one). Small negative skew reads as
 * `just now`.
 *
 * "Small" is now enforced. The guard below is `seconds < 90` with no lower
 * bound, which meant ALL negative skew read as `just now` - ninety seconds,
 * ninety minutes or ninety days. A timestamp the app cannot reconcile with its
 * own clock was rendered as the single most reassuring answer available, which
 * is the `?? 0` mistake in the time domain. It compounds: `sortSessionsByRecency`
 * orders on the raw parse, so the row with the most corrupt timestamp floats to
 * the TOP of the live board and is labelled the freshest thing in the system.
 * This function fixes the label only - the ordering is a separate decision,
 * and an anomaly sitting at the top of the board while correctly named is not
 * obviously the wrong outcome.
 */
export function formatRelativeTime(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return null;
  return formatRelativeMs(timestamp, nowMs);
}

/**
 * The same wording for a timestamp the caller already holds as a number - a
 * moment this app itself observed (a fetch landing), which cannot fail to
 * parse and therefore has no honest `null` to return.
 *
 * Split out so a caller with a real instant is not forced through an ISO
 * round-trip and then made to handle a `null` that cannot occur: the branch
 * would be untestable, and an untestable branch is where a wrong default goes
 * to hide.
 */
export function formatRelativeMs(timestampMs: number, nowMs: number): string {
  if (timestampMs - nowMs > FUTURE_SKEW_TOLERANCE_MS) return AHEAD_OF_CLOCK;
  const seconds = Math.floor((nowMs - timestampMs) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Session ids are UUID-ish; eight leading chars identify one on screen. */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/**
 * A session with no persisted project slug is a RECORDING GAP, not a session
 * that belongs to no project - the copy says so instead of asserting absence.
 */
export function projectLabel(slug: string | null): string {
  return slug ?? 'project unknown';
}

/**
 * Agent identity in one word: the subagent type when the ingest recorded one,
 * otherwise the agent type, otherwise an explicit gap marker. Never the bare
 * word "agent", which would read as a recorded fact rather than a hole.
 */
export function agentTypeLabel(subagentType: string | null, type: string | null): string {
  return subagentType ?? type ?? 'type unrecorded';
}
