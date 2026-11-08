/**
 * R18 - browser hardening (SEC-3) and the Host allowlist (SEC-4).
 *
 * Headers: every response class carries the CSP / XFO / Referrer-Policy set -
 * SPA shell, asset, JSON API, 401, 404, error, the 421 itself and the hijacked
 * SSE stream. Host: a rebinding name is refused with 421 on every surface,
 * BEFORE the token gate and before the unauthenticated static SPA.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../src/http/security-headers';
import { buildServer } from '../src/server';
import { networkAddress, TEST_TOKEN } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const TUNNEL = 'https://mini.tailnet.ts.net';

function expectHardened(headers: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(headers[name], name).toBe(value);
  }
}

describe('R18 security headers and Host allowlist', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-r18-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'export {};');
    app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 7,
      webRoot: dir,
      allowedOrigins: [TUNNEL],
    });
    app.get('/api/boom', async () => {
      throw new Error('driver detail');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the policy is the SEC-3 recommendation, verbatim', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
        "form-action 'self'; object-src 'none'",
    );
  });

  it.each([
    ['SPA shell', '/', {}, 200],
    ['static 404', '/missing.js', {}, 404],
    ['static asset', '/assets/app.js', {}, 200],
    ['JSON API', '/api/health', AUTH, 200],
    ['401', '/api/health', {}, 401],
    ['API 404', '/api/nope', AUTH, 404],
    ['500', '/api/boom', AUTH, 500],
  ])('hardens the %s response', async (_label, url, headers, status) => {
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(status);
    expectHardened(response.headers);
  });

  it.each(['evil.example', 'evil.example:7341', 'localhost.evil.example'])(
    'refuses the rebinding Host %s with 421 on the SPA, before any file is served',
    async (host) => {
      const response = await app.inject({ method: 'GET', url: '/', headers: { host } });
      expect(response.statusCode).toBe(421);
      expect(response.json()).toEqual({ error: 'Unrecognized Host header.' });
      expect(response.body).not.toContain('root');
      expectHardened(response.headers);
    },
  );

  it('refuses a rebinding Host with 421 on the API even with a valid token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { ...AUTH, host: 'evil.example' },
    });
    expect(response.statusCode).toBe(421);
  });

  it('refuses a rebinding Host on an unrouted path without echoing it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/nope?token=secret-value',
      headers: { host: 'evil.example' },
    });
    expect(response.statusCode).toBe(421);
    expect(response.body).not.toContain('secret-value');
    expect(response.body).not.toContain('evil.example');
  });

  it.each(['127.0.0.1:7341', 'localhost:18080', 'mini.tailnet.ts.net'])(
    'serves the allowed Host %s',
    async (host) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { ...AUTH, host },
      });
      expect(response.statusCode).toBe(200);
    },
  );

  it('without an allowlist the tunnel name is refused', async () => {
    const bare = buildServer({ token: TEST_TOKEN, schemaVersion: 7 });
    try {
      const response = await bare.inject({
        method: 'GET',
        url: '/api/health',
        headers: { ...AUTH, host: 'mini.tailnet.ts.net' },
      });
      expect(response.statusCode).toBe(421);
    } finally {
      await bare.close();
    }
  });

  it('hardens the hijacked SSE stream head and gates it on Host over a real socket', async () => {
    const live = buildServer({ token: TEST_TOKEN, schemaVersion: 7 });
    await live.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${networkAddress(live).port}`;
    try {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/stream`, {
        headers: AUTH,
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expectHardened(Object.fromEntries(response.headers));
      controller.abort();

      // fetch() refuses to set Host itself, so the rebinding case goes through
      // inject on the same listening instance.
      const rebound = await live.inject({
        method: 'GET',
        url: '/api/stream',
        headers: { ...AUTH, host: 'evil.example' },
      });
      expect(rebound.statusCode).toBe(421);
    } finally {
      await live.close();
    }
  });
});
