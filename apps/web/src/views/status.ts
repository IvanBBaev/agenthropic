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
 * Display metadata for a persisted status. The parameter is `string` and not
 * `AgentStatus` on purpose: the wire type for a session status is a plain
 * string, and a server one version ahead can persist a word this build has
 * never heard of. Such a value is surfaced as `unrecognised (<raw>)` - it is
 * never folded into a known status, never dropped, and never a crash.
 */
export function statusMeta(status: string | null): StatusMeta {
  if (status === null) return NULL_STATUS_META;
  return isAgentStatus(status) ? STATUS_META[status] : unrecognisedStatusMeta(status);
}
