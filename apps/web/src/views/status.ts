/**
 * The status vocabulary shared by every view (WP-U6..U9). Mirrors the
 * AgentStatus union in @agenthropic/shared. Two honesty rules live here:
 * `unknown` is a first-class state (OPEN-2, the missing-Stop watchdog) and is
 * ALWAYS rendered, never filtered out; and color never carries a status alone
 * - every status pairs its symbol + word (the shell legend vocabulary) with
 * the color class.
 */
import type { AgentStatus } from '../dto';

/** Every persisted status, in board display order. */
export const AGENT_STATUSES: readonly AgentStatus[] = [
  'working',
  'waiting',
  'completed',
  'error',
  'unknown',
];

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value);
}

export interface StatusMeta {
  /** Legend symbol - the color-independent identity channel. */
  readonly symbol: string;
  readonly label: string;
  readonly className: string;
}

export const STATUS_META: Readonly<Record<AgentStatus, StatusMeta>> = {
  working: { symbol: '●', label: 'working', className: 'status-working' },
  waiting: { symbol: '◌', label: 'waiting', className: 'status-waiting' },
  completed: { symbol: '✓', label: 'done', className: 'status-completed' },
  error: { symbol: '✕', label: 'error', className: 'status-error' },
  unknown: { symbol: '▲', label: 'unknown', className: 'status-unknown' },
};

/**
 * A null persisted status is NOT the same honest state as 'unknown' (which
 * the watchdog assigns actively) - it means no status was ever recorded.
 */
export const NULL_STATUS_META: StatusMeta = {
  symbol: '·',
  label: 'unrecorded',
  className: 'status-null',
};

/** Word used for a status value outside the known vocabulary. */
export const UNRECOGNISED_STATUS_LABEL = 'unrecognised';

/** Symbol for that state - a question mark, never a known status glyph. */
export const UNRECOGNISED_STATUS_SYMBOL = '?';

/**
 * A status string this build does not know (server ahead of the UI, or data
 * written by an older schema). It is shown, with its raw value, rather than
 * being coerced into a friendlier known state or dropped from the picture.
 */
export function unrecognisedStatusMeta(raw: string): StatusMeta {
  return {
    symbol: UNRECOGNISED_STATUS_SYMBOL,
    label: `${UNRECOGNISED_STATUS_LABEL} (${raw})`,
    className: 'status-unrecognised',
  };
}

/**
 * No status WORD arrived at all: the field was absent from the payload, or
 * carried something that is not a string. Distinct from `null` (a status the
 * server explicitly recorded as none) and from an unknown word (a status the
 * server did send, in a vocabulary this build has not learned yet).
 *
 * The glyph stays the unrecognised `?` rather than a new one: it is true in
 * every one of these cases that this build cannot map what it got onto the
 * vocabulary, and `?` is a glyph the shell legend already explains. Only the
 * parenthetical changes, and it names the condition instead of stringifying
 * an absence.
 */
/**
 * The parenthetical that names the absence. Exported (2026-09-08, SH-1) so the
 * shell legend can quote this module's own words instead of paraphrasing them:
 * a legend that re-types the phrase it explains is a second source of truth
 * for the same sentence, and the two drift apart the first time either is
 * reworded.
 */
export const ABSENT_STATUS_REASON = 'no status word sent';

export const ABSENT_STATUS_META: StatusMeta = {
  symbol: UNRECOGNISED_STATUS_SYMBOL,
  label: `${UNRECOGNISED_STATUS_LABEL} (${ABSENT_STATUS_REASON})`,
  className: 'status-unrecognised',
};

/**
 * Display metadata for a persisted status. The parameter is `string` and not
 * `AgentStatus` on purpose: the wire type for a session status is a plain
 * string, and a server one version ahead can persist a word this build has
 * never heard of. Such a value is surfaced as `unrecognised (<raw>)` - it is
 * never folded into a known status, never dropped, and never a crash.
 *
 * AMENDED 2026-09-07 (SV-3). The paragraph above treated `string | null` as
 * the whole input space, and the body interpolated whatever it got into
 * `unrecognised (<raw>)`. That was wrong because the parameter type is not a
 * runtime guarantee: `src/dto-guards.ts` checks containers and load-bearing
 * numbers and deliberately does NOT check strings, so a server that stops
 * sending `status`, or renames the field, reaches this function with
 * `undefined` - and the render told the reader, in the same words reserved
 * for a real unknown status word, that their server had sent the status
 * "undefined". It had sent no status at all. The parameter is now `unknown`
 * (which is what actually arrives) and a non-string value gets
 * `ABSENT_STATUS_META`, whose label states the absence. A string this build
 * does not know still shows its raw value, unchanged.
 */
export function statusMeta(status: unknown): StatusMeta {
  if (status === null) return NULL_STATUS_META;
  if (isAgentStatus(status)) return STATUS_META[status];
  return typeof status === 'string' ? unrecognisedStatusMeta(status) : ABSENT_STATUS_META;
}

/**
 * A figure this build could not COMPUTE. Deliberately not a status, and
 * deliberately not either of its two neighbours above.
 *
 * Both sites that need it used to render `?` painted `status-unknown`, which
 * borrowed the glyph of one meaning and the colour of another: `?` is the
 * unrecognised-STATUS marker, and amber `status-unknown` is the watchdog's
 * "this agent's state is not known". A reader who has learned that amber
 * means an agent is in an unknown state was being shown a missing
 * CALCULATION in the same paint. Three different facts, one vocabulary, so
 * they get three entries in it rather than two entries and a borrowing.
 *
 * The colour is the same grey as `status-null` on purpose - both are
 * absences rather than hazards, and this file's own rule is that the symbol,
 * never the colour, is what tells two states apart.
 *
 * It lives in this module, which is otherwise about agent status, so that the
 * shell legend - generated from what this module exports - cannot paint a
 * glyph it has never explained.
 */
export const NO_FIGURE_META: StatusMeta = {
  symbol: '∅',
  label: 'no figure',
  className: 'gap-no-figure',
};
