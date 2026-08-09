/**
 * Shared EventSource test double. Mirrors the browser API surface the SSE
 * wrapper touches: constructor(url), onopen/onerror, addEventListener,
 * readyState, close(). Test-side helpers: open(), fail(), emit().
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

  /** Deliver a frame; non-string data is JSON-stringified into the payload. */
  emit(type: string, data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const event = new MessageEvent(type, { data: payload });
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    if (type === 'message') this.onmessage?.(event);
  }

  /** Deliver a frame whose `data` is passed through untouched (e.g. non-string). */
  emitRaw(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data });
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    if (type === 'message') this.onmessage?.(event);
  }
}
