/**
 * OPS-20 - /api/health reports how the process itself is doing: resident
 * memory, event-loop lag over the last complete window, and the open SSE
 * stream count. A bare server (no seam) keeps its minimal body.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { start } from '../src/index';
import {
  LOOP_LAG_RESOLUTION_MS,
  LOOP_LAG_WINDOW_MS,
  selfMetrics,
  startLoopLagMonitor,
  type LoopDelayHistogram,
  type LoopLagMonitor,
} from '../src/self-metrics';
import { buildServer } from '../src/server';
import { networkAddress, TEST_TOKEN } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const MS = 1_000_000;

/** A histogram whose samples the test sets directly, in nanoseconds. */
class FakeHistogram implements LoopDelayHistogram {
  samples: number[] = [];
  enabled = false;
  resets = 0;
  get count(): number {
    return this.samples.length;
  }
  get max(): number {
    return Math.max(...this.samples);
  }
  percentile(percentile: number): number {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.ceil((percentile / 100) * sorted.length) - 1]!;
  }
  enable(): boolean {
    this.enabled = true;
    return true;
  }
  disable(): boolean {
    this.enabled = false;
    return true;
  }
  reset(): void {
    this.samples = [];
    this.resets += 1;
  }
}

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('startLoopLagMonitor()', () => {
  it('is null before the first sample and reports lag past the sampling interval', () => {
    vi.useFakeTimers();
    const histogram = new FakeHistogram();
    const monitor = startLoopLagMonitor({ histogram, resolutionMs: 20, windowMs: 1000 });
    try {
      expect(histogram.enabled).toBe(true);
      expect(monitor.snapshot()).toBeNull();
      // 99 on-time runs (one under the interval) and one 250 ms stall.
      histogram.samples = [19 * MS, ...Array<number>(98).fill(21 * MS), 270.04 * MS];
      // No complete window yet: the current one answers.
      expect(monitor.snapshot()).toEqual({ p99Ms: 1, maxMs: 250 });
    } finally {
      monitor.stop();
    }
  });

  it('reports the last complete window and rotates the histogram', () => {
    vi.useFakeTimers();
    const histogram = new FakeHistogram();
    const monitor = startLoopLagMonitor({ histogram, resolutionMs: 20, windowMs: 1000 });
    try {
      histogram.samples = [20 * MS, 520 * MS];
      vi.advanceTimersByTime(1000);
      expect(histogram.resets).toBe(1);
      expect(histogram.count).toBe(0);
      // The completed window, not the empty one just started.
      expect(monitor.snapshot()).toEqual({ p99Ms: 500, maxMs: 500 });
      histogram.samples = [20 * MS, 21 * MS];
      expect(monitor.snapshot()).toEqual({ p99Ms: 500, maxMs: 500 });
      vi.advanceTimersByTime(1000);
      // The stall has aged out with its window.
      expect(monitor.snapshot()).toEqual({ p99Ms: 1, maxMs: 1 });
      // A window without samples keeps the previous answer.
      vi.advanceTimersByTime(1000);
      expect(histogram.resets).toBe(3);
      expect(monitor.snapshot()).toEqual({ p99Ms: 1, maxMs: 1 });
    } finally {
      monitor.stop();
    }
  });

  it('stop() disables the histogram and the rotation, and is idempotent', () => {
    vi.useFakeTimers();
    const histogram = new FakeHistogram();
    const monitor = startLoopLagMonitor({ histogram, windowMs: 1000 });
    expect(vi.getTimerCount()).toBe(1);
    monitor.stop();
    monitor.stop();
    expect(histogram.enabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults to a 20 ms sample and a 60 s window', () => {
    expect(LOOP_LAG_RESOLUTION_MS).toBe(20);
    expect(LOOP_LAG_WINDOW_MS).toBe(60_000);
    vi.useFakeTimers();
    const histogram = new FakeHistogram();
    const monitor = startLoopLagMonitor({ histogram });
    try {
      histogram.samples = [30 * MS];
      vi.advanceTimersByTime(LOOP_LAG_WINDOW_MS - 1);
      expect(histogram.resets).toBe(0);
      vi.advanceTimersByTime(1);
      expect(histogram.resets).toBe(1);
      expect(monitor.snapshot()).toEqual({ p99Ms: 10, maxMs: 10 });
    } finally {
      monitor.stop();
    }
  });

  it('measures a real blocked loop with the real histogram', async () => {
    const monitor = startLoopLagMonitor();
    try {
      // Let the sampling timer run once before the stall, so the stall is a
      // measured interval rather than the first one after enable().
      await new Promise((resolve) => setTimeout(resolve, 60));
      const until = Date.now() + 150;
      while (Date.now() < until) {
        // Block the event loop.
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      const lag = monitor.snapshot();
      expect(lag).not.toBeNull();
      // A lower bound only: a loaded machine can only add lag.
      expect(lag!.maxMs).toBeGreaterThanOrEqual(100);
      expect(lag!.p99Ms).toBeLessThanOrEqual(lag!.maxMs);
    } finally {
      monitor.stop();
    }
  });
});

describe('selfMetrics()', () => {
  const lagOf = (snapshot: ReturnType<LoopLagMonitor['snapshot']>): LoopLagMonitor => ({
    snapshot: () => snapshot,
    stop: () => undefined,
  });

  it('reports RSS and the lag window', () => {
    expect(selfMetrics({ loopLag: lagOf({ p99Ms: 3.5, maxMs: 40 }), rss: () => 1234 })).toEqual({
      rssBytes: 1234,
      eventLoopLagP99Ms: 3.5,
      eventLoopLagMaxMs: 40,
    });
  });

  it('omits the lag before the first sample, and reads the real RSS by default', () => {
    const result = selfMetrics({ loopLag: lagOf(null) });
    expect(Object.keys(result)).toEqual(['rssBytes']);
    expect(result.rssBytes).toBeGreaterThan(0);
  });
});

describe('the selfMetrics seam on buildServer', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('adds the seam fields and the live SSE client count', async () => {
    app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 4,
      heartbeatIntervalMs: 10_000,
      selfMetrics: () => ({ rssBytes: 99, eventLoopLagP99Ms: 0.4, eventLoopLagMaxMs: 7 }),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${networkAddress(app).port}`;
    const health = async (): Promise<unknown> =>
      (await fetch(`${baseUrl}/api/health`, { headers: AUTH })).json();

    expect(await health()).toEqual({
      status: 'ok',
      schemaVersion: 4,
      rssBytes: 99,
      eventLoopLagP99Ms: 0.4,
      eventLoopLagMaxMs: 7,
      sseClients: 0,
    });

    const controllers = [new AbortController(), new AbortController()];
    for (const controller of controllers) {
      const response = await fetch(`${baseUrl}/api/stream`, {
        headers: AUTH,
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      await response.body!.getReader().read(); // the stream is live
    }
    expect(await health()).toMatchObject({ sseClients: 2 });

    controllers[0]!.abort();
    await vi.waitFor(async () => {
      expect(await health()).toMatchObject({ sseClients: 1 });
    });
    controllers[1]!.abort();
  });

  it('a server without the seam reports none of the four fields', async () => {
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 0 });
    const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });
    expect(health.json()).toEqual({ status: 'ok', schemaVersion: 0 });
  });
});

describe('the OPS-20 fields through start()', () => {
  it('reports RSS, no open streams and, once sampled, the loop lag', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-ops20-'));
    dirs.push(dir);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'agent.db'),
      DASHBOARD_INGEST: '0',
      DASHBOARD_LOG_LEVEL: 'silent',
    });
    try {
      await vi.waitFor(
        async () => {
          const health = (
            await server.app.inject({ method: 'GET', url: '/api/health', headers: AUTH })
          ).json() as Record<string, unknown>;
          expect(health['rssBytes']).toBeGreaterThan(0);
          expect(health['sseClients']).toBe(0);
          expect(health['eventLoopLagP99Ms']).toEqual(expect.any(Number));
          expect(health['eventLoopLagMaxMs']).toEqual(expect.any(Number));
        },
        { timeout: 5000, interval: 50 },
      );
    } finally {
      await server.close();
    }
  });
});
