/**
 * Live-board pure model tests (WP-U6): the SSE guard, in-place bucket moves,
 * the honest unmatched signal, and recency ordering.
 */
import { describe, expect, it } from 'vitest';
import type { AgentStatusChangedEvent } from '../src/dto';
import {
  applyAgentStatusChange,
  isAgentStatusChangedEvent,
  sortSessionsByRecency,
} from '../src/views/live-model';
import { sessionSummary, statusCounts } from './fixtures';

function statusEvent(overrides: Partial<AgentStatusChangedEvent> = {}): AgentStatusChangedEvent {
  return {
    type: 'agent-status-changed',
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    agentId: 'agent-child',
    status: 'completed',
    previousStatus: 'working',
    occurredAt: '2026-07-29T10:10:00.000Z',
    ...overrides,
  };
}

describe('isAgentStatusChangedEvent', () => {
  it('accepts the full event shape, with and without a previous status', () => {
    expect(isAgentStatusChangedEvent(statusEvent())).toBe(true);
    expect(isAgentStatusChangedEvent(statusEvent({ previousStatus: null }))).toBe(true);
  });

  it('rejects non-objects, wrong types and invalid statuses', () => {
    expect(isAgentStatusChangedEvent(null)).toBe(false);
    expect(isAgentStatusChangedEvent('agent-status-changed')).toBe(false);
    expect(isAgentStatusChangedEvent({ ...statusEvent(), type: 'session-ingested' })).toBe(false);
    expect(isAgentStatusChangedEvent({ ...statusEvent(), status: 'done' })).toBe(false);
    expect(isAgentStatusChangedEvent({ ...statusEvent(), previousStatus: 'done' })).toBe(false);
    expect(isAgentStatusChangedEvent({ ...statusEvent(), occurredAt: 7 })).toBe(false);
  });
});

describe('applyAgentStatusChange', () => {
  it('moves one agent between buckets and advances lastActivityAt', () => {
    const session = sessionSummary({ statusCounts: statusCounts({ working: 2, completed: 1 }) });
    const result = applyAgentStatusChange([session], statusEvent());

    expect(result.matched).toBe(true);
    const updated = result.sessions[0]!;
    expect(updated.statusCounts).toEqual(statusCounts({ working: 1, completed: 2 }));
    expect(updated.lastActivityAt).toBe('2026-07-29T10:10:00.000Z');
    // The input snapshot is never mutated.
    expect(session.statusCounts.working).toBe(2);
  });

  it('only increments when previousStatus is null (the agent sat in no bucket)', () => {
    const session = sessionSummary({ statusCounts: statusCounts({ working: 1 }) });
    const result = applyAgentStatusChange([session], statusEvent({ previousStatus: null }));

    expect(result.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 1, completed: 1 }));
  });

  it('never decrements an already-empty bucket below zero', () => {
    const session = sessionSummary({ statusCounts: statusCounts() });
    const result = applyAgentStatusChange([session], statusEvent());

    expect(result.sessions[0]!.statusCounts).toEqual(statusCounts({ completed: 1 }));
  });

  it('reports an unknown session as unmatched and leaves the snapshot untouched', () => {
    const sessions = [sessionSummary()];
    const result = applyAgentStatusChange(sessions, statusEvent({ sessionId: 'other-session' }));

    expect(result.matched).toBe(false);
    expect(result.sessions).toBe(sessions);
  });

  it('leaves other sessions untouched', () => {
    const target = sessionSummary({ statusCounts: statusCounts({ working: 1 }) });
    const other = sessionSummary({ id: 'bbbbbbbb-0000-0000-0000-000000000000' });
    const result = applyAgentStatusChange([other, target], statusEvent());

    expect(result.sessions[0]).toBe(other);
  });
});

describe('sortSessionsByRecency', () => {
  it('orders by lastActivityAt descending with null/invalid timestamps last, stable on ties', () => {
    const oldest = sessionSummary({ id: 'a', lastActivityAt: '2026-07-29T08:00:00.000Z' });
    const newest = sessionSummary({ id: 'b', lastActivityAt: '2026-07-29T11:00:00.000Z' });
    const noTimeFirst = sessionSummary({ id: 'c', lastActivityAt: null });
    const noTimeSecond = sessionSummary({ id: 'd', lastActivityAt: 'garbage' });

    const sorted = sortSessionsByRecency([noTimeFirst, oldest, noTimeSecond, newest]);
    expect(sorted.map((session) => session.id)).toEqual(['b', 'a', 'c', 'd']);
  });
});
