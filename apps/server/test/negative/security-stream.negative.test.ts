/**
 * WP-X4 negative-test catalogue — security/stream scenarios over a REAL
 * booted server (composition root + fetch over the loopback socket).
 *
 * Catalogue of record: docs/site/contributing/testing.md section 5 / 5.1:
 *
 *   #5 (startup facet) no DASHBOARD_TOKEN -> the server cannot start
 *   #7 foreign-origin stream connect      -> rejected (SSE per CD-5/ADR-0007)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, start, type RunningServer } from '../../src/index';
import { TEST_TOKEN } from '../helpers';

describe('WP-X4 security/stream negative catalogue', () => {
  let dir: string;
  let server: RunningServer;
  let baseUrl: string;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-negative-stream-'));
    server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'agent.db'),
      DASHBOARD_INGEST: '0', // tests must never resolve the real ~/.claude/projects
    });
    const address = server.app.addresses()[0];
    if (address === undefined) {
      throw new Error('server reported no bound addresses');
    }
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Scenario #5 (startup facet) ------------------------------------------
  // Catalogue reconciliation note: "#5/#6 <-> server fails startup when
  // DASHBOARD_TOKEN is unset + the timing-safe compare — one CD-7 control,
  // three distinct assertions; keep all three." This is the startup one.
  it('Scenario #5 — without DASHBOARD_TOKEN the server CANNOT start (CD-7, NFR-SEC-02)', async () => {
    await expect(start({})).rejects.toThrow(/DASHBOARD_TOKEN/);
    expect(() => loadConfig({})).toThrow(/DASHBOARD_TOKEN/);
    expect(() => loadConfig({ DASHBOARD_TOKEN: undefined })).toThrow(/DASHBOARD_TOKEN/);
  });

  // --- Scenario #7 — foreign-origin stream connect --------------------------
  // Catalogue: "cross-origin connect rejected" — CD-5 (the canonical realtime
  // transport is SSE, hardened from the source's WS per ADR-0007) and CD-7.
  it('Scenario #7 — a foreign Origin is 403 on /api/stream, with OR without a valid token (CD-5, CD-7)', async () => {
    const withToken = await fetch(`${baseUrl}/api/stream?token=${TEST_TOKEN}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(withToken.status).toBe(403);
    const withTokenBody = await withToken.text();
    expect(withTokenBody).toContain('Cross-origin');

    const withoutToken = await fetch(`${baseUrl}/api/stream`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(withoutToken.status).toBe(403);

    // The origin check runs FIRST: a cross-origin caller cannot use the
    // response to probe whether its token was valid (no auth oracle).
    expect(await withoutToken.text()).toBe(withTokenBody);
    expect(withTokenBody).not.toContain(TEST_TOKEN);
  });

  it('Scenario #7 — the same-origin stream serves text/event-stream, proving SSE not WS (CD-5)', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream?token=${TEST_TOKEN}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const { value } = await reader!.read();
    expect(new TextDecoder().decode(value)).toContain('retry:');
    controller.abort();
  });
});
