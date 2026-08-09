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

  it('refuses the move when the bucket the agent leaves is already empty', () => {
    const session = sessionSummary({ statusCounts: statusCounts() });
    const result = applyAgentStatusChange([session], statusEvent());

    // Incrementing `completed` here would invent an agent this snapshot never
    // counted, so the snapshot is left alone and the caller refetches.
    expect(result.matched).toBe(false);
    expect(result.sessions[0]!.statusCounts).toEqual(statusCounts());
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

  it('sinks a missing timestamp whatever position it holds in the input', () => {
    const noTime = sessionSummary({ id: 'n', lastActivityAt: null });
    const older = sessionSummary({ id: 'o', lastActivityAt: '2026-07-29T08:00:00.000Z' });
    const newer = sessionSummary({ id: 'w', lastActivityAt: '2026-07-29T11:00:00.000Z' });

    for (const input of [
      [noTime, older, newer],
      [older, noTime, newer],
      [older, newer, noTime],
    ]) {
      expect(sortSessionsByRecency(input).map((session) => session.id)).toEqual(['w', 'o', 'n']);
    }
  });

  it('keeps input order for equal timestamps and for two timestamp-less sessions', () => {
    const first = sessionSummary({ id: '1', lastActivityAt: '2026-07-29T10:00:00.000Z' });
    const second = sessionSummary({ id: '2', lastActivityAt: '2026-07-29T10:00:00.000Z' });
    const nullA = sessionSummary({ id: 'x', lastActivityAt: null });
    const nullB = sessionSummary({ id: 'y', lastActivityAt: null });

    expect(sortSessionsByRecency([first, second]).map((session) => session.id)).toEqual(['1', '2']);
    expect(sortSessionsByRecency([second, first]).map((session) => session.id)).toEqual(['2', '1']);
    expect(sortSessionsByRecency([nullA, nullB]).map((session) => session.id)).toEqual(['x', 'y']);
  });

  it('handles the empty and single-session boards without inventing anything', () => {
    expect(sortSessionsByRecency([])).toEqual([]);
    const only = sessionSummary({ id: 'solo', lastActivityAt: null });
    expect(sortSessionsByRecency([only])).toEqual([only]);
  });
});
