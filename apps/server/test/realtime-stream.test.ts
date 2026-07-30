/**
 * WP-U1 - /api/stream x RealtimeHub integration over a real listening socket:
 * published events fan out to every connected SSE client, closes unsubscribe,
 * and the pre-existing security gates (Bearer/?token=, same-origin) survived
 * the rewire.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { RealtimeHub, type RealtimeEvent } from '../src/realtime/hub';
import { TEST_TOKEN } from './helpers';

const testEvent: RealtimeEvent = {
  type: 'session-ingested',
  sessionId: 'session-1',
  projectSlug: 'demo',
  agentCount: 1,
  edgesInserted: 0,
  usageRowsInserted: 5,
  costUsd: 0.01,
  occurredAt: '2026-07-11T00:00:00Z',
};

describe('/api/stream with RealtimeHub', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function listen(hub: RealtimeHub): Promise<string> {
    app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 7,
      heartbeatIntervalMs: 60_000,
      hub,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.addresses()[0];
    return `http://127.0.0.1:${address?.port}`;
  }

  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    needle: string,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      received += decoder.decode(value, { stream: true });
    }
    return received;
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for condition.');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('fans a published event out to BOTH connected SSE clients', async () => {
    const hub = new RealtimeHub();
    const baseUrl = await listen(hub);

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const [responseA, responseB] = await Promise.all([
      fetch(`${baseUrl}/api/stream`, {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        signal: controllerA.signal,
      }),
      fetch(`${baseUrl}/api/stream?token=${TEST_TOKEN}`, { signal: controllerB.signal }),
    ]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);

    const readerA = responseA.body!.getReader();
    const readerB = responseB.body!.getReader();
    // A client that has seen ': connected' is provably subscribed already.
    await readUntil(readerA, ': connected');
    await readUntil(readerB, ': connected');
    expect(hub.subscriberCount).toBe(2);

    hub.publish(testEvent);

    const [receivedA, receivedB] = await Promise.all([
      readUntil(readerA, '"session-ingested"'),
      readUntil(readerB, '"session-ingested"'),
    ]);
    for (const received of [receivedA, receivedB]) {
      expect(received).toContain('id: 1\n');
      expect(received).toContain('event: session-ingested\n');
      expect(received).toContain(`data: ${JSON.stringify(testEvent)}\n`);
    }

    controllerA.abort();
    controllerB.abort();
  });

  it('unsubscribes a client when its connection closes', async () => {
    const hub = new RealtimeHub();
    const baseUrl = await listen(hub);

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    });
    await readUntil(response.body!.getReader(), ': connected');
    expect(hub.subscriberCount).toBe(1);

    controller.abort();
    await waitFor(() => hub.subscriberCount === 0);
  });

  it('unsubscribes every client on server shutdown', async () => {
    const hub = new RealtimeHub();
    const baseUrl = await listen(hub);

    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    await readUntil(response.body!.getReader(), ': connected');
    expect(hub.subscriberCount).toBe(1);

    await app!.close();
    app = undefined;
    expect(hub.subscriberCount).toBe(0);
  });

  it('publishing with no subscribers is a safe no-op that still counts ids', async () => {
    const hub = new RealtimeHub();
    await listen(hub);
    expect(hub.publish(testEvent)).toBe(1);
    expect(hub.publish(testEvent)).toBe(2);
  });

  it('still rejects the stream without a token (401) after the rewire', async () => {
    const hub = new RealtimeHub();
    const baseUrl = await listen(hub);
    const response = await fetch(`${baseUrl}/api/stream`);
    expect(response.status).toBe(401);
    expect(hub.subscriberCount).toBe(0);
  });

  it('still enforces same-origin on the stream (403 for a foreign Origin)', async () => {
    const hub = new RealtimeHub();
    const baseUrl = await listen(hub);
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        origin: 'https://evil.example',
      },
    });
    expect(response.status).toBe(403);
    expect(hub.subscriberCount).toBe(0);
  });
});
