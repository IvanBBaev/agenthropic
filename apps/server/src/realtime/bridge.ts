/**
 * The ingest -> realtime seam: maps the corpus watcher's {@link IngestEvent}
 * shapes (internal, no timestamps - the watcher is a synchronous loop) onto
 * the shared {@link RealtimeEvent} DTOs that travel over SSE. The composition
 * root stamps `occurredAt` at publish time; the ingest layer stays clock-free
 * for events just as it is for everything but the edge stamp.
 */
import type { RealtimeEvent } from '@agenthropic/shared';
import type { IngestEvent } from '../ingest/ingest-events';

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
