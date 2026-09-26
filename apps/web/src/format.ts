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
 * Token counts: compact from 10k up (`56.8k`, `1.2M`, `3.4B`), grouped digits
 * below.
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
  // PP4: `-0` is a zero, and `toLocaleString` would render it as "-0".
  const count = tokens === 0 ? 0 : tokens;
  if (count >= 10_000) return compactTokens(count);
  return count.toLocaleString('en-US');
}

/** The compact units below the top tier, smallest first. */
const PROMOTABLE_TOKEN_UNITS = [
  { divisor: 1_000, suffix: 'k' },
  { divisor: 1_000_000, suffix: 'M' },
] as const;

/**
 * Round first, then pick the unit (PP3). Choosing the unit from the raw value
 * and rounding afterwards let a count just under a boundary round UP across it
 * - 999_950 rendered as `1000.0k`, 999_950_000 as `1000.0M`. A unit is used
 * only if its ROUNDED figure stays below 1000; otherwise the count is promoted
 * to the next unit, and `B` is the top tier, which keeps counting past 1000.
 */
function compactTokens(count: number): string {
  for (const { divisor, suffix } of PROMOTABLE_TOKEN_UNITS) {
    const scaled = (count / divisor).toFixed(1);
    if (Number(scaled) < 1000) return `${scaled}${suffix}`;
  }
  return `${(count / 1_000_000_000).toFixed(1)}B`;
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
 * A timestamp the server did record and this build cannot read - worded like
 * the other gap markers here, subject then state.
 *
 * Added 2026-09-23 (B2). `formatRelativeTime` answered `null` for BOTH "no
 * activity was ever recorded for this row" and "the recorded activity is a
 * string this build cannot parse", and its only caller renders `null` as the
 * words `no timestamp`. That is the server's silence spoken over the server's
 * own data: the one row in a corpus whose timestamp is corrupt reads exactly
 * like a session that has never run, and it reads that way in the column the
 * reader uses to judge freshness. The value is reachable - `isSessionList`
 * checks shape, not sanity, so any string the server sends arrives here, and
 * `live-model.ts` deliberately leaves an unreadable `lastActivityAt` in place
 * rather than overwrite it. `null` now means "nothing recorded" and nothing
 * else.
 */
export const UNREADABLE_TIMESTAMP = 'timestamp unreadable';

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
 *
 * AMENDED 2026-09-23 (B2). The first paragraph described the unparseable case
 * as returning `null` "(the caller renders the honest 'no timestamp' copy
 * instead of inventing one)". That copy is honest for `iso === null` only; for
 * a value that exists and cannot be read it reports an absence the server never
 * claimed. The unparseable case returns `UNREADABLE_TIMESTAMP` now, which the
 * caller renders as-is because it is not `null`, and `null` is left meaning
 * exactly one thing.
 */
export function formatRelativeTime(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return UNREADABLE_TIMESTAMP;
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

/**
 * True when a served string carries something a reader can actually see.
 *
 * Whitespace counts as nothing on purpose: a name of three spaces renders
 * pixel-identical to a name of none, so the two cannot be told apart on screen
 * and must not be told apart here either.
 */
export function hasVisibleText(value: string): boolean {
  return value.trim() !== '';
}

/**
 * The quoted form of a raw value this build is reporting back rather than
 * interpreting (2026-09-23, lane-P). One implementation of the punctuation,
 * because `status.ts`, `SessionsView` and `CostView` all report unrecognised
 * or unnameable values and a second module re-typing the quotes would be a
 * second source of truth for one convention.
 *
 * Note what it is NOT for. A parenthetical that states a CONDITION this build
 * wrote itself - `ABSENT_STATUS_REASON`'s "no status word sent" - must stay
 * unquoted: the quotes are what tell the reader "these are the server's own
 * bytes", and putting them round our own prose would be a small lie in the
 * one place whose job is to say where a value came from.
 */
export function quoteRawValue(raw: string): string {
  return `"${raw}"`;
}

/**
 * A served NAME, or an explicit marker when the server sent nothing visible.
 *
 * The raw value is quoted rather than paraphrased away, for the reason lane O
 * gave `unreadableDayLabel` the same shape: `""` reads as the empty string it
 * is, `"   "` shows its spaces, and a reader who has to go and ask the server
 * what it sent needs to be able to quote it back. One string rather than two
 * arms, so a caller cannot render the marker without the evidence for it.
 */
export function nameOrBlank(raw: string, subject: string): string {
  return hasVisibleText(raw) ? raw : `blank ${subject} (${quoteRawValue(raw)})`;
}

/** Session ids are UUID-ish; eight leading chars identify one on screen. */
/**
 * AMENDED 2026-09-23 (lane-P). "Eight leading chars identify one on screen"
 * was the whole contract, and it was silent about the case where there are no
 * chars to lead with. Every call site puts this string inside a `<code>`
 * element that holds nothing else, so an id of `''` - contract-valid, since
 * `dto-guards.ts` checks containers and load-bearing numbers and deliberately
 * NOT strings - rendered an empty `<code></code>`: a row whose identity column
 * is blank, beside token counts and dollar figures that are real. The reader
 * cannot tell an id the server omitted from one this page failed to print.
 */
export function shortId(id: string): string {
  if (!hasVisibleText(id)) return nameOrBlank(id, 'id');
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/**
 * A session with no persisted project slug is a RECORDING GAP, not a session
 * that belongs to no project - the copy says so instead of asserting absence.
 *
 * AMENDED 2026-09-23 (lane-P). The gap marker was reached through `??`, which
 * catches `null` and nothing else. A slug that is PRESENT and says nothing -
 * `''` or whitespace - passed straight through to a project column that then
 * rendered empty, which is the one outcome this function was written to
 * prevent, arrived at by a different route. Both absences are now named, and
 * they keep different words: `project unknown` is "no slug was recorded",
 * `blank project slug ("")` is "a slug was recorded and it says nothing".
 */
export function projectLabel(slug: string | null): string {
  return slug === null ? 'project unknown' : nameOrBlank(slug, 'project slug');
}

/**
 * Agent identity in one word: the subagent type when the ingest recorded one,
 * otherwise the agent type, otherwise an explicit gap marker. Never the bare
 * word "agent", which would read as a recorded fact rather than a hole.
 *
 * AMENDED 2026-09-23 (lane-P). Same `??` blindness as `projectLabel`, with a
 * second failure on top of it: a blank `subagentType` not only rendered as
 * nothing, it also SHADOWED a perfectly good `type` in the next field, turning
 * a recorded fact into a hole. The preference order is now over values a
 * reader can see, and the marker is reached only when neither field holds one.
 */
export function agentTypeLabel(subagentType: string | null, type: string | null): string {
  const named = [subagentType, type].find(
    (value): value is string => value !== null && hasVisibleText(value),
  );
  if (named !== undefined) return named;
  const raw = subagentType ?? type;
  return raw === null ? 'type unrecorded' : nameOrBlank(raw, 'type');
}
