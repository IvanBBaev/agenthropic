/**
 * Contract between the realtime bridge and the shared SERVER_EVENT_TYPES
 * list. The bridge's constructors are the only producers the composition root
 * publishes through (src/index.ts calls toRealtimeEvent/toIngestFailureEvent
 * and nothing else), and the web client registers one EventSource listener
 * per listed name. EventSource silently drops a named event with no
 * registered listener, so a published-but-unlisted type is a frame the
 * dashboard never sees - the drift that once shipped (`ingest-failed`
 * published, never heard). These tests hold the two sides equal in BOTH
 * directions: nothing published is unlisted, and nothing listed is phantom.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_EVENT_TYPES } from '@agenthropic/shared';
import type { AgentStatusChangedEvent, SessionIngestedEvent } from '../src/ingest/ingest-events';
import type { IngestFailureReport } from '../src/ingest/corpus-watcher';
import { toIngestFailureEvent, toRealtimeEvent } from '../src/realtime/bridge';

const STAMP = '2026-08-12T10:00:00.000Z';

const sessionIngested: SessionIngestedEvent = {
  type: 'session-ingested',
  sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
  projectSlug: '-Users-synthetic-project',
  agentsUpserted: 1,
  edgesInserted: 0,
  usageRowsInserted: 1,
  costUsd: 0.01,
};

const agentStatusChanged: AgentStatusChangedEvent = {
  type: 'agent-status-changed',
  agentId: 'agent-1',
  sessionId: 'bbbbbbbb-2222-4222-8222-222222222222',
  oldStatus: 'working',
  newStatus: 'completed',
};

const ingestFailure: IngestFailureReport = {
  sessionId: 'cccccccc-3333-4333-8333-333333333333',
  reason: 'refusing to price at $0: unknown model id "unpriced-model-z"',
  attempt: 1,
  willRetry: true,
};

/** Every event `type` the bridge can construct, one instance per constructor arm. */
function publishedTypes(): readonly string[] {
  return [
    toRealtimeEvent(sessionIngested, STAMP).type,
    toRealtimeEvent(agentStatusChanged, STAMP).type,
    toIngestFailureEvent(ingestFailure, STAMP).type,
  ];
}

describe('realtime bridge <-> SERVER_EVENT_TYPES contract', () => {
  it('publishes only event types the shared list names', () => {
    for (const type of publishedTypes()) {
      expect(SERVER_EVENT_TYPES).toContain(type);
    }
  });

  it('the shared list names nothing the bridge cannot publish', () => {
    expect(new Set(publishedTypes())).toEqual(new Set(SERVER_EVENT_TYPES));
  });
});
