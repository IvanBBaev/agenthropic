/**
 * Shared EventSource test double. Mirrors the browser API surface the SSE
 * wrapper touches: constructor(url), onopen/onerror, addEventListener,
 * readyState, close(). Test-side helpers: open(), fail(), emit().
 *
 * AMENDED 2026-09-03 (LV-2): frames now carry `lastEventId`, which the double
 * previously left empty for every frame. The server numbers every frame it
 * publishes (`id: <n>` in apps/server/src/realtime/hub.ts) and keeps no replay
 * buffer, so that number is the only evidence a client has that frames went
 * missing - a double that cannot express it cannot test for it. The id is
 * OPTIONAL and sticky in the way the SSE spec makes it sticky: a frame emitted
 * without one inherits the last id seen, exactly as a browser EventSource
 * reports it, so every existing call site keeps its current behaviour.
 */
export class MockEventSource {
  static instances: MockEventSource[] = [];

  static reset(): void {
    MockEventSource.instances = [];
  }

  static latest(): MockEventSource {
    const last = MockEventSource.instances.at(-1);
    if (last === undefined) throw new Error('no EventSource was constructed');
    return last;
  }

  readonly url: string;
  /** 0 CONNECTING · 1 OPEN · 2 CLOSED */
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  /** Last `id:` seen on the wire; sticky across frames that carry none. */
  private lastEventId = '';

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** Simulate the connection opening. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Simulate an error; fatal -> CLOSED, otherwise CONNECTING (auto-retry). */
  fail(options: { fatal?: boolean } = {}): void {
    this.readyState = options.fatal === true ? 2 : 0;
    this.onerror?.();
  }

  /**
   * Deliver a frame; non-string data is JSON-stringified into the payload.
   * `id` is the server's frame number (`id: <n>` on the wire); omit it and the
   * frame inherits the last id seen, as the SSE spec requires.
   */
  emit(type: string, data: unknown, options: { id?: string } = {}): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.deliver(type, payload, options.id);
  }

  /** Deliver a frame whose `data` is passed through untouched (e.g. non-string). */
  emitRaw(type: string, data: unknown, options: { id?: string } = {}): void {
    this.deliver(type, data, options.id);
  }

  private deliver(type: string, data: unknown, id: string | undefined): void {
    if (id !== undefined) this.lastEventId = id;
    const event = new MessageEvent(type, { data, lastEventId: this.lastEventId });
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    if (type === 'message') this.onmessage?.(event);
  }
}
