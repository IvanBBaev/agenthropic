/**
 * The `?token=` credential path on `/api/stream`, pinned around the one spot
 * that used to carry an untestable `request.raw.url ?? ''` fallback.
 *
 * `extractToken` now reads Fastify's own `request.url` — the same string,
 * exposed as a non-optional `string` because the router cannot dispatch a
 * request without a URL — so the dead `??` arm no longer exists and the branch
 * figure for this package is a measurement rather than an estimate. These tests
 * pin the behaviour that fallback was pretending to protect: a stream request
 * with no query string at all must 401, never throw.
 *
 * The happy path (`?token=<valid>` streaming 200 text/event-stream) lives in
 * `security-contract.test.ts` clause (6) over a real socket; a hijacked SSE
 * reply never resolves under `app.inject`, so only the pre-hijack auth
 * decisions are exercised here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { TEST_TOKEN } from './helpers';

describe('/api/stream ?token= extraction', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function build(): FastifyInstance {
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7 });
    return app;
  }

  it('401s a stream request carrying no query string at all', async () => {
    const response = await build().inject({ method: 'GET', url: '/api/stream' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized.' });
  });

  it('401s a stream request whose query string has no token parameter', async () => {
    const response = await build().inject({ method: 'GET', url: '/api/stream?since=17' });
    expect(response.statusCode).toBe(401);
  });

  it('401s a stream request with an empty token parameter', async () => {
    const response = await build().inject({ method: 'GET', url: '/api/stream?token=' });
    expect(response.statusCode).toBe(401);
  });

  it('401s a stream request with the wrong token in the query', async () => {
    const response = await build().inject({
      method: 'GET',
      url: '/api/stream?token=not-the-token-000000',
    });
    expect(response.statusCode).toBe(401);
  });

  it('never accepts ?token= on a non-stream route, valid or not', async () => {
    const server = build();
    const viaQuery = await server.inject({
      method: 'GET',
      url: `/api/health?token=${TEST_TOKEN}`,
    });
    expect(viaQuery.statusCode).toBe(401);
    const viaHeader = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(viaHeader.statusCode).toBe(200);
  });

  it('still prefers the Authorization header when both are present', async () => {
    const response = await build().inject({
      method: 'GET',
      url: '/api/stream?token=not-the-token-000000',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      // The header wins, so this reaches the SSE handler; `inject` would hang on
      // a hijacked reply, so the assertion is that it does NOT 401/403 - which
      // `payloadAsStream` lets us observe without draining the stream.
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    response.stream().destroy();
  });
});

/**
 * The project's coverage standard (2026-07-31): an ignore pragma buys a
 * cosmetic 100 by dropping live code out of the denominator, so the two files
 * this lane owns carry none. `apps/web` pins the same rule for its layout
 * module in `test/honesty.test.tsx`.
 */
describe('coverage honesty', () => {
  it.each(['server.ts', 'index.ts'])('keeps src/%s free of v8 ignore pragmas', (file) => {
    const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');
    expect(source).not.toContain('v8 ignore');
  });
});
