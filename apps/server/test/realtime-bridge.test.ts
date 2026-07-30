import { describe, expect, it } from 'vitest';
import type { AgentStatusChangedEvent, SessionIngestedEvent } from '../src/ingest/ingest-events';
import { toRealtimeEvent } from '../src/realtime/bridge';

const STAMP = '2026-07-20T10:00:00.000Z';

describe('toRealtimeEvent (ingest -> shared realtime seam)', () => {
  it('maps session-ingested, renaming agentsUpserted -> agentCount and stamping occurredAt', () => {
    const ingest: SessionIngestedEvent = {
      type: 'session-ingested',
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      projectSlug: '-Users-synthetic-project',
      agentsUpserted: 3,
      edgesInserted: 2,
      usageRowsInserted: 7,
      costUsd: 0.42,
    };
    expect(toRealtimeEvent(ingest, STAMP)).toEqual({
      type: 'session-ingested',
      sessionId: ingest.sessionId,
      projectSlug: ingest.projectSlug,
      agentCount: 3,
      edgesInserted: 2,
      usageRowsInserted: 7,
      costUsd: 0.42,
      occurredAt: STAMP,
    });
  });

  it('preserves a null costUsd (unpriced session) instead of coercing it', () => {
    const ingest: SessionIngestedEvent = {
      type: 'session-ingested',
      sessionId: 'bbbbbbbb-2222-4222-8222-222222222222',
      projectSlug: '-Users-synthetic-project',
      agentsUpserted: 1,
      edgesInserted: 0,
      usageRowsInserted: 0,
      costUsd: null,
    };
    expect(toRealtimeEvent(ingest, STAMP)).toMatchObject({ costUsd: null });
  });

  it('maps agent-status-changed, renaming old/new to previousStatus/status', () => {
    const ingest: AgentStatusChangedEvent = {
      type: 'agent-status-changed',
      agentId: 'agent-1',
      sessionId: 'cccccccc-3333-4333-8333-333333333333',
      oldStatus: 'working',
      newStatus: 'unknown',
    };
    expect(toRealtimeEvent(ingest, STAMP)).toEqual({
      type: 'agent-status-changed',
      sessionId: ingest.sessionId,
      agentId: 'agent-1',
      status: 'unknown',
      previousStatus: 'working',
      occurredAt: STAMP,
    });
  });

  it('maps a NULL previous status (first observation) through unchanged', () => {
    const ingest: AgentStatusChangedEvent = {
      type: 'agent-status-changed',
      agentId: 'agent-2',
      sessionId: 'cccccccc-3333-4333-8333-333333333333',
      oldStatus: null,
      newStatus: 'unknown',
    };
    expect(toRealtimeEvent(ingest, STAMP)).toMatchObject({ previousStatus: null });
  });
});
