import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { TEST_TOKEN } from './helpers';

describe('buildServer (WP-U0)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

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
