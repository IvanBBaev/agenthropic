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
