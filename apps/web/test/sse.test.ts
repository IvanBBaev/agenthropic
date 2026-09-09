/**
 * Unit tests for the SSE client wrapper: typed-event routing, JSON parsing,
 * silent tolerance of unknown types and malformed payloads, and the
 * connecting/open/reconnecting/closed state machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_EVENT_TYPES as SHARED_EVENT_TYPES } from '../../../packages/shared/src/realtime/event-types';
import {
  createSseClient,
  SERVER_EVENT_TYPES,
  type SseConnectionState,
  type SseEvent,
  type SseFrameGap,
} from '../src/sse';
import { MockEventSource } from './mock-event-source';

beforeEach(() => {
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSseClient', () => {
  it('connects to /api/stream with the token URL-encoded in the query', () => {
    createSseClient('se cret+/=');
    expect(MockEventSource.latest().url).toBe('/api/stream?token=se%20cret%2B%2F%3D');
  });

  it('starts in the connecting state and reports it immediately on subscribe', () => {
    const client = createSseClient('t');
    expect(client.state).toBe('connecting');
    const seen: SseConnectionState[] = [];
    client.onStateChange((state) => seen.push(state));
    expect(seen).toEqual(['connecting']);
  });

  it('walks connecting -> open -> reconnecting -> open and notifies once per change', () => {
    const client = createSseClient('t');
    const seen: SseConnectionState[] = [];
    client.onStateChange((state) => seen.push(state));
    const source = MockEventSource.latest();

    source.open();
    source.fail();
    source.fail(); // duplicate error while already reconnecting: no extra notification
    source.open();

    expect(seen).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    expect(client.state).toBe('open');
  });

  it('reports closed after a fatal (non-retryable) error', () => {
    const client = createSseClient('t');
    MockEventSource.latest().fail({ fatal: true });
    expect(client.state).toBe('closed');
  });

  // SH-2. Deliberate, and load-bearing. A first attempt that never landed is
  // reported as `reconnecting` even though this client has never been open. The
  // word is wrong for a reader and the Shell chip corrects it there; the STATE
  // stays conservative on purpose, because LiveView reads anything other than
  // `open` as "the feed was interrupted" and refetches the board on the next
  // open. Narrow it here and a board fetched before the stream ever existed
  // keeps whatever it had, with nothing on screen to say the frames in between
  // are gone. Pinned so that the wording fix cannot migrate down into this
  // layer, where it would cost data rather than a word.
  it('reports a failed first attempt as reconnecting, which downstream reads as a gap', () => {
    const client = createSseClient('t');
    MockEventSource.latest().fail();
    expect(client.state).toBe('reconnecting');
  });

  it('routes a typed event to its subscriber with the JSON payload parsed', () => {
    const client = createSseClient('t');
    const events: SseEvent<{ id: number }>[] = [];
    client.subscribe<{ id: number }>('agent-updated', (event) => events.push(event));

    MockEventSource.latest().emit('agent-updated', { id: 7 });

    expect(events).toEqual([{ type: 'agent-updated', data: { id: 7 } }]);
  });

  it('supports multiple subscribers per type and unsubscribing one of them', () => {
    const client = createSseClient('t');
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = client.subscribe('tick', first);
    client.subscribe('tick', second);

    MockEventSource.latest().emit('tick', { n: 1 });
    offFirst();
    MockEventSource.latest().emit('tick', { n: 2 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('delivers subscribed types and default messages to onAnyEvent', () => {
    const client = createSseClient('t');
    client.subscribe('typed', () => {});
    const seen: SseEvent[] = [];
    client.onAnyEvent((event) => seen.push(event));

    MockEventSource.latest().emit('typed', { a: 1 });
    MockEventSource.latest().emit('message', { b: 2 });

    expect(seen).toEqual([
      { type: 'typed', data: { a: 1 } },
      { type: 'message', data: { b: 2 } },
    ]);
  });

  it('registers knownEventTypes eagerly so onAnyEvent sees them without subscribe', () => {
    const client = createSseClient('t', { knownEventTypes: ['session-started'] });
    const any = vi.fn();
    client.onAnyEvent(any);

    MockEventSource.latest().emit('session-started', { id: 'abc' });

    expect(any).toHaveBeenCalledWith({ type: 'session-started', data: { id: 'abc' } });
  });

  it('re-exports the shared event-type list itself, not a hand-copied mirror', () => {
    // The mirror drifted once (`ingest-failed` published but never registered,
    // so EventSource dropped every quarantine notice unheard); identity with
    // the shared list makes that drift impossible.
    expect(SERVER_EVENT_TYPES).toBe(SHARED_EVENT_TYPES);
  });

  it('eagerly registers every shared server event type, ingest-failed included', () => {
    const client = createSseClient('t');
    const seen: string[] = [];
    client.onAnyEvent((event) => seen.push(event.type));

    for (const type of SERVER_EVENT_TYPES) {
      MockEventSource.latest().emit(type, { type });
    }

    expect(seen).toEqual([...SERVER_EVENT_TYPES]);
  });

  it('silently ignores event types nobody registered', () => {
    const client = createSseClient('t');
    const any = vi.fn();
    client.onAnyEvent(any);

    MockEventSource.latest().emit('never-registered', { x: 1 });

    expect(any).not.toHaveBeenCalled();
  });

  // AMENDED 2026-09-02: the two tests below keep their original names and their
  // original assertions - no subscriber is called, which is still true and is
  // still the contract. The word "silently" in each name is now wrong: the
  // frame is dropped but counted and reported. The names are left standing
  // rather than rewritten, and the counting is asserted in its own test below,
  // so the amendment adds a fact instead of erasing the record of what the
  // behaviour used to be.
  it('silently drops frames whose data is not valid JSON', () => {
    const client = createSseClient('t');
    const handler = vi.fn();
    client.subscribe('typed', handler);

    MockEventSource.latest().emit('typed', 'not json {');

    expect(handler).not.toHaveBeenCalled();
  });

  it('silently drops frames whose data is not a string at all', () => {
    const client = createSseClient('t');
    const handler = vi.fn();
    const any = vi.fn();
    client.subscribe('typed', handler);
    client.onAnyEvent(any);

    // A conforming server always sends text; a structured-clone payload is not
    // parsed into an event, it is dropped.
    MockEventSource.latest().emitRaw('typed', { id: 7 });
    MockEventSource.latest().emitRaw('typed', null);

    expect(handler).not.toHaveBeenCalled();
    expect(any).not.toHaveBeenCalled();
  });

  it('counts and reports every frame it could not read, with the reason', () => {
    const client = createSseClient('t');
    const drops = vi.fn();
    const any = vi.fn();
    client.onFrameDropped(drops);
    client.onAnyEvent(any);
    expect(client.droppedFrames).toBe(0);

    MockEventSource.latest().emit('ingest-failed', 'truncated {"sessionId":');
    MockEventSource.latest().emitRaw('agent-status-changed', { id: 7 });

    // The TYPE survives even when the body does not, which is most of what a
    // bug report needs: an unreadable `ingest-failed` means a session is
    // missing from every view with nothing on screen to say so.
    expect(drops.mock.calls.map(([drop]) => drop)).toEqual([
      { type: 'ingest-failed', reason: 'unparseable', total: 1 },
      { type: 'agent-status-changed', reason: 'not-a-string', total: 2 },
    ]);
    expect(client.droppedFrames).toBe(2);
    // Still not delivered - there is no object to deliver. The point is that
    // the loss is now observable, not that it stopped being a loss.
    expect(any).not.toHaveBeenCalled();
  });

  it('stops reporting drops after unsubscribe, and keeps counting them', () => {
    const client = createSseClient('t');
    const drops = vi.fn();
    const unsubscribe = client.onFrameDropped(drops);
    // `message` is the one type registered unconditionally; an unregistered
    // type never reaches dispatch at all, so it could not be dropped by it.
    MockEventSource.latest().emit('message', 'nope {');
    unsubscribe();
    MockEventSource.latest().emit('message', 'nope {');

    expect(drops).toHaveBeenCalledTimes(1);
    // The tally belongs to the connection, not to whoever happens to be
    // watching it: a component that unmounts must not un-lose a frame.
    expect(client.droppedFrames).toBe(2);
  });

  it('leaves a readable frame out of the drop count entirely', () => {
    const client = createSseClient('t');
    const drops = vi.fn();
    const handler = vi.fn();
    client.onFrameDropped(drops);
    client.subscribe('typed', handler);

    MockEventSource.latest().emit('typed', { ok: true });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(drops).not.toHaveBeenCalled();
    expect(client.droppedFrames).toBe(0);
  });

  it('supports unsubscribing onAnyEvent and onStateChange', () => {
    const client = createSseClient('t');
    const any = vi.fn();
    const state = vi.fn();
    const offAny = client.onAnyEvent(any);
    const offState = client.onStateChange(state);
    offAny();
    offState();

    MockEventSource.latest().emit('message', { a: 1 });
    MockEventSource.latest().open();

    expect(any).not.toHaveBeenCalled();
    expect(state).toHaveBeenCalledTimes(1); // only the immediate initial call
  });

  it('close() closes the underlying EventSource and reports closed once', () => {
    const client = createSseClient('t');
    const seen: SseConnectionState[] = [];
    client.onStateChange((state) => seen.push(state));

    client.close();
    client.close();

    expect(MockEventSource.latest().closed).toBe(true);
    expect(client.state).toBe('closed');
    expect(seen).toEqual(['connecting', 'closed']);
  });
});

/**
 * AMENDED 2026-09-03 (LV-2): the wrapper used to read only `data` off a frame
 * and throw the rest away, including the server's frame number.
 *
 * apps/server/src/realtime/hub.ts writes `id: <n>` on every frame from a
 * monotonic counter and keeps NO replay buffer. That number is therefore the
 * only evidence a tab can have that frames were published while it was not
 * listening - and it matters most for `ingest-failed`, because a quarantined
 * session never reaches the read API, so no refetch can recover a failure
 * notice lost in a gap: it is gone for the life of the tab.
 *
 * The gap channel counts what the sequence proves was missed. It does not, and
 * cannot, recover the frames themselves.
 */
describe('createSseClient frame-sequence gaps (LV-2)', () => {
  it('counts the frames the server numbered and this tab never received', () => {
    const client = createSseClient('t');
    const gaps: SseFrameGap[] = [];
    client.onFrameGap((gap) => gaps.push(gap));
    expect(client.missedFrames).toBe(0);

    MockEventSource.latest().emit('message', { n: 1 }, { id: '1' });
    MockEventSource.latest().emit('message', { n: 5 }, { id: '5' });

    expect(gaps).toEqual([{ from: 2, to: 4, missed: 3, total: 3 }]);
    expect(client.missedFrames).toBe(3);
  });

  it('reports a single missed frame as the one id it was', () => {
    const client = createSseClient('t');
    const gaps: SseFrameGap[] = [];
    client.onFrameGap((gap) => gaps.push(gap));

    MockEventSource.latest().emit('message', { n: 1 }, { id: '1' });
    MockEventSource.latest().emit('message', { n: 3 }, { id: '3' });

    expect(gaps).toEqual([{ from: 2, to: 2, missed: 1, total: 1 }]);
  });

  it('accumulates across several gaps', () => {
    const client = createSseClient('t');
    const gaps: SseFrameGap[] = [];
    client.onFrameGap((gap) => gaps.push(gap));

    MockEventSource.latest().emit('message', {}, { id: '1' });
    MockEventSource.latest().emit('message', {}, { id: '3' });
    MockEventSource.latest().emit('message', {}, { id: '9' });

    expect(gaps.map((gap) => gap.missed)).toEqual([1, 5]);
    expect(client.missedFrames).toBe(6);
  });

  it('reports no gap for a contiguous, repeated or restarted sequence', () => {
    const client = createSseClient('t');
    const gaps = vi.fn();
    client.onFrameGap(gaps);
    const source = MockEventSource.latest();

    source.emit('message', {}, { id: '1' });
    source.emit('message', {}, { id: '2' });
    // A redelivered frame is not a gap.
    source.emit('message', {}, { id: '2' });
    // A frame carrying no id at all inherits the last one - also not a gap.
    source.emit('message', {});
    // A restarted server numbers from 1 again; that is a smaller id, not a
    // missed range, and counting it as one would invent losses out of a
    // restart.
    source.emit('message', {}, { id: '1' });
    source.emit('message', {}, { id: '2' });

    expect(gaps).not.toHaveBeenCalled();
    expect(client.missedFrames).toBe(0);
  });

  it('ignores an id it cannot compare instead of guessing a gap from it', () => {
    const client = createSseClient('t');
    const gaps = vi.fn();
    client.onFrameGap(gaps);
    const source = MockEventSource.latest();

    source.emit('message', {}, { id: '1' });
    source.emit('message', {}, { id: 'not-a-number' });
    // The comparable sequence continues from 1, so this is contiguous.
    source.emit('message', {}, { id: '2' });

    expect(gaps).not.toHaveBeenCalled();
    expect(client.missedFrames).toBe(0);
  });

  it('detects a gap around a frame it could not read, and counts both losses', () => {
    const client = createSseClient('t');
    const gaps: SseFrameGap[] = [];
    const drops = vi.fn();
    client.onFrameGap((gap) => gaps.push(gap));
    client.onFrameDropped(drops);

    MockEventSource.latest().emit('ingest-failed', { ok: true }, { id: '1' });
    MockEventSource.latest().emit('ingest-failed', 'truncated {', { id: '4' });

    // Two different losses: two frames never arrived, and one arrived
    // unreadable. Folding them into one number would understate the first.
    expect(gaps).toEqual([{ from: 2, to: 3, missed: 2, total: 2 }]);
    expect(client.droppedFrames).toBe(1);
  });

  it('stops reporting gaps after unsubscribe, and keeps counting them', () => {
    const client = createSseClient('t');
    const gaps = vi.fn();
    const unsubscribe = client.onFrameGap(gaps);

    MockEventSource.latest().emit('message', {}, { id: '2' });
    MockEventSource.latest().emit('message', {}, { id: '4' });
    unsubscribe();
    MockEventSource.latest().emit('message', {}, { id: '6' });

    expect(gaps).toHaveBeenCalledTimes(1);
    // The tally belongs to the connection, not to whoever is watching it.
    expect(client.missedFrames).toBe(2);
  });
});

/**
 * AMENDED 2026-09-03 (LV-5): F-12 made an unreadable PAYLOAD observable, but a
 * readable frame could still vanish one layer later - a subscriber that threw
 * aborted the dispatch loop, so every later subscriber of that type, and every
 * onAnyEvent observer (including anything that would notice the loss), never
 * saw the frame. Nothing counted it. Same class of defect, different layer.
 */
describe('createSseClient subscriber failure (LV-5)', () => {
  it('delivers a frame to the remaining subscribers when one of them throws', () => {
    const client = createSseClient('t');
    const later = vi.fn();
    const any = vi.fn();
    client.subscribe('typed', () => {
      throw new Error('subscriber exploded');
    });
    client.subscribe('typed', later);
    client.onAnyEvent(any);

    MockEventSource.latest().emit('typed', { id: 7 });

    expect(later).toHaveBeenCalledWith({ type: 'typed', data: { id: 7 } });
    expect(any).toHaveBeenCalledWith({ type: 'typed', data: { id: 7 } });
  });

  it('counts a subscriber failure as a frame this client could not absorb', () => {
    const client = createSseClient('t');
    const drops = vi.fn();
    client.onFrameDropped(drops);
    client.onAnyEvent(() => {
      throw new Error('observer exploded');
    });

    MockEventSource.latest().emit('message', { a: 1 });

    expect(drops).toHaveBeenCalledWith({
      type: 'message',
      reason: 'handler-failed',
      total: 1,
    });
    expect(client.droppedFrames).toBe(1);
  });
});
