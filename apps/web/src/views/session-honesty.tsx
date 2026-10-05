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
 * the only silent case. A negative count is impossible and is shown rather
 * than swallowed. The guards in `dto-guards.ts` refuse a payload that lacks
 * either field, so an old server never reaches here as "whole".
 */
import type { SessionPartialDto } from '../dto';

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
  const size =
    partial.skippedBytes === null
      ? ''
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
  const text =
    count === 1
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
      {`Includes ${String(count)} partial ${count === 1 ? 'session' : 'sessions'} (lower bound).`}
    </span>
  );
}
