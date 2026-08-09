/**
 * The ingest -> realtime seam: maps the corpus watcher's {@link IngestEvent}
 * shapes (internal, no timestamps - the watcher is a synchronous loop) onto
 * the shared {@link RealtimeEvent} DTOs that travel over SSE. The composition
 * root stamps `occurredAt` at publish time; the ingest layer stays clock-free
 * for events just as it is for everything but the edge stamp.
 */
import type { GenericRealtimeEvent, RealtimeEvent } from '@agenthropic/shared';
import type { IngestEvent } from '../ingest/ingest-events';
import type { IngestFailureReport } from '../ingest/corpus-watcher';

export function toRealtimeEvent(event: IngestEvent, occurredAt: string): RealtimeEvent {
  if (event.type === 'session-ingested') {
    return {
      type: 'session-ingested',
      sessionId: event.sessionId,
      projectSlug: event.projectSlug,
      agentCount: event.agentsUpserted,
      edgesInserted: event.edgesInserted,
      usageRowsInserted: event.usageRowsInserted,
      costUsd: event.costUsd,
      occurredAt,
    };
  }
  return {
    type: 'agent-status-changed',
    sessionId: event.sessionId,
    agentId: event.agentId,
    status: event.newStatus,
    previousStatus: event.oldStatus,
    occurredAt,
  };
}

/**
 * WP-IN5 failure visibility. A session that fails to ingest used to be dropped
 * on the floor, so the dashboard silently showed nothing while `/api/health`
 * kept answering `ok`. The failure now travels the SAME transport as every
 * other truth (CD-5: SSE is canonical), riding the shared union's generic arm
 * so no shared-schema change is needed to publish it.
 *
 * The generic arm forbids top-level extras, so `occurredAt` lives inside the
 * payload rather than beside `type`. The payload carries the session id, the
 * SANITIZED reason, and the retry verdict - never the substrate: no transcript
 * content, no absolute path, no hook payload.
 */
export function toIngestFailureEvent(
  report: IngestFailureReport,
  occurredAt: string,
): GenericRealtimeEvent {
  return {
    type: 'ingest-failed',
    payload: {
      sessionId: report.sessionId,
      reason: report.reason,
      attempt: report.attempt,
      willRetry: report.willRetry,
      occurredAt,
    },
  };
}
