/**
 * Pure state transitions for the live status board (WP-U6). The board's
 * ground truth is GET /api/sessions; between refetches the SSE stream patches
 * that snapshot: an `agent-status-changed` event moves one agent between a
 * session's status buckets in place, and anything the snapshot cannot absorb
 * honestly (an unknown session, a fresh ingest) makes the caller refetch
 * persisted truth instead of guessing.
 */
import type { AgentStatusChangedEvent, SessionSummaryDto } from '../dto';
import { isAgentStatus } from './status';

/**
 * Structural guard for the SSE payload - the stream delivers parsed-but-
 * untyped JSON, so the board only applies frames that carry the full
 * agent-status-changed shape (see @agenthropic/shared realtime schema).
 */
export function isAgentStatusChangedEvent(data: unknown): data is AgentStatusChangedEvent {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    record['type'] === 'agent-status-changed' &&
    typeof record['sessionId'] === 'string' &&
    typeof record['agentId'] === 'string' &&
    isAgentStatus(record['status']) &&
    (record['previousStatus'] === null || isAgentStatus(record['previousStatus'])) &&
    typeof record['occurredAt'] === 'string'
  );
}

export interface StatusChangeResult {
  readonly sessions: readonly SessionSummaryDto[];
  /**
   * False when the event references a session this snapshot does not know -
   * the honest reaction is a refetch, never inventing a summary row.
   */
  readonly matched: boolean;
}

/**
 * Move one agent between status buckets of its session. The new status
 * bucket always increments; the previous bucket decrements only when the
 * event names one and the bucket is non-empty (a null previousStatus means
 * the agent had no persisted status, so it sat in no bucket). Counts other
 * than the two touched buckets - and every other session - stay untouched;
 * `lastActivityAt` advances to the event's occurredAt (a real observation).
 */
export function applyAgentStatusChange(
  sessions: readonly SessionSummaryDto[],
  event: AgentStatusChangedEvent,
): StatusChangeResult {
  const index = sessions.findIndex((session) => session.id === event.sessionId);
  if (index === -1) return { sessions, matched: false };
  const session = sessions[index]!;
  const counts = { ...session.statusCounts };
  counts[event.status] += 1;
  if (event.previousStatus !== null && counts[event.previousStatus] > 0) {
    counts[event.previousStatus] -= 1;
  }
  const next = [...sessions];
  next[index] = { ...session, statusCounts: counts, lastActivityAt: event.occurredAt };
  return { sessions: next, matched: true };
}

/**
 * Board order: most recent activity first; sessions with no recorded
 * activity timestamp sink to the end (never invented); ties keep input
 * order (stable sort keyed by index).
 */
export function sortSessionsByRecency(
  sessions: readonly SessionSummaryDto[],
): readonly SessionSummaryDto[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const aTime = a.session.lastActivityAt !== null ? Date.parse(a.session.lastActivityAt) : NaN;
      const bTime = b.session.lastActivityAt !== null ? Date.parse(b.session.lastActivityAt) : NaN;
      const aValid = !Number.isNaN(aTime);
      const bValid = !Number.isNaN(bTime);
      if (aValid && bValid && aTime !== bTime) return bTime - aTime;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.session);
}
