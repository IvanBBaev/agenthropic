/**
 * Ingest-failure reporting: one log line plus one realtime event per failed session.
 *
 * Moved out of the composition root `index.ts` (ARC-4, 2026-11-19), which
 * re-exports it; `index.ts` keeps only the wiring in `start()`.
 */
import {
  MAX_INGEST_ATTEMPTS,
  REREAD_BACKOFF_CAP_PASSES,
  type IngestFailureReport,
} from '../ingest/corpus-watcher';
import { toIngestFailureEvent } from '../realtime/bridge';
import { RealtimeHub } from '../realtime/hub';

/**
 * WP-IN5 the failure-visibility seam: an ingest failure reaches BOTH the
 * operator (a server log) and the dashboard (the SSE stream every client is
 * already listening on).
 *
 * Deliberately NOT an `/api/health` field and NOT a new endpoint. Health
 * answers "is this process serving requests"; one poisoned session does not
 * make an otherwise healthy server degraded, and wiring it there would make
 * health lie in the opposite direction - red for a condition the server is
 * correctly surviving. The retry verdict is the honest part: `will retry` says
 * the watcher intends another pass, `quarantined` says the budget is spent and
 * this session is re-read only when its bytes change, at a cadence that
 * doubles up to REREAD_BACKOFF_CAP_PASSES passes, or at once when a pricing
 * row lands.
 *
 * `report.reason` arrives already sanitized by the watcher - no absolute path,
 * no transcript content, no hook payload, length-capped.
 */
export function reportIngestFailure(
  report: IngestFailureReport,
  hub: RealtimeHub,
  occurredAt: string,
): void {
  const verdict = report.willRetry
    ? 'will retry'
    : `quarantined: re-read on a change, at most every ${String(REREAD_BACKOFF_CAP_PASSES)} passes`;
  console.error(
    `corpus ingest failure: session ${report.sessionId} ` +
      `(attempt ${String(report.attempt)}/${String(MAX_INGEST_ATTEMPTS)}, ${verdict}): ` +
      report.reason,
  );
  hub.publish(toIngestFailureEvent(report, occurredAt));
}
