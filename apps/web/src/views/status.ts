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

export function statusMeta(status: AgentStatus | null): StatusMeta {
  return status === null ? NULL_STATUS_META : STATUS_META[status];
}
