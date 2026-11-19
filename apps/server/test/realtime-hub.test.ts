import { describe, expect, it } from 'vitest';
import {
  formatFrameId,
  newBootId,
  parseLastEventId,
  RealtimeHub,
  serializeSseFrame,
  type RealtimeEvent,
  type ResumePoint,
} from '../src/realtime/hub';

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
    const frame = serializeSseFrame(ingestedEvent, 'b00t-7');
    expect(frame.startsWith('id: b00t-7\nevent: session-ingested\ndata: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const dataLine = frame.split('\n')[2]!;
    expect(JSON.parse(dataLine.slice('data: '.length))).toEqual(ingestedEvent);
  });

  it('keeps data on ONE line even when the event contains newlines', () => {
    // The ingest reason is sanitized upstream, but the serializer must not
    // depend on that: a newline inside any string field stays JSON-escaped.
    const frame = serializeSseFrame(
      { ...ingestFailedEvent, payload: { ...ingestFailedEvent.payload, reason: 'line1\nline2' } },
      'b00t-1',
    );
    // 5 lines total: id, event, data, and the two trailing empties.
    expect(frame.split('\n')).toHaveLength(5);
  });

  it('collapses CR/LF in a hostile event type so it cannot inject SSE fields', () => {
    // No arm of the closed union has such a `type`; this is the defence-in-depth
    // path for a value that escaped the type system.
    const frame = serializeSseFrame(offUnion({ type: 'evil\r\ninjected', payload: {} }), 'b00t-2');
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
    const hub = new RealtimeHub({ bootId: 'b00t' });
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame));
    expect(hub.publish(ingestedEvent)).toBe(1);
    expect(hub.publish(ingestFailedEvent)).toBe(2);
    expect(frames[0]).toContain('id: b00t-1\n');
    expect(frames[1]).toContain('id: b00t-2\n');
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
    frames.map((frame) => Number(/^id: b00t-(\d+)\n/.exec(frame)?.[1]));
  /** A resume point of the hub under test (boot id `b00t`). */
  const at = (seq: number): ResumePoint => ({ bootId: 'b00t', seq });

  function publishN(hub: RealtimeHub, n: number): void {
    for (let i = 0; i < n; i += 1) hub.publish(ingestedEvent);
  }

  it('replays the frames after the given id, in order, then continues live', () => {
    const hub = new RealtimeHub({ bootId: 'b00t' });
    publishN(hub, 5);
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame), at(2));
    expect(idsOf(frames)).toEqual([3, 4, 5]);
    hub.publish(ingestedFailedLike());
    expect(idsOf(frames)).toEqual([3, 4, 5, 6]);
  });

  it('replays nothing without an id, or for an id already current', () => {
    const hub = new RealtimeHub({ bootId: 'b00t' });
    publishN(hub, 3);
    const fresh: string[] = [];
    const current: string[] = [];
    hub.subscribe((frame) => fresh.push(frame));
    hub.subscribe((frame) => current.push(frame), at(3));
    expect(fresh).toEqual([]);
    expect(current).toEqual([]);
  });

  it('replays nothing for an id of this process beyond its newest frame', () => {
    const hub = new RealtimeHub({ bootId: 'b00t' });
    publishN(hub, 3);
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame), at(40));
    expect(frames).toEqual([]);
    hub.publish(ingestedEvent);
    expect(idsOf(frames)).toEqual([4]);
  });

  /**
   * ARC-7 (2026-11-19). Ids used to restart at 1 with nothing saying which
   * process issued them: an id from before a restart that fell inside the new
   * process's range replayed only the frames after it, and the frames before
   * it were lost with no gap to show for it.
   */
  it('replays the whole buffer for an id of another process, wherever its number falls', () => {
    const hub = new RealtimeHub({ bootId: 'b00t' });
    publishN(hub, 5);
    for (const resume of [
      { bootId: 'earlier', seq: 3 }, // inside this process's range
      { bootId: 'earlier', seq: 900 }, // beyond it
      { bootId: null, seq: 2 }, // a bare number from a server before ARC-7
    ]) {
      const frames: string[] = [];
      hub.subscribe((frame) => frames.push(frame), resume);
      expect(idsOf(frames), JSON.stringify(resume)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('keeps only the newest frames: an older id is replayed what is left', () => {
    const hub = new RealtimeHub({ replayCapacity: 2, bootId: 'b00t' });
    publishN(hub, 5);
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame), at(0));
    // Frames 1-3 have left the buffer; the client sees 4 after its 0, a gap the
    // dashboard's id-sequence check already counts and discloses.
    expect(idsOf(frames)).toEqual([4, 5]);
  });

  it('replays nothing with a zero capacity, and refuses an invalid one', () => {
    const hub = new RealtimeHub({ replayCapacity: 0, bootId: 'b00t' });
    publishN(hub, 3);
    const frames: string[] = [];
    hub.subscribe((frame) => frames.push(frame), at(1));
    expect(frames).toEqual([]);
    expect(() => new RealtimeHub({ replayCapacity: -1 })).toThrow(RangeError);
    expect(() => new RealtimeHub({ replayCapacity: 1.5 })).toThrow(RangeError);
  });

  it('drops a writer that throws during replay: counted, never subscribed', () => {
    const hub = new RealtimeHub({ bootId: 'b00t' });
    publishN(hub, 2);
    let calls = 0;
    const unsubscribe = hub.subscribe(() => {
      calls += 1;
      throw new Error('socket gone');
    }, at(0));
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

describe('frame ids carry a boot id (ARC-7)', () => {
  it('formats and parses `<bootId>-<seq>`, and reads a bare number as a pre-ARC-7 id', () => {
    expect(formatFrameId('b00t', 42)).toBe('b00t-42');
    expect(parseLastEventId('b00t-42')).toEqual({ bootId: 'b00t', seq: 42 });
    expect(parseLastEventId('0123456789abcdef-0')).toEqual({
      bootId: '0123456789abcdef',
      seq: 0,
    });
    expect(parseLastEventId('42')).toEqual({ bootId: null, seq: 42 });
    expect(parseLastEventId('0')).toEqual({ bootId: null, seq: 0 });
  });

  it('refuses anything else, so an unreadable header replays nothing', () => {
    for (const header of [
      undefined,
      '',
      '-1',
      '1.5',
      'abc',
      'B00T-1', // upper case is never issued
      'b00t-',
      '-7',
      'b00t-1-2',
      '0123456789abcdefg-1', // 17-character boot id
      'b00t-1234567890123456', // 16-digit sequence
      '9'.repeat(16),
      'b00t-1\nevent: x',
    ]) {
      expect(parseLastEventId(header), String(header)).toBeUndefined();
    }
    expect(parseLastEventId(['b00t-1', 'b00t-2'])).toBeUndefined();
  });

  it('gives every hub a fresh random boot id unless one is pinned', () => {
    expect(newBootId()).toMatch(/^[0-9a-f]{12}$/);
    const a = new RealtimeHub();
    const b = new RealtimeHub();
    expect(a.bootId).toMatch(/^[0-9a-f]{12}$/);
    expect(a.bootId).not.toBe(b.bootId);
    const frames: string[] = [];
    a.subscribe((frame) => frames.push(frame));
    a.publish(ingestedEvent);
    expect(frames[0]?.startsWith(`id: ${a.bootId}-1\n`)).toBe(true);
    expect(new RealtimeHub({ bootId: 'pinned' }).bootId).toBe('pinned');
  });

  it('refuses a boot id that could break the id line or its separator', () => {
    for (const bootId of ['', 'UPPER', 'has-dash', 'a\nb', 'x'.repeat(17)]) {
      expect(() => new RealtimeHub({ bootId }), JSON.stringify(bootId)).toThrow(RangeError);
    }
  });
});
