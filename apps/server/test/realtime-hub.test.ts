import { describe, expect, it } from 'vitest';
import { RealtimeHub, serializeSseFrame, type RealtimeEvent } from '../src/realtime/hub';

const ingestedEvent: RealtimeEvent = {
  type: 'session-ingested',
  sessionId: 'session-1',
  projectSlug: 'demo',
  agentCount: 3,
  edgesInserted: 2,
  usageRowsInserted: 40,
  costUsd: 0.12,
  occurredAt: '2026-07-11T00:00:00Z',
};

const ingestFailedEvent: RealtimeEvent = {
  type: 'ingest-failed',
  payload: {
    sessionId: 'session-2',
    reason: 'parse error at record 3',
    attempt: 1,
    willRetry: true,
    occurredAt: '2026-07-11T00:00:01Z',
  },
};

/**
 * A value the closed union can never produce - a hostile `type`, an unknown
 * shape. The serializer's guards are defence in depth against exactly the
 * thing the type system already forbids, so the only way to exercise them is
 * to step outside it on purpose. Kept in one place so the cast is visible.
 */
function offUnion(value: unknown): RealtimeEvent {
  return value as RealtimeEvent;
}

describe('serializeSseFrame (WP-U1)', () => {
  it('produces an id/event/data frame whose data line round-trips as JSON', () => {
    const frame = serializeSseFrame(ingestedEvent, 7);
    expect(frame.startsWith('id: 7\nevent: session-ingested\ndata: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const dataLine = frame.split('\n')[2]!;
    expect(JSON.parse(dataLine.slice('data: '.length))).toEqual(ingestedEvent);
  });

  it('keeps data on ONE line even when the event contains newlines', () => {
    // The ingest reason is sanitized upstream, but the serializer must not
    // depend on that: a newline inside any string field stays JSON-escaped.
    const frame = serializeSseFrame(
      { ...ingestFailedEvent, payload: { ...ingestFailedEvent.payload, reason: 'line1\nline2' } },
      1,
    );
    // 5 lines total: id, event, data, and the two trailing empties.
    expect(frame.split('\n')).toHaveLength(5);
  });

  it('collapses CR/LF in a hostile event type so it cannot inject SSE fields', () => {
    // No arm of the closed union has such a `type`; this is the defence-in-depth
    // path for a value that escaped the type system.
    const frame = serializeSseFrame(offUnion({ type: 'evil\r\ninjected', payload: {} }), 2);
    expect(frame).toContain('event: evil injected\n');
    expect(frame).not.toContain('\ninjected');
  });
});

describe('RealtimeHub (WP-U1)', () => {
  it('fans one published event out to every subscriber', () => {
    const hub = new RealtimeHub();
    const framesA: string[] = [];
    const framesB: string[] = [];
    hub.subscribe((frame) => framesA.push(frame));
    hub.subscribe((frame) => framesB.push(frame));

    const id = hub.publish(ingestedEvent);

    expect(id).toBe(1);
    expect(framesA).toHaveLength(1);
    expect(framesB).toHaveLength(1);
    expect(framesA[0]).toBe(framesB[0]);
    expect(framesA[0]).toContain('event: session-ingested');
  });

  it('assigns strictly increasing frame ids across publishes', () => {
    const hub = new RealtimeHub();
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame));
    expect(hub.publish(ingestedEvent)).toBe(1);
    expect(hub.publish(ingestFailedEvent)).toBe(2);
    expect(frames[0]).toContain('id: 1\n');
    expect(frames[1]).toContain('id: 2\n');
  });

  it('unsubscribe removes the writer and is idempotent', () => {
    const hub = new RealtimeHub();
    const frames: string[] = [];
    const unsubscribe = hub.subscribe((frame) => frames.push(frame));
    expect(hub.subscriberCount).toBe(1);

    unsubscribe();
    unsubscribe(); // second call is a no-op, never a throw
    expect(hub.subscriberCount).toBe(0);

    hub.publish(ingestedEvent);
    expect(frames).toHaveLength(0);
  });

  it('drops a throwing writer without breaking fan-out to healthy ones', () => {
    const hub = new RealtimeHub();
    let broken = 0;
    const healthy: string[] = [];
    hub.subscribe(() => {
      broken += 1;
      throw new Error('dead socket');
    });
    hub.subscribe((frame) => healthy.push(frame));

    hub.publish(ingestedEvent);
    expect(broken).toBe(1);
    expect(healthy).toHaveLength(1);
    expect(hub.subscriberCount).toBe(1);

    hub.publish({
      type: 'agent-status-changed',
      sessionId: 's',
      agentId: 'a',
      status: 'completed',
      previousStatus: 'working',
      occurredAt: '2026-07-11T00:00:00Z',
    });
    expect(broken).toBe(1); // the dead writer was dropped after its throw
    expect(healthy).toHaveLength(2);
  });

  it('counts every dropped writer so a drop is observable, not silent', () => {
    const hub = new RealtimeHub();
    expect(hub.droppedSubscribers).toBe(0);
    hub.subscribe(() => {
      throw new Error('dead socket a');
    });
    hub.subscribe(() => {
      throw new Error('dead socket b');
    });
    const healthy: string[] = [];
    hub.subscribe((frame) => healthy.push(frame));

    hub.publish(ingestedEvent);
    expect(hub.droppedSubscribers).toBe(2);
    expect(hub.subscriberCount).toBe(1);

    // A dropped writer is gone: it is not counted twice on the next publish.
    hub.publish(ingestedEvent);
    expect(hub.droppedSubscribers).toBe(2);
    expect(healthy).toHaveLength(2);
  });

  it('an ordinary unsubscribe is not counted as a drop', () => {
    const hub = new RealtimeHub();
    const unsubscribe = hub.subscribe(() => undefined);
    unsubscribe();
    hub.publish(ingestedEvent);
    expect(hub.droppedSubscribers).toBe(0);
  });
});

/**
 * WP-U1 "resumable" (added 2026-09-26). Until then the hub kept nothing, so a
 * client that reconnected - EventSource does so on its own, sending the last id
 * it saw as `Last-Event-ID` - lost every frame published in between.
 */
describe('RealtimeHub resumption from Last-Event-ID (WP-U1)', () => {
  const idsOf = (frames: readonly string[]): number[] =>
    frames.map((frame) => Number(/^id: (\d+)\n/.exec(frame)?.[1]));

  function publishN(hub: RealtimeHub, n: number): void {
    for (let i = 0; i < n; i += 1) hub.publish(ingestedEvent);
  }

  it('replays the frames after the given id, in order, then continues live', () => {
    const hub = new RealtimeHub();
    publishN(hub, 5);
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame), 2);
    expect(idsOf(frames)).toEqual([3, 4, 5]);
    hub.publish(ingestedFailedLike());
    expect(idsOf(frames)).toEqual([3, 4, 5, 6]);
  });

  it('replays nothing without an id, or for an id already current', () => {
    const hub = new RealtimeHub();
    publishN(hub, 3);
    const fresh: string[] = [];
    const current: string[] = [];
    hub.subscribe((frame) => fresh.push(frame));
    hub.subscribe((frame) => current.push(frame), 3);
    expect(fresh).toEqual([]);
    expect(current).toEqual([]);
  });

  it('replays nothing for an id beyond this hub, e.g. one from before a restart', () => {
    // A restarted server numbers from 1 again, so a client may come back with an
    // id this process has not reached; no buffered frame is larger, so nothing
    // is replayed and live frames continue. (An old id INSIDE this process's
    // range cannot be recognised at all - see the note on `subscribe`.)
    const hub = new RealtimeHub();
    publishN(hub, 3);
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame), 40);
    expect(frames).toEqual([]);
    hub.publish(ingestedEvent);
    expect(idsOf(frames)).toEqual([4]);
  });

  it('keeps only the newest frames: an older id is replayed what is left', () => {
    const hub = new RealtimeHub({ replayCapacity: 2 });
    publishN(hub, 5);
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame), 0);
    // Frames 1-3 have left the buffer; the client sees 4 after its 0, a gap the
    // dashboard's id-sequence check already counts and discloses.
    expect(idsOf(frames)).toEqual([4, 5]);
  });

  it('replays nothing with a zero capacity, and refuses an invalid one', () => {
    const hub = new RealtimeHub({ replayCapacity: 0 });
    publishN(hub, 3);
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame), 1);
    expect(frames).toEqual([]);
    expect(() => new RealtimeHub({ replayCapacity: -1 })).toThrow(RangeError);
    expect(() => new RealtimeHub({ replayCapacity: 1.5 })).toThrow(RangeError);
  });

  it('drops a writer that throws during replay: counted, never subscribed', () => {
    const hub = new RealtimeHub();
    publishN(hub, 2);
    let calls = 0;
    const unsubscribe = hub.subscribe(() => {
      calls += 1;
      throw new Error('socket gone');
    }, 0);
    expect(calls).toBe(1);
    expect(hub.droppedSubscribers).toBe(1);
    expect(hub.subscriberCount).toBe(0);
    hub.publish(ingestedEvent);
    expect(calls).toBe(1);
    unsubscribe(); // a no-op, and safe to call
    expect(hub.subscriberCount).toBe(0);
  });
});

function ingestedFailedLike(): RealtimeEvent {
  return ingestFailedEvent;
}
