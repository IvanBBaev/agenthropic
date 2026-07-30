/**
 * SSE client wrapper over EventSource (WP-U5, CD-5: SSE is the canonical
 * realtime transport - never WebSocket).
 *
 * - Connects to `/api/stream?token=...`. EventSource cannot set headers, so
 *   the query string is the ONE place the token may appear in a URL (the
 *   server redacts it from request logs). Everywhere else the token travels
 *   as `Authorization: Bearer`.
 * - Typed frames arrive as `event: <type>` + a one-line JSON `data:` payload.
 *   The wrapper parses the payload and routes by type; malformed payloads and
 *   unsubscribed types are dropped silently.
 * - EventSource auto-reconnects; the wrapper surfaces the state machine
 *   `connecting -> open -> reconnecting -> open ...`, and `closed` after an
 *   explicit close() or a fatal (non-retryable) error.
 *
 * EventSource limitation, by design: a typed frame is only delivered when a
 * listener for that exact type is registered. The wrapper eagerly registers
 * the default `message` type plus every type in `knownEventTypes` (see
 * SERVER_EVENT_TYPES) and anything passed to subscribe(); onAnyEvent sees
 * exactly those. Heartbeats are SSE comment frames (`: heartbeat`) and never
 * reach the client - liveness is the connection state, not a heartbeat count.
 */

export type SseConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SseEvent<T = unknown> {
  readonly type: string;
  readonly data: T;
}

export type SseEventHandler<T = unknown> = (event: SseEvent<T>) => void;

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
   * Observe connection-state changes. The handler is invoked immediately with
   * the current state, then on every change. Returns unsubscribe.
   */
  onStateChange(handler: SseStateHandler): () => void;
  /** Close the underlying EventSource; the state becomes `closed`. */
  close(): void;
}

/**
 * Typed event names the server emits (`event: <type>` frames). Mirrors the
 * RealtimeEvent union in @agenthropic/shared; append each new server event
 * type here so the live feed and onAnyEvent pick it up without code changes
 * elsewhere.
 */
export const SERVER_EVENT_TYPES: readonly string[] = ['session-ingested', 'agent-status-changed'];

/** EventSource.CLOSED - named locally so mocks need no static constants. */
const READY_STATE_CLOSED = 2;

export function createSseClient(token: string, options: SseClientOptions = {}): SseClient {
  const source = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

  let state: SseConnectionState = 'connecting';
  const typeHandlers = new Map<string, Set<SseEventHandler>>();
  const anyHandlers = new Set<SseEventHandler>();
  const stateHandlers = new Set<SseStateHandler>();
  const registeredTypes = new Set<string>();

  function setState(next: SseConnectionState): void {
    if (next === state) return;
    state = next;
    for (const handler of [...stateHandlers]) handler(next);
  }

  function dispatch(type: string, payload: unknown): void {
    if (typeof payload !== 'string') return;
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      // Malformed data: tolerated silently by contract.
      return;
    }
    const event: SseEvent = { type, data };
    for (const handler of [...(typeHandlers.get(type) ?? [])]) handler(event);
    for (const handler of [...anyHandlers]) handler(event);
  }

  function registerType(type: string): void {
    if (registeredTypes.has(type)) return;
    registeredTypes.add(type);
    source.addEventListener(type, (frame: MessageEvent<unknown>) => {
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
