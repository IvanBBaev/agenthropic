/**
 * SSE client wrapper over EventSource (WP-U5, CD-5: SSE is the canonical
 * realtime transport - never WebSocket).
 *
 * - Connects to `/api/stream?token=...`. EventSource cannot set headers, so
 *   the query string is the ONE place the token may appear in a URL (the
 *   server redacts it from request logs). Everywhere else the token travels
 *   as `Authorization: Bearer`.
 * - Typed frames arrive as `event: <type>` + a one-line JSON `data:` payload.
 *   The wrapper parses the payload and routes by type. An unsubscribed type is
 *   dropped silently - nobody asked for it. A payload that cannot be parsed is
 *   dropped too, because there is nothing to hand a subscriber, but it is
 *   COUNTED and reported through onFrameDropped: a frame the client could not
 *   read is news, and it used to be discarded one layer below the handlers
 *   written to react to exactly that (LiveView's unreadable-frame banner and
 *   its refetch-on-unreadable-status both sit downstream of this parse, so a
 *   syntax failure defeated the compensation a shape failure triggers).
 * - EventSource auto-reconnects; the wrapper surfaces the state machine
 *   `connecting -> open -> reconnecting -> open ...`, and `closed` after an
 *   explicit close() or a fatal (non-retryable) error.
 *
 * AMENDED 2026-09-03 (LV-2, LV-5): two more ways a frame could be lost with
 * nothing on screen to say so.
 *
 * - The server numbers every frame it publishes (`id: <n>`, see
 *   apps/server/src/realtime/hub.ts) and keeps no replay buffer. This wrapper
 *   read only `data` and discarded the number, so frames published while the
 *   tab was not listening left no trace at all. The sequence is now tracked and
 *   the missing range is reported through onFrameGap. It is a DETECTION, never
 *   a recovery: the frames are gone, and for `ingest-failed` they are gone for
 *   good, because a quarantined session never reaches the read API and no
 *   refetch can bring its notice back.
 * - A subscriber that threw aborted the dispatch loop, so every later
 *   subscriber of that type and every onAnyEvent observer silently lost the
 *   frame. Each handler is now called in isolation and a failure is counted as
 *   a drop (`handler-failed`), which is the same channel F-12 opened for a
 *   frame this client could not read.
 *
 * EventSource limitation, by design: a typed frame is only delivered when a
 * listener for that exact type is registered. The wrapper eagerly registers
 * the default `message` type plus every type in `knownEventTypes` (see
 * SERVER_EVENT_TYPES) and anything passed to subscribe(); onAnyEvent sees
 * exactly those. Heartbeats are SSE comment frames (`: heartbeat`) and never
 * reach the client - liveness is the connection state, not a heartbeat count.
 */
import { SERVER_EVENT_TYPES } from '../../../packages/shared/src/realtime/event-types';

export type SseConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SseEvent<T = unknown> {
  readonly type: string;
  readonly data: T;
}

export type SseEventHandler<T = unknown> = (event: SseEvent<T>) => void;

/**
 * Why a frame never reached a subscriber. Both mean the same thing to a
 * reader - something was published and this build did not see it - but they
 * fail at different layers and are worth telling apart in a bug report.
 */
export type SseDropReason =
  /** `data:` was not valid JSON: a truncated write, a mangled chunk, a bare string. */
  | 'unparseable'
  /** `MessageEvent.data` was not a string at all - a mock, or a non-conforming source. */
  | 'not-a-string'
  /**
   * The frame was read and delivered, and a handler threw on it (LV-5). The
   * frame reached some subscribers and not others, which is a loss of the same
   * kind - so it is counted here rather than left to disappear into a dispatch
   * loop that stopped halfway.
   */
  | 'handler-failed';

export interface SseDroppedFrame {
  /** The `event: <type>` the frame arrived under; still readable when the body is not. */
  readonly type: string;
  readonly reason: SseDropReason;
  /** Running total for this client, so a subscriber need not keep its own tally. */
  readonly total: number;
}

export type SseDropHandler = (drop: SseDroppedFrame) => void;

/**
 * Frames the server numbered that never reached this client (LV-2). Derived
 * purely from the `id:` sequence: `missed` is how many ids the stream skipped,
 * `from`/`to` name the skipped range, and `total` is the running tally for this
 * client. Nothing here says what those frames CONTAINED - that is exactly the
 * point, and why a reader has to be told rather than shown a continuous board.
 */
export interface SseFrameGap {
  /** First id the client never saw. */
  readonly from: number;
  /** Last id the client never saw; equal to `from` for a single frame. */
  readonly to: number;
  /** Frames in this gap: `to - from + 1`. */
  readonly missed: number;
  /** Running total of missed frames for this client. */
  readonly total: number;
}

export type SseGapHandler = (gap: SseFrameGap) => void;

export type SseStateHandler = (state: SseConnectionState) => void;

export interface SseClientOptions {
  /**
   * Typed event names to register eagerly so onAnyEvent sees them without an
   * explicit subscribe. The default `message` type is always registered.
   */
  readonly knownEventTypes?: readonly string[];
}

export interface SseClient {
  /** Current connection state. */
  readonly state: SseConnectionState;
  /** Route typed `event: <type>` frames to a handler. Returns unsubscribe. */
  subscribe<T = unknown>(type: string, handler: SseEventHandler<T>): () => void;
  /** Receive every delivered event regardless of type. Returns unsubscribe. */
  onAnyEvent(handler: SseEventHandler): () => void;
  /**
   * Observe frames that arrived but could not be delivered. Returns
   * unsubscribe. Deliberately NOT folded into onAnyEvent: there is no `data`
   * to give those handlers, and inventing one would be the silent-failure this
   * channel exists to end.
   */
  onFrameDropped(handler: SseDropHandler): () => void;
  /** How many frames this client received and could not read. */
  readonly droppedFrames: number;
  /**
   * Observe gaps in the server's frame sequence. Returns unsubscribe. Separate
   * from onFrameDropped because the two are different losses: a dropped frame
   * arrived and could not be used, a missed frame never arrived at all, and one
   * number for both would understate whichever is smaller.
   */
  onFrameGap(handler: SseGapHandler): () => void;
  /** How many frames the server's id sequence proves this client never received. */
  readonly missedFrames: number;
  /**
   * Observe connection-state changes. The handler is invoked immediately with
   * the current state, then on every change. Returns unsubscribe.
   */
  onStateChange(handler: SseStateHandler): () => void;
  /** Close the underlying EventSource; the state becomes `closed`. */
  close(): void;
}

/**
 * Typed event names the server emits (`event: <type>` frames): the ONE list
 * both packages import, re-exported here for the shell. A hand-copied mirror
 * of it drifted once (`ingest-failed` was published but never registered, so
 * EventSource dropped every quarantine notice unheard). The deep relative
 * import deliberately bypasses the shared index so no TypeBox reaches the
 * browser bundle - same mechanism as dto.ts, but for a value: the module is
 * import-free.
 */
export { SERVER_EVENT_TYPES };

/** EventSource.CLOSED - named locally so mocks need no static constants. */
const READY_STATE_CLOSED = 2;

export function createSseClient(token: string, options: SseClientOptions = {}): SseClient {
  const source = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

  let state: SseConnectionState = 'connecting';
  const typeHandlers = new Map<string, Set<SseEventHandler>>();
  const anyHandlers = new Set<SseEventHandler>();
  const stateHandlers = new Set<SseStateHandler>();
  const dropHandlers = new Set<SseDropHandler>();
  const registeredTypes = new Set<string>();
  const gapHandlers = new Set<SseGapHandler>();
  let droppedFrames = 0;
  /** Highest comparable `id:` seen so far; null until the first one arrives. */
  let lastFrameId: number | null = null;
  let missedFrames = 0;

  function setState(next: SseConnectionState): void {
    if (next === state) return;
    state = next;
    for (const handler of [...stateHandlers]) handler(next);
  }

  function drop(type: string, reason: SseDropReason): void {
    droppedFrames += 1;
    const record: SseDroppedFrame = { type, reason, total: droppedFrames };
    for (const handler of [...dropHandlers]) handler(record);
  }

  /**
   * Track the server's frame sequence and report what it proves was missed.
   *
   * Only a FORWARD jump is a gap. A repeated id is a redelivery, a smaller id
   * is a restarted server (the hub's counter begins at 1 again), and an id this
   * build cannot compare is no evidence either way - counting any of those
   * would invent losses that never happened, which is the same dishonesty in
   * the opposite direction.
   *
   * A frame published under a type this build never registered raises no
   * listener at all, so it is invisible here until the NEXT frame arrives - and
   * then it shows up as exactly what it is, a frame that never reached this
   * client. That is how the mirror drift described above (a type published but
   * never registered) would now announce itself instead of passing for silence.
   */
  function noteFrameId(rawId: string): void {
    if (rawId === '') return;
    const id = Number(rawId);
    if (!Number.isInteger(id)) return;
    const previous = lastFrameId;
    lastFrameId = id;
    if (previous === null || id <= previous + 1) return;
    const missed = id - previous - 1;
    missedFrames += missed;
    const gap: SseFrameGap = { from: previous + 1, to: id - 1, missed, total: missedFrames };
    for (const handler of [...gapHandlers]) handler(gap);
  }

  /**
   * Call one handler in isolation: a subscriber that throws must not take the
   * frame away from the subscribers behind it (LV-5), and the failure is
   * counted so it cannot pass for a frame that was absorbed.
   */
  function deliver(handler: SseEventHandler, event: SseEvent): void {
    try {
      handler(event);
    } catch {
      drop(event.type, 'handler-failed');
    }
  }

  function dispatch(type: string, payload: unknown): void {
    if (typeof payload !== 'string') {
      drop(type, 'not-a-string');
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      // Still dropped - there is no object to hand anyone - but no longer
      // silently. The frame is unreadable, which is precisely what the reader
      // needs told, and the count is the only place that can now say it.
      drop(type, 'unparseable');
      return;
    }
    const event: SseEvent = { type, data };
    for (const handler of [...(typeHandlers.get(type) ?? [])]) deliver(handler, event);
    for (const handler of [...anyHandlers]) deliver(handler, event);
  }

  function registerType(type: string): void {
    if (registeredTypes.has(type)) return;
    registeredTypes.add(type);
    source.addEventListener(type, (frame: MessageEvent<unknown>) => {
      // Before dispatch: a frame whose body is unreadable still carries an id,
      // and the gap it proves is worth as much as the frame would have been.
      noteFrameId(frame.lastEventId);
      dispatch(type, frame.data);
    });
  }

  source.onopen = () => setState('open');
  source.onerror = () => {
    setState(source.readyState === READY_STATE_CLOSED ? 'closed' : 'reconnecting');
  };

  registerType('message');
  for (const type of options.knownEventTypes ?? SERVER_EVENT_TYPES) registerType(type);

  return {
    get state() {
      return state;
    },
    subscribe<T>(type: string, handler: SseEventHandler<T>): () => void {
      registerType(type);
      // Safe: events for `type` are produced as SseEvent<unknown>; the caller
      // narrows T for its own convenience.
      const stored = handler as SseEventHandler;
      const handlers = typeHandlers.get(type) ?? new Set<SseEventHandler>();
      handlers.add(stored);
      typeHandlers.set(type, handlers);
      return () => {
        handlers.delete(stored);
      };
    },
    onAnyEvent(handler: SseEventHandler): () => void {
      anyHandlers.add(handler);
      return () => {
        anyHandlers.delete(handler);
      };
    },
    onFrameDropped(handler: SseDropHandler): () => void {
      dropHandlers.add(handler);
      return () => {
        dropHandlers.delete(handler);
      };
    },
    get droppedFrames() {
      return droppedFrames;
    },
    onFrameGap(handler: SseGapHandler): () => void {
      gapHandlers.add(handler);
      return () => {
        gapHandlers.delete(handler);
      };
    },
    get missedFrames() {
      return missedFrames;
    },
    onStateChange(handler: SseStateHandler): () => void {
      stateHandlers.add(handler);
      handler(state);
      return () => {
        stateHandlers.delete(handler);
      };
    },
    close(): void {
      source.close();
      setState('closed');
    },
  };
}
