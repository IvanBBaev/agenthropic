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

  /**
   * AMENDED 2026-09-09 (L3, D6): the second `fail()` was pinned here as "no
   * extra notification", and that is no longer true - it notifies, carrying
   * `attempt 2`. The premise the assertion rested on (the state WORD had not
   * changed, so nothing had) is exactly what D6 removed.
   *
   * The durable guarantee the test was defending survives and is what it now
   * asserts: the machine walks connecting -> open -> reconnecting -> open and
   * a duplicate error invents no state that did not happen. The name is kept -
   * a notification still marks a change - and the count that makes the
   * duplicate worth announcing is pinned beside it.
   */
  it('walks connecting -> open -> reconnecting -> open and notifies once per change', () => {
    const client = createSseClient('t');
    const seen: [SseConnectionState, number][] = [];
    client.onStateChange((state, attempts) => seen.push([state, attempts]));
    const source = MockEventSource.latest();

    source.open();
    source.fail();
    source.fail(); // duplicate error: the same state word, a new attempt number
    source.open();

    expect(seen).toEqual([
      ['connecting', 0],
      ['open', 0],
      ['reconnecting', 1],
      ['reconnecting', 2],
      ['open', 0],
    ]);
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
 * listening - and it matters most for `ingest-failed`, because no refetch can
 * recover a failure notice lost in a gap: it is gone for the life of the tab.
 *
 * AMENDED 2026-09-23 (coverage-claim): the clause "because a quarantined
 * session never reaches the read API" was carrying that argument and was not
 * true. Such a session does reach it when it ingested before it began failing,
 * at the extent of its last good pass and unmarked. The conclusion stands and
 * is stronger: the refetch does not merely omit the failure, it shows a
 * session that looks current.
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

  it('counts a frame once however many of its handlers throw', () => {
    // One frame, two failing handlers: the frame was still ONE frame, and a
    // tally of two would report a loss that never happened.
    const client = createSseClient('t');
    const drops = vi.fn();
    const later = vi.fn();
    client.onFrameDropped(drops);
    client.subscribe('message', () => {
      throw new Error('typed subscriber exploded');
    });
    client.subscribe('message', later);
    client.onAnyEvent(() => {
      throw new Error('observer exploded');
    });

    MockEventSource.latest().emit('message', { a: 1 });

    expect(later).toHaveBeenCalledWith({ type: 'message', data: { a: 1 } });
    expect(drops).toHaveBeenCalledTimes(1);
    expect(drops).toHaveBeenCalledWith({ type: 'message', reason: 'handler-failed', total: 1 });
    expect(client.droppedFrames).toBe(1);
  });

  /**
   * K3 (2026-09-23): the same defect class as LV-5, one layer further out.
   * `deliver` isolated the EVENT fan-out, but the three NOTIFICATION fan-outs
   * around it - state, dropped-frame and gap - were bare loops. The gap loop is
   * the expensive one: `noteFrameId` runs before `dispatch` on every frame, so
   * a throwing `onFrameGap` subscriber propagated out of the listener and
   * `dispatch` never ran at all. The frame reached nobody, and nothing recorded
   * that it had not.
   */
  it('still delivers the frame when a gap subscriber throws', () => {
    const client = createSseClient('t');
    const events = vi.fn();
    client.onFrameGap(() => {
      throw new Error('gap subscriber exploded');
    });
    client.subscribe('message', events);

    MockEventSource.latest().emit('message', { n: 1 }, { id: '1' });
    MockEventSource.latest().emit('message', { n: 5 }, { id: '5' });

    // The frame that PROVED the gap is itself data. Losing it to the report of
    // the loss costs more than the report is worth.
    expect(events).toHaveBeenCalledTimes(2);
    expect(events).toHaveBeenLastCalledWith({ type: 'message', data: { n: 5 } });
    // The ledger is written before the notice, so the count is right either way.
    expect(client.missedFrames).toBe(3);
    // Nothing was lost here, so nothing may be counted as lost.
    expect(client.droppedFrames).toBe(0);
  });

  it('gives the gap notice to the subscriber behind one that throws', () => {
    const client = createSseClient('t');
    const later = vi.fn();
    client.onFrameGap(() => {
      throw new Error('gap subscriber exploded');
    });
    client.onFrameGap(later);

    MockEventSource.latest().emit('message', {}, { id: '1' });
    MockEventSource.latest().emit('message', {}, { id: '4' });

    expect(later).toHaveBeenCalledWith({ from: 2, to: 3, missed: 2, total: 2 });
  });

  it('gives the dropped-frame notice to the subscriber behind one that throws', () => {
    const client = createSseClient('t');
    const later = vi.fn();
    client.onFrameDropped(() => {
      throw new Error('drop subscriber exploded');
    });
    client.onFrameDropped(later);

    MockEventSource.latest().emit('message', 'truncated {');

    expect(later).toHaveBeenCalledWith({
      type: 'message',
      reason: 'unparseable',
      total: 1,
    });
    expect(client.droppedFrames).toBe(1);
  });

  it('gives the state notice to the subscriber behind one that throws', () => {
    const client = createSseClient('t');
    const later = vi.fn();
    // The very first call arrives synchronously on subscribe and is
    // deliberately NOT isolated - it throws into the caller's own stack, where
    // it is loud. This subscriber survives that one and fails on every notice
    // after it, which is the fan-out under test.
    let subscribed = false;
    client.onStateChange(() => {
      if (!subscribed) {
        subscribed = true;
        return;
      }
      throw new Error('state subscriber exploded');
    });
    client.onStateChange(later);
    later.mockClear();

    MockEventSource.latest().open();

    expect(later).toHaveBeenCalledWith('open', 0);
    expect(client.state).toBe('open');
  });
});

/**
 * D6 (2026-09-09, L3). EventSource retries on its own schedule and tells a
 * client nothing about how many times it has tried. The wrapper forwarded only
 * the state word, so `reconnecting` was the entire answer whether the browser
 * had failed once or forty times - and the two are not the same news. One is a
 * blip; forty is a stream that is not coming back, and a reader who is told the
 * same three letters for both has to guess which one they are living in.
 *
 * The ledger counts CONSECUTIVE failures and resets on a real open. It proves
 * what happened; it predicts nothing about the next attempt.
 */
describe('createSseClient failed-attempt ledger (D6)', () => {
  it('starts at zero, because nothing has failed yet', () => {
    const client = createSseClient('t');
    expect(client.failedAttempts).toBe(0);
  });

  it('counts consecutive failures so attempt 1 and attempt 40 are different facts', () => {
    const client = createSseClient('t');
    const source = MockEventSource.latest();

    source.fail();
    expect(client.failedAttempts).toBe(1);

    for (let attempt = 2; attempt <= 40; attempt += 1) source.fail();

    expect(client.failedAttempts).toBe(40);
    // Forty failures and the state word has not moved once - which is exactly
    // why the word alone could never have told these apart.
    expect(client.state).toBe('reconnecting');
  });

  it('resets the count when the stream actually opens', () => {
    const client = createSseClient('t');
    const source = MockEventSource.latest();

    source.fail();
    source.fail();
    source.fail();
    source.open();
    expect(client.failedAttempts).toBe(0);

    // A stream that opened, dropped and is retrying once is at 1, not at 4.
    source.fail();
    expect(client.failedAttempts).toBe(1);
  });

  it('reports the count to a state subscriber, immediately and on every change', () => {
    const client = createSseClient('t');
    const source = MockEventSource.latest();
    source.fail();
    source.fail();

    const seen: [SseConnectionState, number][] = [];
    client.onStateChange((state, attempts) => seen.push([state, attempts]));
    expect(seen).toEqual([['reconnecting', 2]]);

    source.fail();
    expect(seen).toEqual([
      ['reconnecting', 2],
      ['reconnecting', 3],
    ]);
  });

  it('counts a fatal error as the attempt it was, while close() adds none', () => {
    const client = createSseClient('t');
    const source = MockEventSource.latest();

    source.fail();
    source.fail({ fatal: true });
    // The attempt failed; that it was the last one does not unmake it. The
    // chip does not print a retry number over `closed` - nothing is retrying -
    // but the ledger records what happened rather than editing it.
    expect(client.state).toBe('closed');
    expect(client.failedAttempts).toBe(2);

    client.close();
    expect(client.failedAttempts).toBe(2);
  });
});
