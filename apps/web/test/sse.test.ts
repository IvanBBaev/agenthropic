/**
 * Unit tests for the SSE client wrapper: typed-event routing, JSON parsing,
 * silent tolerance of unknown types and malformed payloads, and the
 * connecting/open/reconnecting/closed state machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSseClient, type SseConnectionState, type SseEvent } from '../src/sse';
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

  it('silently ignores event types nobody registered', () => {
    const client = createSseClient('t');
    const any = vi.fn();
    client.onAnyEvent(any);

    MockEventSource.latest().emit('never-registered', { x: 1 });

    expect(any).not.toHaveBeenCalled();
  });

  it('silently drops frames whose data is not valid JSON', () => {
    const client = createSseClient('t');
    const handler = vi.fn();
    client.subscribe('typed', handler);

    MockEventSource.latest().emit('typed', 'not json {');

    expect(handler).not.toHaveBeenCalled();
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
