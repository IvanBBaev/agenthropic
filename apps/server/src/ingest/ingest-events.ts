/**
 * The `onIngestEvent` contract — the seam between the live ingest loop and the
 * realtime hub. The corpus watcher fires one {@link SessionIngestedEvent} per
 * successfully ingested session and one {@link AgentStatusChangedEvent} per
 * watchdog transition or M-13 SubagentStop replay; the composition root
 * (`index.ts`) bridges them to SSE via `toRealtimeEvent`. This module deliberately imports
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

/** Fired after one agent status transition was persisted (watchdog, hook, or M-13 replay). */
export interface AgentStatusChangedEvent {
  readonly type: 'agent-status-changed';
  readonly agentId: string;
  readonly sessionId: string;
  readonly oldStatus: AgentStatus | null;
  readonly newStatus: AgentStatus;
}

export type IngestEvent = SessionIngestedEvent | AgentStatusChangedEvent;
