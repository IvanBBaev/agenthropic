/**
 * Live-board pure model tests (WP-U6): the SSE guard, in-place bucket moves,
 * the honest unmatched signal, and recency ordering.
 */
import { describe, expect, it } from 'vitest';
import type { AgentStatusChangedEvent, SessionStatusCountsDto } from '../src/dto';
import {
  applyAgentStatusChange,
  isAgentStatusChangedEvent,
  livePatchCount,
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
    // The move advanced the row's only freshness cue, so the row must also
    // carry the count that says the rest of it did NOT advance with it.
    expect(livePatchCount(updated)).toBe(1);
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

describe('livePatchCount', () => {
  it('reads a never-patched row as zero without the row carrying a field', () => {
    const wire = sessionSummary();
    // A row straight off the wire IS a summary - the server sends no such
    // field, and inventing a zero here would be a second spelling of "never
    // patched" that could drift from the absent one.
    expect('livePatches' in wire).toBe(false);
    expect(livePatchCount(wire)).toBe(0);
  });

  it('accumulates across successive patches to the same row', () => {
    const session = sessionSummary({ statusCounts: statusCounts({ working: 3 }) });
    const once = applyAgentStatusChange([session], statusEvent({ agentId: 'agent-a' }));
    const twice = applyAgentStatusChange(once.sessions, statusEvent({ agentId: 'agent-b' }));
    const thrice = applyAgentStatusChange(twice.sessions, statusEvent({ agentId: 'agent-c' }));

    // Three frames is a different amount of drift from one, and the card is
    // left to say so rather than being handed a boolean.
    //
    // AMENDED 2026-09-03 (LV-7): the three frames now name three DIFFERENT
    // agents. What this test proves is unchanged - it is still successive
    // patches to the same ROW, and three of them still have to read as more
    // drift than one - but the byte-identical frame it used to reach for,
    // because it was the easiest event to hand, had since become the very
    // thing under test: a redelivered frame is now absorbed rather than
    // applied, so repeating one no longer counts as a second patch and
    // asserting that it does would pin the defect in place.
    expect(livePatchCount(thrice.sessions[0]!)).toBe(3);
  });

  it('does not count a refused move', () => {
    // The bucket the agent would leave is empty, so nothing was applied - and
    // a row that was not rewritten has not drifted.
    const session = sessionSummary({ statusCounts: statusCounts() });
    const result = applyAgentStatusChange([session], statusEvent());

    expect(result.matched).toBe(false);
    expect(livePatchCount(result.sessions[0]!)).toBe(0);
  });

  it('leaves the untouched rows of a patched board at zero', () => {
    const target = sessionSummary({ statusCounts: statusCounts({ working: 1 }) });
    const other = sessionSummary({ id: 'bbbbbbbb-0000-0000-0000-000000000000' });
    const result = applyAgentStatusChange([other, target], statusEvent());

    expect(livePatchCount(result.sessions[0]!)).toBe(0);
    expect(livePatchCount(result.sessions[1]!)).toBe(1);
  });
});

/**
 * AMENDED 2026-09-03 (LV-1, LV-4): the two ways an `agent-status-changed` frame
 * could still write something the snapshot cannot support.
 *
 * The stream offers no ordering or uniqueness guarantee - the hub keeps no
 * replay buffer and EventSource redelivers at the server's discretion - so the
 * board has to survive a frame arriving late, twice, or with an occurredAt it
 * cannot read. Two of those were absorbed as fact:
 *
 * - LV-1: `lastActivityAt` was overwritten unconditionally, so an older or
 *   unreadable occurredAt dragged the card's only freshness cue backwards (and
 *   demoted the card through sortSessionsByRecency).
 * - LV-4: a `previousStatus: null` move incremented with no ceiling, so a
 *   redelivered first-sighting frame could show more agents in the buckets than
 *   the session has agents at all.
 */
describe('applyAgentStatusChange under out-of-order and duplicate frames (LV-1, LV-4)', () => {
  it('does not drag lastActivityAt backwards when a frame arrives late', () => {
    const session = sessionSummary({
      lastActivityAt: '2026-07-29T10:30:00.000Z',
      statusCounts: statusCounts({ working: 2, completed: 1 }),
    });
    // occurredAt is 20 minutes BEHIND what the row already recorded.
    const result = applyAgentStatusChange([session], statusEvent());

    expect(result.matched).toBe(true);
    const updated = result.sessions[0]!;
    // The bucket move is still real - the agent did change status - but the
    // freshness label may only ever move forwards.
    expect(updated.statusCounts).toEqual(statusCounts({ working: 1, completed: 2 }));
    expect(updated.lastActivityAt).toBe('2026-07-29T10:30:00.000Z');
  });

  it('does not erase a known timestamp when occurredAt is unreadable', () => {
    const session = sessionSummary({
      lastActivityAt: '2026-07-29T10:05:00.000Z',
      statusCounts: statusCounts({ working: 2 }),
    });
    // The guard only promises a string; nothing promises it parses as a date.
    const result = applyAgentStatusChange([session], statusEvent({ occurredAt: 'not-a-date' }));

    expect(result.matched).toBe(true);
    // Writing this through would render the card as `no timestamp`, i.e. would
    // report "never active" for a session that was active five minutes ago.
    expect(result.sessions[0]!.lastActivityAt).toBe('2026-07-29T10:05:00.000Z');
  });

  it('adopts the event time when the row has no timestamp or an unreadable one', () => {
    const noTime = sessionSummary({
      lastActivityAt: null,
      statusCounts: statusCounts({ working: 2 }),
    });
    const badTime = sessionSummary({
      lastActivityAt: 'garbage',
      statusCounts: statusCounts({ working: 2 }),
    });

    expect(applyAgentStatusChange([noTime], statusEvent()).sessions[0]!.lastActivityAt).toBe(
      '2026-07-29T10:10:00.000Z',
    );
    // A row whose stored timestamp cannot be read is not evidence of anything,
    // so a readable observation is an improvement on it.
    expect(applyAgentStatusChange([badTime], statusEvent()).sessions[0]!.lastActivityAt).toBe(
      '2026-07-29T10:10:00.000Z',
    );
  });

  it('refuses a first-sighting move that would put more agents in buckets than the session has', () => {
    // Three agents, three of them already placed: a redelivered `previousStatus:
    // null` frame would make it four in a three-agent session.
    const session = sessionSummary({
      agentCount: 3,
      statusCounts: statusCounts({ working: 1, completed: 2 }),
    });
    const result = applyAgentStatusChange([session], statusEvent({ previousStatus: null }));

    expect(result.matched).toBe(false);
    expect(result.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 1, completed: 2 }));
    expect(livePatchCount(result.sessions[0]!)).toBe(0);
  });

  it('allows a first-sighting move while the session still has an unplaced agent', () => {
    const session = sessionSummary({
      agentCount: 3,
      statusCounts: statusCounts({ working: 1, completed: 1 }),
    });
    const result = applyAgentStatusChange([session], statusEvent({ previousStatus: null }));

    expect(result.matched).toBe(true);
    expect(result.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 1, completed: 2 }));
  });

  it('counts a bucket the snapshot omits as no agents rather than refusing the move', () => {
    // A snapshot missing a bucket is already a gap the card renders; it is not
    // a reason to refuse a move the remaining counts can support.
    const holes = { working: 1, completed: 1 } as SessionStatusCountsDto;
    const session = sessionSummary({ agentCount: 3, statusCounts: holes });
    const result = applyAgentStatusChange([session], statusEvent({ previousStatus: null }));

    expect(result.matched).toBe(true);
    expect(result.sessions[0]!.statusCounts).toEqual({ working: 1, completed: 2 });
  });
});

/**
 * LV-7 (2026-09-03). The third consequence of the stream's missing uniqueness
 * guarantee, and the one the earlier two do not cover.
 *
 * LV-4 caught the redelivered FIRST SIGHTING because that frame GROWS the
 * placed-agent total and can therefore break a ceiling. An ordinary transition
 * breaks no ceiling: `working -> completed` decrements one bucket and
 * increments another, so the totals stay legal however many times it is
 * applied. A redelivered `working -> completed` for ONE agent therefore moved
 * TWO - for as long as the `working` bucket was still non-empty, which it is
 * exactly when other agents are working. The card said three agents had
 * finished when two had.
 *
 * The frame carries an agentId, so the repeat is detectable: a row remembers
 * the status it has already moved each agent INTO, and a frame moving that
 * agent into that same status is not a move at all.
 */
describe('applyAgentStatusChange under redelivered frames (LV-7)', () => {
  it('absorbs a redelivered transition instead of moving a second agent', () => {
    const session = sessionSummary({ agentCount: 3, statusCounts: statusCounts({ working: 3 }) });
    const once = applyAgentStatusChange([session], statusEvent());
    const twice = applyAgentStatusChange(once.sessions, statusEvent());

    // One agent finished. The second delivery of the same frame is evidence of
    // nothing new, so the buckets must read exactly as they did after the first.
    expect(twice.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 2, completed: 1 }));
    // Nothing was rewritten, so the row is the same row - not a copy of it.
    expect(twice.sessions).toBe(once.sessions);
    expect(twice.sessions[0]).toBe(once.sessions[0]);
    // The row did not drift a second time, so it must not claim to have.
    expect(livePatchCount(twice.sessions[0]!)).toBe(1);
  });

  it('asks for no refetch on a repeat, because the board is already right', () => {
    const session = sessionSummary({ statusCounts: statusCounts({ working: 2 }) });
    const once = applyAgentStatusChange([session], statusEvent());
    const twice = applyAgentStatusChange(once.sessions, statusEvent());

    // A REPEAT is not a DISAGREEMENT. There is nothing to refetch - the row
    // already carries the move - and answering `matched: false` would make a
    // redelivering stream refetch once per redelivered frame.
    expect(twice.matched).toBe(true);
  });

  it('absorbs the repeat even once the bucket the agent left has emptied', () => {
    // The last working agent finishes: the second delivery finds `working` at
    // zero. Refusing here (the pre-LV-7 answer) was a refetch for a board that
    // needed none.
    const session = sessionSummary({ agentCount: 1, statusCounts: statusCounts({ working: 1 }) });
    const once = applyAgentStatusChange([session], statusEvent());
    const twice = applyAgentStatusChange(once.sessions, statusEvent());

    expect(twice.matched).toBe(true);
    expect(twice.sessions[0]!.statusCounts).toEqual(statusCounts({ completed: 1 }));
  });

  it('absorbs a redelivered first sighting the agent count still has room for', () => {
    // LV-4's ceiling does not fire here - two placed agents in a three-agent
    // session - so before LV-7 this frame counted the same agent twice.
    const session = sessionSummary({ agentCount: 3, statusCounts: statusCounts({ working: 1 }) });
    const once = applyAgentStatusChange([session], statusEvent({ previousStatus: null }));
    const twice = applyAgentStatusChange(once.sessions, statusEvent({ previousStatus: null }));

    expect(twice.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 1, completed: 1 }));
    expect(livePatchCount(twice.sessions[0]!)).toBe(1);
  });

  it('keeps moving the other agents of the same session', () => {
    // The memory is per agent, not per row: one agent's applied move must not
    // silence the next agent's.
    const session = sessionSummary({ agentCount: 3, statusCounts: statusCounts({ working: 3 }) });
    const first = applyAgentStatusChange([session], statusEvent({ agentId: 'agent-a' }));
    const second = applyAgentStatusChange(first.sessions, statusEvent({ agentId: 'agent-b' }));

    expect(second.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 1, completed: 2 }));
    expect(livePatchCount(second.sessions[0]!)).toBe(2);
  });

  it('applies a real second transition after the agent has moved on', () => {
    // working -> completed -> working -> completed. The middle frame moves the
    // agent out of `completed`, so the last frame is a move again and not a
    // repeat: the memory records where the agent IS, not that it was ever seen.
    const session = sessionSummary({ agentCount: 2, statusCounts: statusCounts({ working: 2 }) });
    const done = applyAgentStatusChange([session], statusEvent());
    const resumed = applyAgentStatusChange(
      done.sessions,
      statusEvent({ status: 'working', previousStatus: 'completed' }),
    );
    const doneAgain = applyAgentStatusChange(resumed.sessions, statusEvent());

    expect(doneAgain.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 1, completed: 1 }));
    expect(livePatchCount(doneAgain.sessions[0]!)).toBe(3);
  });

  it('remembers within one session, not across the board', () => {
    // The memory rides the row, so two sessions that happen to name the same
    // agent cannot silence each other.
    const target = sessionSummary({ id: 'a', statusCounts: statusCounts({ working: 2 }) });
    const other = sessionSummary({ id: 'b', statusCounts: statusCounts({ working: 2 }) });
    const first = applyAgentStatusChange([target, other], statusEvent({ sessionId: 'a' }));
    const second = applyAgentStatusChange(first.sessions, statusEvent({ sessionId: 'b' }));

    expect(second.sessions[1]!.statusCounts).toEqual(statusCounts({ working: 1, completed: 1 }));
  });

  it('forgets what it applied to a row that a refetch has replaced', () => {
    const session = sessionSummary({ agentCount: 3, statusCounts: statusCounts({ working: 3 }) });
    applyAgentStatusChange([session], statusEvent());
    // What a refetch hands the board: plain server summaries. The memory is a
    // claim about the snapshot the moves were applied to, and that snapshot is
    // gone, so the claim goes with it.
    const refetched = sessionSummary({
      agentCount: 3,
      statusCounts: statusCounts({ working: 2, completed: 1 }),
    });
    const afterRefetch = applyAgentStatusChange([refetched], statusEvent());

    // This is the deliberate cost of the boundary. A refetch is the moment the
    // server's truth supersedes anything the client remembered: the summary
    // carries counts, never which agent sits in which bucket, so the board
    // cannot tell this frame from a real transition that happened after the
    // fetch. Re-applying a stale frame is repaired by the next refetch;
    // suppressing a real one with a memory that outlived its row would leave an
    // agent frozen in the wrong bucket with nothing to correct it.
    expect(afterRefetch.matched).toBe(true);
    expect(afterRefetch.sessions[0]!.statusCounts).toEqual(
      statusCounts({ working: 1, completed: 2 }),
    );
  });

  it('remembers nothing from a move it refused', () => {
    // The refusal left the row alone, so there is no applied move to remember.
    // A frame this snapshot could not absorb must never become the reason a
    // later, supportable frame for the same agent is dropped.
    const session = sessionSummary({ agentCount: 3, statusCounts: statusCounts({ working: 1 }) });
    const refused = applyAgentStatusChange([session], statusEvent({ previousStatus: 'error' }));
    expect(refused.matched).toBe(false);

    const applied = applyAgentStatusChange(refused.sessions, statusEvent());
    expect(applied.matched).toBe(true);
    expect(applied.sessions[0]!.statusCounts).toEqual(statusCounts({ completed: 1 }));
  });
});

describe('applyAgentStatusChange under frames that contradict an applied move (LV-8)', () => {
  it('refuses a frame whose previousStatus is not where this board put the agent', () => {
    // The board applied `agent-child`: working -> completed. The next frame for
    // that agent says it was WORKING, so the stream lost whatever moved it back
    // out of `completed` and this row is behind.
    const session = sessionSummary({
      agentCount: 3,
      statusCounts: statusCounts({ working: 2, completed: 1 }),
    });
    const applied = applyAgentStatusChange([session], statusEvent());
    expect(applied.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 1, completed: 2 }));

    const contradicted = applyAgentStatusChange(
      applied.sessions,
      statusEvent({ previousStatus: 'working', status: 'error' }),
    );

    // Before LV-8 this was applied: the `working` bucket was non-empty, so it
    // was decremented and `error` incremented - and the agent standing in that
    // bucket was not `agent-child` at all. One agent's stale transition was
    // rendered as a different agent's failure, in a session where nothing else
    // had gone wrong.
    expect(contradicted.matched).toBe(false);
    expect(contradicted.sessions).toBe(applied.sessions);
    expect(contradicted.sessions[0]!.statusCounts).toEqual(
      statusCounts({ working: 1, completed: 2 }),
    );
    expect(livePatchCount(contradicted.sessions[0]!)).toBe(1);
  });

  it('refuses a redelivered first sighting once the agent has moved on', () => {
    // Two placed agents in a FOUR-agent session, so LV-4's ceiling has room and
    // cannot see this one; and the agent is no longer where the redelivered
    // frame puts it, so LV-7 does not absorb it either.
    const session = sessionSummary({ agentCount: 4, statusCounts: statusCounts({ working: 2 }) });
    const seen = applyAgentStatusChange(
      [session],
      statusEvent({ previousStatus: null, status: 'working' }),
    );
    const done = applyAgentStatusChange(seen.sessions, statusEvent());
    expect(done.sessions[0]!.statusCounts).toEqual(statusCounts({ working: 2, completed: 1 }));

    const redelivered = applyAgentStatusChange(
      done.sessions,
      statusEvent({ previousStatus: null, status: 'working' }),
    );

    // Before LV-8 this counted a fourth placed agent into a session that has
    // only ever had three: a first sighting grows the bucket total, and the
    // frame claims the agent had no status at all when this board had already
    // moved it twice.
    expect(redelivered.matched).toBe(false);
    expect(redelivered.sessions[0]!.statusCounts).toEqual(
      statusCounts({ working: 2, completed: 1 }),
    );
    expect(livePatchCount(redelivered.sessions[0]!)).toBe(2);
  });
});
