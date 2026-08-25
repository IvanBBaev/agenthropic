import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { RealtimeHub, type SessionIngestedEvent } from '../src/realtime/hub';
import { TEST_TOKEN } from './helpers';

describe('buildServer (WP-U0)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** One well-formed fan-out event; only the id matters to these tests. */
  function ingested(sessionId: string): SessionIngestedEvent {
    return {
      type: 'session-ingested',
      sessionId,
      projectSlug: 'proj-x',
      agentCount: 0,
      edgesInserted: 0,
      usageRowsInserted: 0,
      costUsd: null,
      occurredAt: '2026-08-25T00:00:00Z',
    };
  }

  async function listen(options: Parameters<typeof buildServer>[0]): Promise<string> {
    app = buildServer(options);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.addresses()[0];
    return `http://127.0.0.1:${address?.port}`;
  }

  it('sends the retry hint and periodic heartbeat comments on the SSE stream', async () => {
    const baseUrl = await listen({
      token: TEST_TOKEN,
      schemaVersion: 7,
      heartbeatIntervalMs: 20,
      sseRetryMs: 1234,
    });
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes(': heartbeat')) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      received += decoder.decode(value);
    }
    expect(received).toContain('retry: 1234');
    expect(received).toContain(': connected');
    expect(received).toContain(': heartbeat');
    controller.abort();
  });

  it('closes active streams when the server shuts down', async () => {
    const baseUrl = await listen({
      token: TEST_TOKEN,
      schemaVersion: 7,
      heartbeatIntervalMs: 10,
    });
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read(); // stream is live

    await app!.close();
    app = undefined;

    // The server closed the connection; the stream must end (not hang).
    let done = false;
    try {
      while (!done) {
        done = (await reader.read()).done;
      }
    } catch {
      done = true; // an abrupt termination error also proves closure
    }
    expect(done).toBe(true);
  });

  it('cleans up per-connection heartbeats when the client disconnects', async () => {
    const baseUrl = await listen({
      token: TEST_TOKEN,
      schemaVersion: 7,
      heartbeatIntervalMs: 10,
    });
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    });
    await response.body!.getReader().read();
    controller.abort();
    // Give the server a beat to observe the close; shutdown must be clean.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await app!.close();
    app = undefined;
  });

  /**
   * Backpressure reaping. `raw.write()` to a peer that has stopped reading
   * neither fails nor blocks - it buffers in the server's heap forever, and a
   * suspended laptop or a half-dead tunnel emits no 'close' event to clean up
   * after. Without a bound, every later frame is appended to a backlog for a
   * reader that never returns; the process just grows.
   *
   * `writableLength` counts the frame just written until libuv's completion
   * callback fires on a later tick, so a threshold of 0 makes the very first
   * frame trip the bound - which is exactly the deterministic lever these
   * tests need, with no dependence on filling a kernel socket buffer.
   */
  it('reaps a subscriber whose outbound backlog exceeds the bound', async () => {
    const hub = new RealtimeHub();
    const baseUrl = await listen({
      token: TEST_TOKEN,
      schemaVersion: 7,
      hub,
      heartbeatIntervalMs: 60_000, // parked: the publish below is the trigger
      maxStreamBacklogBytes: 0,
    });
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const reader = response.body!.getReader();
    await reader.read(); // subscribed and live
    expect(hub.subscriberCount).toBe(1);

    hub.publish(ingested('s1'));

    // Dropped through the SAME close path as a clean disconnect: unsubscribing
    // alone would stop the frames and leave the heartbeat timer running, which
    // is a leak swapped for a leak rather than a fix.
    expect(hub.subscriberCount).toBe(0);
    let done = false;
    try {
      while (!done) {
        done = (await reader.read()).done;
      }
    } catch {
      done = true; // an abrupt termination also proves the drop
    }
    expect(done).toBe(true);
    // The peer's own 'close' now fires on an already-reaped stream; a second
    // teardown must be a no-op, not a double unsubscribe.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hub.subscriberCount).toBe(0);
  });

  /**
   * The half of the reap that `subscriberCount` cannot see. Unsubscribing stops
   * the frames; it does not give back the bytes already buffered for a peer
   * that stopped reading, and those bytes are the entire reason the bound
   * exists. `end()` cannot give them back either - it QUEUES a FIN behind the
   * unsent backlog, so on a peer that never drains the FIN never leaves, the
   * socket stays open and the heap stays occupied. Only `destroy()` drops both.
   *
   * Asserted through the one difference a client can observe: `end()` writes
   * the terminating zero-length chunk and the body ends CLEANLY, while
   * `destroy()` tears the chunked response down mid-flight and the body read
   * rejects. A clean end here would therefore mean the server took the path
   * that reclaims nothing.
   */
  it('destroys a reaped peer rather than queueing a FIN behind its backlog', async () => {
    const hub = new RealtimeHub();
    const baseUrl = await listen({
      token: TEST_TOKEN,
      schemaVersion: 7,
      hub,
      heartbeatIntervalMs: 60_000,
      maxStreamBacklogBytes: 0,
    });
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const reader = response.body!.getReader();
    await reader.read(); // subscribed and live

    hub.publish(ingested('s1'));

    await expect(
      (async () => {
        for (;;) {
          if ((await reader.read()).done) {
            return;
          }
        }
      })(),
    ).rejects.toThrow();
  });

  it('keeps a client that drains normally, however many frames it is sent', async () => {
    const hub = new RealtimeHub();
    const baseUrl = await listen({
      token: TEST_TOKEN,
      schemaVersion: 7,
      hub,
      heartbeatIntervalMs: 60_000,
    });
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes(': connected')) {
      received += decoder.decode((await reader.read()).value);
    }

    // A real event stream, at the production bound: nothing here is a backlog.
    for (let i = 0; i < 25; i += 1) {
      hub.publish(ingested(`s${String(i)}`));
    }
    while (!received.includes('"s24"')) {
      received += decoder.decode((await reader.read()).value);
    }

    expect(hub.subscriberCount).toBe(1);
    controller.abort();
  });

  it('does not gate non-API paths with auth (they 404 instead)', async () => {
    const baseUrl = await listen({ token: TEST_TOKEN, schemaVersion: 7 });
    const response = await fetch(`${baseUrl}/not-api`);
    expect(response.status).toBe(404);
  });

  it('rejects a malformed Authorization scheme', async () => {
    const baseUrl = await listen({ token: TEST_TOKEN, schemaVersion: 7 });
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: `Token ${TEST_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });

  it('health responds with the schema version it was built with', async () => {
    const baseUrl = await listen({ token: TEST_TOKEN, schemaVersion: 42 });
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(await response.json()).toEqual({ status: 'ok', schemaVersion: 42 });
  });
});
