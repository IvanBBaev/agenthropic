/**
 * The `onIngestEvent` contract — the seam between the live ingest loop and the
 * (future) realtime orchestrator. The corpus watcher fires one
 * {@link SessionIngestedEvent} per successfully ingested session and one
 * {@link AgentStatusChangedEvent} per watchdog transition; the orchestrator
 * that owns server.ts bridges them to SSE. This module deliberately imports
 * nothing from the corpus/db layers so it can be consumed from anywhere
 * without cycles.
 */
import type { AgentStatus } from '@agenthropic/shared';

/** Fired after one session ingested successfully (its transaction committed). */
export interface SessionIngestedEvent {
  readonly type: 'session-ingested';
  readonly sessionId: string;
  readonly projectSlug: string;
  readonly agentsUpserted: number;
  readonly edgesInserted: number;
  readonly usageRowsInserted: number;
  readonly costUsd: number | null;
}

/** Fired after the WP-IN12 watchdog persisted one agent status transition. */
export interface AgentStatusChangedEvent {
  readonly type: 'agent-status-changed';
  readonly agentId: string;
  readonly sessionId: string;
  readonly oldStatus: AgentStatus | null;
  readonly newStatus: AgentStatus;
}

export type IngestEvent = SessionIngestedEvent | AgentStatusChangedEvent;
