/**
 * Review H-2 - skip visibility. A skipped corpus file (oversize, unreadable,
 * empty...) freezes that session's dollar totals, so the skip must surface in
 * three places: a structured (rate-limited) log line per file, an aggregate
 * line per ingesting pass, and cumulative per-reason counters on the running
 * server. The unit half drives createSkipReporter directly; the integration
 * half proves start() actually wires it into the watcher's onWarning seam.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkipReporter, start } from '../src/index';
import { buildServer } from '../src/server';
import { TEST_TOKEN } from './helpers';

const OVERSIZE_A = { relativePath: 'slug/aaaa.jsonl', reason: 'oversize' } as const;

describe('createSkipReporter (review H-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts every skip by reason and logs file, reason and errno code', () => {
    const lines: string[] = [];
    const reporter = createSkipReporter({
      logError: (line) => lines.push(line),
      nowMs: () => 0,
      relogIntervalMs: 1000,
    });

    reporter.onSkip(OVERSIZE_A);
    reporter.onSkip({ relativePath: 'slug/bbbb.jsonl', reason: 'oversize' });
    reporter.onSkip({ relativePath: 'slug/cccc.jsonl', reason: 'unreadable', code: 'EACCES' });

    // Two files sharing a reason are two distinct facts - both log.
    expect(lines).toEqual([
      "corpus ingest: skipped slug/aaaa.jsonl (oversize) - this session's records are NOT in the dashboard totals.",
      "corpus ingest: skipped slug/bbbb.jsonl (oversize) - this session's records are NOT in the dashboard totals.",
      "corpus ingest: skipped slug/cccc.jsonl (unreadable, EACCES) - this session's records are NOT in the dashboard totals.",
    ]);
    expect(reporter.counters()).toEqual({ oversize: 2, unreadable: 1 });
  });

  it('an identical skip is silent within the interval and re-logged after it', () => {
    let now = 0;
    const lines: string[] = [];
    const reporter = createSkipReporter({
      logError: (line) => lines.push(line),
      nowMs: () => now,
      relogIntervalMs: 1000,
    });

    reporter.onSkip(OVERSIZE_A);
    reporter.onSkip(OVERSIZE_A);
    now = 999;
    reporter.onSkip(OVERSIZE_A);
    expect(lines).toHaveLength(1);

    now = 1000;
    reporter.onSkip(OVERSIZE_A);
    expect(lines).toHaveLength(2);

    // Suppressed skips still COUNT - the rate limit is about log noise only.
    expect(reporter.counters()).toEqual({ oversize: 4 });
  });

  it('the aggregate tick line is silent at zero, loud once, then rate-limited', () => {
    let now = 0;
    const lines: string[] = [];
    const reporter = createSkipReporter({
      logError: (line) => lines.push(line),
      nowMs: () => now,
      relogIntervalMs: 1000,
    });

    reporter.onTickSkips(0);
    expect(lines).toHaveLength(0);

    reporter.onSkip(OVERSIZE_A);
    reporter.onSkip({ relativePath: 'slug/bbbb.jsonl', reason: 'oversize' });
    reporter.onSkip({ relativePath: 'slug/cccc.jsonl', reason: 'unreadable', code: 'EACCES' });
    reporter.onTickSkips(2);
    expect(lines[3]).toBe(
      'corpus watcher: 2 file(s) skipped this pass; skips since boot: oversize=2, unreadable=1.',
    );

    reporter.onTickSkips(1);
    expect(lines).toHaveLength(4);

    now = 1000;
    reporter.onTickSkips(1);
    expect(lines).toHaveLength(5);
  });

  it('defaults: console.error is the sink and wall time drives the rate limit', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = createSkipReporter();

    reporter.onSkip({ relativePath: 'slug/dddd.jsonl', reason: 'empty-main' });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('corpus ingest: skipped slug/dddd.jsonl (empty-main)'),
    );

    // Real Date.now: the repeat lands well inside the 5-minute default window.
    reporter.onSkip({ relativePath: 'slug/dddd.jsonl', reason: 'empty-main' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(reporter.counters()).toEqual({ 'empty-main': 2 });
  });
});

describe('skip visibility through start() (review H-2)', () => {
  const SLUG = '-Users-synthetic-skip-project';
  const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A zero-byte `<uuid>.jsonl` main transcript is the one skip a test can
   * materialize without a 64MiB file or permission tricks: enumeration admits
   * it (the name is canonical), substrate build reports 'empty-main'.
   */
  function writeEmptySession(corpusRoot: string, sessionId: string): void {
    mkdirSync(join(corpusRoot, SLUG), { recursive: true });
    writeFileSync(join(corpusRoot, SLUG, `${sessionId}.jsonl`), '');
  }

  it('a replay skip reaches the log, the summary line and skipCounters()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-skipvis-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    writeEmptySession(corpusRoot, SESSION_A);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'agent.db'),
      CLAUDE_PROJECTS_DIR: corpusRoot,
      DASHBOARD_POLL_INTERVAL_MS: '600000', // park the poll loop far away
    });
    try {
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`corpus ingest: skipped ${SESSION_A}.jsonl (empty-main)`),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT in the dashboard totals'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('1 files skipped'));
      expect(server.skipCounters()).toEqual({ 'empty-main': 1 });
    } finally {
      await server.close();
    }
  });

  it('a scheduled tick logs each new skip plus a cumulative aggregate line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-skiptick-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    writeEmptySession(corpusRoot, SESSION_A);

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Only setInterval is faked: start() must still listen over the real
    // event loop, and the watcher's scheduled passes are then driven by hand.
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: join(dir, 'agent.db'),
        CLAUDE_PROJECTS_DIR: corpusRoot,
        DASHBOARD_POLL_INTERVAL_MS: '1000',
      });
      try {
        expect(server.skipCounters()).toEqual({ 'empty-main': 1 });
        error.mockClear();

        // A second empty session appears: the next pass ingests ONLY the
        // change, skips it, and the aggregate line carries the boot total too.
        writeEmptySession(corpusRoot, SESSION_B);
        vi.advanceTimersByTime(1000);
        expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
          `corpus ingest: skipped ${SESSION_B}.jsonl (empty-main) - ` +
            `this session's records are NOT in the dashboard totals.`,
          'corpus watcher: 1 file(s) skipped this pass; skips since boot: empty-main=2.',
        ]);
        expect(server.skipCounters()).toEqual({ 'empty-main': 2 });

        // A quiet pass ('unchanged') reports no skips - and re-logs nothing.
        vi.advanceTimersByTime(1000);
        expect(error).toHaveBeenCalledTimes(2);
      } finally {
        await server.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ingest-disabled boot still answers skipCounters() - with zeros', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-skipoff-'));
    dirs.push(dir);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'agent.db'),
      DASHBOARD_INGEST: '0',
    });
    try {
      expect(server.skipCounters()).toEqual({});
    } finally {
      await server.close();
    }
  });

  it('the counters surface on /api/health as ingestSkips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-skiphealth-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    writeEmptySession(corpusRoot, SESSION_A);

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'agent.db'),
      CLAUDE_PROJECTS_DIR: corpusRoot,
      DASHBOARD_POLL_INTERVAL_MS: '600000',
    });
    try {
      const health = await server.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(health.statusCode).toBe(200);
      // `ingest: 'idle'` doubles as the M-16 integration proof: start() has
      // resolved, so the boot replay is over and the phase seam says so.
      expect(health.json()).toMatchObject({
        status: 'ok',
        ingestSkips: { 'empty-main': 1 },
        ingest: 'idle',
        // The boot replay is a completed pass, so the M-15 duration is live
        // too — possibly 0ms on a fast machine, but never absent.
        lastTickDurationMs: expect.any(Number) as number,
      });
    } finally {
      await server.close();
    }
  });
});

describe('/api/health ingest phase (review M-16)', () => {
  // Both phases are driven at the buildServer seam: 'replaying' is only ever
  // live between the composition root's bind and the end of its replay tick,
  // a window no black-box request can hit deterministically.
  it.each(['replaying', 'idle'] as const)("mirrors the seam's answer: %s", async (phase) => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0, ingestPhase: () => phase });
    try {
      const health = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok', schemaVersion: 0, ingest: phase });
    } finally {
      await app.close();
    }
  });
});

describe('/api/health last tick duration (review M-15)', () => {
  it("mirrors the seam's answer once a pass has completed", async () => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0, tickDurationMs: () => 12.5 });
    try {
      const health = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok', schemaVersion: 0, lastTickDurationMs: 12.5 });
    } finally {
      await app.close();
    }
  });

  it('omits the field while no pass has finished — never a fake zero', async () => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0, tickDurationMs: () => null });
    try {
      const health = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok', schemaVersion: 0 });
    } finally {
      await app.close();
    }
  });
});

describe('/api/health without a skipCounters seam (review H-2)', () => {
  it('omits ingestSkips entirely rather than faking a zero', async () => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0 });
    try {
      const health = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok', schemaVersion: 0 });
    } finally {
      await app.close();
    }
  });
});
