/**
 * Owner decisions 1 and 2 (NN1): the one place that says a session total is
 * not the whole story.
 *
 * - PARTIAL (decision 1). The main transcript was over the 64 MiB read cap, so
 *   ingest read the subagent transcripts and skipped the main one. Every total
 *   the session shows is therefore a LOWER BOUND. The server says so with
 *   `partial: { reason: 'main-transcript-oversize', skippedBytes }`; `null`
 *   means whole.
 * - DROPPED USAGE (decision 2, NN1). A usage record with no `message.id` has
 *   no dedupe key, and counting it could double-count a streamed retry, so it
 *   is excluded rather than guessed at. `usageRecordsDropped` is how many.
 *
 * Like `unpriced.tsx`, the disclosure is the PRESENCE of the clause, so its
 * absence must mean "nothing to disclose" and nothing else: `null` / zero is
 * the only silent case. A count no read can produce (NaN, an infinity, a
 * negative) is named as such rather than swallowed or printed as a figure
 * (W-3, 2026-10-12: it used to print "Includes NaN partial sessions", and every
 * description on the page pointed a reader at that sentence). The guards in
 * `dto-guards.ts` refuse a payload that lacks either field, so an old server
 * never reaches here as "whole".
 */
import type { SessionPartialDto } from '../dto';
import { impossibleCountText, isImpossibleCount } from '../format';

/** The owner-decided words for a partial session. */
export const PARTIAL_SESSION_TEXT =
  'partial — main transcript too large to read; totals are a lower bound';

const BYTES_PER_MIB = 1024 * 1024;

/**
 * The partial badge, or nothing for a whole session. `lead` separates it from
 * the figure it qualifies at the call site (see `UnpricedNote`).
 */
export function PartialBadge({
  partial,
  lead,
}: {
  readonly partial: SessionPartialDto | null;
  readonly lead: string;
}) {
  if (partial === null) return null;
  // 2026-10-10: `toFixed(1)` printed "0.0 MiB not read" for anything under
  // 52 KiB - a clause that says bytes were skipped and then names none - and
  // "NaN MiB" for a size that could not be read. A small size is now bounded
  // from above, an impossible one named.
  // W-6 (2026-10-12): a served zero was still that clause, and beside a reason
  // that says the transcript was too large to read it is a contradiction the
  // payload carries - so it is named as one rather than rounded to "0.0".
  const size =
    partial.skippedBytes === null
      ? ''
      : isImpossibleCount(partial.skippedBytes)
        ? ` (skipped size ${impossibleCountText(partial.skippedBytes)})`
        : partial.skippedBytes === 0
          ? ' (skipped size 0, which contradicts a transcript too large to read)'
          : partial.skippedBytes < BYTES_PER_MIB / 10
            ? ' (under 0.1 MiB not read)'
            : ` (${(partial.skippedBytes / BYTES_PER_MIB).toFixed(1)} MiB not read)`;
  return (
    <span className="partial-badge">
      {lead}
      {PARTIAL_SESSION_TEXT}
      {size}
    </span>
  );
}

/** "N usage records could not be deduplicated and were excluded", or nothing at zero. */
export function DroppedUsageNote({
  count,
  lead,
}: {
  readonly count: number;
  readonly lead: string;
}) {
  if (count === 0) return null;
  const text = isImpossibleCount(count)
    ? `The dropped-usage count came back as ${impossibleCountText(count)}, so how many usage records were excluded is unknown.`
    : count === 1
      ? '1 usage record could not be deduplicated and was excluded'
      : `${String(count)} usage records could not be deduplicated and were excluded`;
  return (
    <span className="dropped-usage">
      {lead}
      {text}
    </span>
  );
}

/** The aggregate's statement that it includes partial sessions, or nothing at zero. */
export function PartialAggregateNote({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <span className="partial-badge">
      {isImpossibleCount(count)
        ? `The partial-session count came back as ${impossibleCountText(count)}, so how many of these sessions are partial is unknown - treat every total as a lower bound.`
        : `Includes ${String(count)} partial ${count === 1 ? 'session' : 'sessions'} (lower bound).`}
    </span>
  );
}
