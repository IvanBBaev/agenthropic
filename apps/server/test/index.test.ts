import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFixture, type Fixture } from '@agenthropic/test-fixtures';
import {
  ContainmentError,
  enforceLoopbackOrExit,
  exitOnCorpusFatal,
  isLoopbackAddress,
  openDatabase,
  RealtimeHub,
  replayOutcomeLine,
  reportIngestFailure,
  runMigrations,
  start,
  tickTroubleTransition,
} from '../src/index';
import type { CorpusIngestSummary } from '../src/corpus/ingest-corpus';
import { TEST_TOKEN } from './helpers';

describe('composition root (src/index)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start() boots config -> WAL db -> migrations -> loopback listen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-start-'));
    dirs.push(dir);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'nested', 'agent.db'),
      DASHBOARD_INGEST: '0', // tests must never resolve the real ~/.claude/projects
    });
    try {
      expect(server.db.pragma('journal_mode', { simple: true })).toBe('wal');
      const tables = server.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events_raw'")
        .all();
      expect(tables).toHaveLength(1);
      expect(server.app.addresses().every((entry) => entry.address === '127.0.0.1')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('start() throws without a token and starts no server', async () => {
    await expect(start({})).rejects.toThrow(/DASHBOARD_TOKEN/);
  });

  it('start() cleans up and rethrows when the port is already taken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-start-conflict-'));
    dirs.push(dir);
    const first = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'first.db'),
      DASHBOARD_INGEST: '0',
    });
    try {
      const takenPort = first.app.addresses()[0]?.port;
      await expect(
        start({
          DASHBOARD_TOKEN: TEST_TOKEN,
          DASHBOARD_PORT: String(takenPort),
          DASHBOARD_DB_PATH: join(dir, 'second.db'),
          DASHBOARD_INGEST: '0',
        }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  });

  it('isLoopbackAddress accepts loopback forms only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });

  it('enforceLoopbackOrExit is a no-op when every address is loopback', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    await enforceLoopbackOrExit([{ address: '127.0.0.1' }, { address: '::1' }], cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('enforceLoopbackOrExit logs, cleans up and exits on a non-loopback bind', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(enforceLoopbackOrExit([{ address: '192.168.1.10' }], cleanup)).rejects.toThrow(
      'process.exit called',
    );

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('192.168.1.10'));
  });

  describe('WP-IN10 replay-on-startup', () => {
    const SLUG = '-Users-synthetic-replay-project';
    const SESSION_BAD = 'dddddddd-4444-4444-8444-444444444444';
    const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

    /** The bare no-slash `<uuid>.jsonl` main is the only file enumeration keys on. */
    function mainSessionIdOf(fixture: Fixture): string {
      const main = fixture.files.find((f) => !f.relativePath.includes('/'));
      return main!.relativePath.slice(0, -'.jsonl'.length);
    }

    /** Lay the fixture out on REAL disk the way Claude Code does (main + `<uuid>/` dir). */
    function materializeFixture(corpusRoot: string, fixture: Fixture, sessionId: string): void {
      for (const f of fixture.files) {
        const rel = f.relativePath.includes('/')
          ? join(sessionId, ...f.relativePath.split('/'))
          : f.relativePath;
        const abs = join(corpusRoot, SLUG, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.lines.join('\n') + '\n');
      }
    }

    /** Migrate the db ahead of start() and seed prices for the fixture's models. */
    function seedDb(dbPath: string): void {
      const db = openDatabase(dbPath);
      runMigrations(db);
      const insert = db.prepare(
        'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, 1, ?)',
      );
      for (const model of ['synthetic-model-a', 'synthetic-model-b']) {
        for (const bucket of BUCKETS) {
          insert.run(model, bucket, '2020-01-01');
        }
      }
      db.close();
    }

    function countRows(db: { prepare(sql: string): { get(): unknown } }, table: string): number {
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }

    it('replays the corpus into real rows on boot and logs per-session failures', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-replay-'));
      dirs.push(dir);
      const dbPath = join(dir, 'agent.db');
      const corpusRoot = join(dir, 'projects');
      seedDb(dbPath);

      const fixture = getFixture('flat-tool-use');
      const sessionId = mainSessionIdOf(fixture);
      materializeFixture(corpusRoot, fixture, sessionId);
      // A second session priced against a model NO seed row covers: the cost
      // halt gate fails it, exercising the failure-log branch — while the
      // healthy session must still land (per-session isolation).
      const mainLines = fixture.files.find((f) => !f.relativePath.includes('/'))!.lines;
      writeFileSync(
        join(corpusRoot, SLUG, `${SESSION_BAD}.jsonl`),
        mainLines.map((l) => l.replace(/synthetic-model-[ab]/g, 'unpriced-model-z')).join('\n') +
          '\n',
      );

      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: dbPath,
        CLAUDE_PROJECTS_DIR: corpusRoot,
        DASHBOARD_POLL_INTERVAL_MS: '600000', // park the poll loop far away
      });
      try {
        expect(countRows(server.db, 'sessions')).toBe(1);
        expect(countRows(server.db, 'agents')).toBeGreaterThan(0);
        expect(countRows(server.db, 'token_usage')).toBeGreaterThan(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('corpus replay: 1/2 sessions ok'));
        // A failed session is never swallowed: it is named, counted and marked
        // retryable - and the diagnostic names the session, not the substrate.
        const failureLogs = error.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith('corpus ingest failure:'));
        expect(failureLogs).toHaveLength(1);
        expect(failureLogs[0]).toContain(`session ${SESSION_BAD}`);
        expect(failureLogs[0]).toContain('attempt 1/');
        expect(failureLogs[0]).toContain('will retry');
        expect(failureLogs[0]).not.toContain(corpusRoot);
        expect(failureLogs[0]).not.toContain(SLUG);

        // Integration seams wired by start(): the read API sees the replayed
        // rows, and the hook receiver stores (then dedupes) an event - both
        // behind the same Bearer gate.
        const auth = { authorization: `Bearer ${TEST_TOKEN}` };
        const sessions = await server.app.inject({
          method: 'GET',
          url: '/api/sessions',
          headers: auth,
        });
        expect(sessions.statusCode).toBe(200);
        expect((sessions.json() as { sessions: unknown[] }).sessions).toHaveLength(1);

        // The full lifecycle through the REAL composition root. Ingest wrote
        // 'working' (activity, never termination); the SAME replay tick then
        // ran the watchdog, and this corpus's timestamps are months old, so the
        // default DASHBOARD_WATCHDOG_MINUTES window has long expired and the
        // agent is honestly 'unknown'. It is NOT 'completed' — nothing observed
        // it end.
        const statusOf = (id: string): string =>
          (
            server.db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as {
              status: string;
            }
          ).status;
        expect(statusOf(sessionId)).toBe('unknown');

        const hookBody = { hook_event_name: 'Stop', session_id: sessionId };
        const first = await server.app.inject({
          method: 'POST',
          url: '/api/hooks/event',
          headers: auth,
          payload: hookBody,
        });
        expect(first.statusCode).toBe(202);
        expect(first.json()).toEqual({ stored: true });
        // WP-IN12 through the REAL composition root: the delivered Stop is an
        // OBSERVATION, so it overrides the watchdog's INFERENCE — the main
        // agent moves to 'waiting' and the session mirrors it.
        expect(statusOf(sessionId)).toBe('waiting');
        const sessionRow = server.db
          .prepare('SELECT status FROM sessions WHERE id = ?')
          .get(sessionId) as { status: string };
        expect(sessionRow.status).toBe('waiting');
        const replayed = await server.app.inject({
          method: 'POST',
          url: '/api/hooks/event',
          headers: auth,
          payload: hookBody,
        });
        expect(replayed.json()).toEqual({ stored: false });
        const unauthenticated = await server.app.inject({
          method: 'POST',
          url: '/api/hooks/event',
          payload: hookBody,
        });
        expect(unauthenticated.statusCode).toBe(401);
      } finally {
        await server.close();
      }
    });

    it('DASHBOARD_INGEST=0 boots without touching a present corpus', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-noingest-'));
      dirs.push(dir);
      const corpusRoot = join(dir, 'projects');
      const fixture = getFixture('flat-tool-use');
      materializeFixture(corpusRoot, fixture, mainSessionIdOf(fixture));

      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: join(dir, 'agent.db'),
        CLAUDE_PROJECTS_DIR: corpusRoot,
        DASHBOARD_INGEST: '0',
      });
      try {
        expect(countRows(server.db, 'sessions')).toBe(0);
      } finally {
        await server.close();
      }
    });

    it('falls back to ~/.claude/projects when CLAUDE_PROJECTS_DIR is unset', async () => {
      // The only path on which start() forwards NO corpus-root override, so
      // the watcher has to derive the canonical `~/.claude/projects` itself.
      // HOME is redirected at a throwaway directory holding a SYNTHETIC
      // corpus, so the developer's real ~/.claude/projects is never resolved.
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-homefallback-'));
      dirs.push(dir);
      const fakeHome = join(dir, 'home');
      vi.stubEnv('HOME', fakeHome);
      // Guard: if the stub did not take, abort rather than read the real corpus.
      expect(homedir()).toBe(fakeHome);

      const dbPath = join(dir, 'agent.db');
      const corpusRoot = join(fakeHome, '.claude', 'projects');
      const fixture = getFixture('flat-tool-use');
      const sessionId = mainSessionIdOf(fixture);
      materializeFixture(corpusRoot, fixture, sessionId);
      seedDb(dbPath);

      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: dbPath,
        DASHBOARD_POLL_INTERVAL_MS: '600000',
        // deliberately no CLAUDE_PROJECTS_DIR
      });
      try {
        expect(log).toHaveBeenCalledWith(expect.stringContaining('corpus replay: 1/1 sessions ok'));
        const ids = server.db.prepare('SELECT id FROM sessions').all() as { id: string }[];
        expect(ids).toEqual([{ id: sessionId }]);
      } finally {
        await server.close();
      }
    });

    it('boots normally when ingest is enabled but the corpus root does not exist', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-noroot-'));
      dirs.push(dir);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: join(dir, 'agent.db'),
        CLAUDE_PROJECTS_DIR: join(dir, 'missing'),
        DASHBOARD_POLL_INTERVAL_MS: '600000',
      });
      try {
        expect(countRows(server.db, 'sessions')).toBe(0);
        // The boot SAYS why it replayed nothing. This used to assert silence -
        // which was honest only while `tick()` returned a bare `null` the call
        // site could not interpret, and which made a missing corpus root look
        // exactly like a fully-checkpointed one. What must never appear is a
        // count: an empty replay is reported as such, not as "0/0 sessions ok".
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('corpus replay: no corpus root resolved'),
        );
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining('sessions ok'));
      } finally {
        await server.close();
      }
    });

    it('boots and says so LOUDLY when the corpus root cannot be read at all', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-unreadable-'));
      dirs.push(dir);
      // A symlink loop makes realpath() fail with ELOOP rather than ENOENT, so
      // the root neither resolves nor is honestly absent. That is the third
      // boot state - and the one that used to be indistinguishable from a
      // healthy, fully-checkpointed corpus, because all three printed nothing.
      const loopA = join(dir, 'loop-a');
      const loopB = join(dir, 'loop-b');
      symlinkSync(loopB, loopA);
      symlinkSync(loopA, loopB);

      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: join(dir, 'agent.db'),
        CLAUDE_PROJECTS_DIR: loopA,
        DASHBOARD_POLL_INTERVAL_MS: '600000',
      });
      try {
        // The server still serves - an unreadable corpus degrades the data, it
        // does not make the process unhealthy...
        expect(countRows(server.db, 'sessions')).toBe(0);
        // ...but it goes to console.ERROR, and it does not claim the root is
        // merely absent, which would be a different (and false) diagnosis.
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('corpus replay: the corpus could not be read'),
        );
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining('no corpus root resolved'));
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining('sessions ok'));
      } finally {
        await server.close();
      }
    });

    it('the poll loop announces each trouble transition once and recovery once', async () => {
      // Only setInterval is faked: start() must still listen over the real
      // event loop, and the watcher's scheduled passes are then driven by hand.
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-polltrouble-'));
      dirs.push(dir);
      const corpusRoot = join(dir, 'projects');
      mkdirSync(corpusRoot, { recursive: true });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
          // Boot replay saw an empty-but-present corpus: quiet, no trouble.
          log.mockClear();
          error.mockClear();

          // The root becomes a symlink loop: realpath fails with ELOOP, the
          // pass is a read-error - announced ONCE, at error level.
          rmSync(corpusRoot, { recursive: true, force: true });
          const loopTarget = join(dir, 'loop-target');
          symlinkSync(loopTarget, corpusRoot);
          symlinkSync(corpusRoot, loopTarget);
          vi.advanceTimersByTime(1000);
          expect(error).toHaveBeenCalledTimes(1);
          expect(error).toHaveBeenCalledWith(
            expect.stringContaining('corpus watcher: the corpus could not be read'),
          );
          expect(error).toHaveBeenCalledWith(
            expect.stringContaining('the dashboard is stale until this clears'),
          );

          // Same trouble on the next poll: steady state, NOT a second line.
          vi.advanceTimersByTime(1000);
          expect(error).toHaveBeenCalledTimes(1);

          // The loop vanishes entirely: a DIFFERENT trouble ('no-corpus-root'),
          // so it is announced - at log level, it is a fact, not a failure.
          rmSync(corpusRoot, { force: true });
          rmSync(loopTarget, { force: true });
          vi.advanceTimersByTime(1000);
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining('corpus watcher: no corpus root resolved'),
          );

          // The root reappears: recovery is announced once...
          mkdirSync(corpusRoot, { recursive: true });
          vi.advanceTimersByTime(1000);
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining('corpus watcher: the corpus is readable again'),
          );

          // ...and a healthy steady state goes back to silence.
          log.mockClear();
          vi.advanceTimersByTime(1000);
          expect(log).not.toHaveBeenCalled();
          expect(error).toHaveBeenCalledTimes(1);
        } finally {
          await server.close();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('trouble already announced by the replay is not announced again by the poll loop', async () => {
      // The replay tick seeds the trouble state: a boot that already printed
      // "could not be read" must not print the watcher's entry line for the
      // SAME unbroken condition one poll interval later.
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-seedtrouble-'));
      dirs.push(dir);
      const loopA = join(dir, 'loop-a');
      const loopB = join(dir, 'loop-b');
      symlinkSync(loopB, loopA);
      symlinkSync(loopA, loopB);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.useFakeTimers({ toFake: ['setInterval'] });
      try {
        const server = await start({
          DASHBOARD_TOKEN: TEST_TOKEN,
          DASHBOARD_PORT: '0',
          DASHBOARD_DB_PATH: join(dir, 'agent.db'),
          CLAUDE_PROJECTS_DIR: loopA,
          DASHBOARD_POLL_INTERVAL_MS: '1000',
        });
        try {
          expect(error).toHaveBeenCalledWith(
            expect.stringContaining('corpus replay: the corpus could not be read'),
          );
          error.mockClear();

          vi.advanceTimersByTime(1000);
          expect(error).not.toHaveBeenCalled();
        } finally {
          await server.close();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('exitOnCorpusFatal logs loudly, cleans up and exits non-zero', () => {
    const cleanup = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    expect(() =>
      exitOnCorpusFatal(new ContainmentError('/evil/../../etc', '/fake/corpus'), cleanup),
    ).toThrow('process.exit called');

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('containment violation'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('stop-everything'));
  });

  /**
   * WP-IN5 failure visibility. Deliberately NOT a /api/health field and NOT a
   * new endpoint: health answers "is this process serving", and a per-session
   * ingest failure must not make an otherwise healthy server report degraded.
   * The dashboard already learns the truth over SSE, so a failure travels the
   * same way - plus a server-side log for the operator.
   */
  describe('reportIngestFailure (the visibility seam)', () => {
    const REPORT = {
      sessionId: 'dddddddd-4444-4444-8444-444444444444',
      reason: 'refusing to price at $0: unknown model id "unpriced-model-z"',
      attempt: 2,
      willRetry: true,
    };

    it('logs the session, the attempt and the retry verdict, and publishes to SSE', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const hub = new RealtimeHub();
      const frames: string[] = [];
      hub.subscribe((frame) => frames.push(frame));

      reportIngestFailure(REPORT, hub, '2026-07-20T10:00:00.000Z');

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`corpus ingest failure: session ${REPORT.sessionId}`),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining('attempt 2/'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('will retry'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(REPORT.reason));

      expect(frames).toHaveLength(1);
      expect(frames[0]).toContain('event: ingest-failed\n');
      expect(frames[0]).toContain(
        `data: ${JSON.stringify({
          type: 'ingest-failed',
          payload: { ...REPORT, occurredAt: '2026-07-20T10:00:00.000Z' },
        })}\n`,
      );
    });

    it('says quarantined once the retry budget is spent', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      reportIngestFailure(
        { ...REPORT, attempt: 3, willRetry: false },
        new RealtimeHub(),
        '2026-07-20T10:00:00.000Z',
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining('quarantined'));
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('will retry'));
    });
  });

  /**
   * The boot line for a replay pass that ingested nothing. Before `TickOutcome`
   * this call site printed NOTHING, because `tick()` handed back a bare `null`
   * it could not interpret - so "fully checkpointed and quiet" was indis-
   * tinguishable from "no corpus root" and from "the root could not be read".
   * These assertions pin that each reason has its OWN sentence: a test that only
   * checked "some line was produced" would let the three collapse again.
   */
  describe('replayOutcomeLine (why a replay ingested nothing)', () => {
    it('gives every non-ingesting outcome its own sentence at its own level', () => {
      // The two that are facts about the corpus, not problems with the server.
      expect(replayOutcomeLine({ kind: 'unchanged' })).toEqual({
        level: 'log',
        text: expect.stringContaining('no session changed since the last checkpoint'),
      });
      expect(replayOutcomeLine({ kind: 'no-corpus-root' })).toEqual({
        level: 'log',
        text: expect.stringContaining('no corpus root resolved'),
      });
      // The rest all mean the watcher is not doing its job - hence 'error'.
      // The carried reason lands IN the line: "could not be read" alone tells
      // the operator to go digging; the errno tells them where.
      expect(
        replayOutcomeLine({ kind: 'read-error', reason: 'corpus root unreadable (EACCES)' }),
      ).toEqual({
        level: 'error',
        text: expect.stringContaining(
          'could not be read this pass (corpus root unreadable (EACCES))',
        ),
      });
      expect(replayOutcomeLine({ kind: 'containment-halt' })).toEqual({
        level: 'error',
        text: expect.stringContaining('see the FATAL line above'),
      });
      expect(replayOutcomeLine({ kind: 'stopped' })).toEqual({
        level: 'error',
        text: expect.stringContaining('already stopped'),
      });
      expect(replayOutcomeLine({ kind: 'overlapped' })).toEqual({
        level: 'error',
        text: expect.stringContaining('already in flight'),
      });
    });

    it('never restates a containment violation as a second incident', () => {
      // The FATAL line is printed by exitOnCorpusFatal; this line points at it.
      // Two independently-phrased alarms for one crafted corpus would inflate a
      // single event into two in any log the operator reads.
      const halt = replayOutcomeLine({ kind: 'containment-halt' });
      expect(halt.text).not.toContain('FATAL:');
      expect(halt.text).not.toContain('shutting down');
    });

    it('gives every outcome a DISTINCT sentence (none collapse into another)', () => {
      const outcomes = [
        { kind: 'unchanged' },
        { kind: 'no-corpus-root' },
        { kind: 'read-error', reason: 'corpus root unreadable (EACCES)' },
        { kind: 'containment-halt' },
        { kind: 'stopped' },
        { kind: 'overlapped' },
      ] as const;
      const texts = outcomes.map((outcome) => replayOutcomeLine(outcome).text);
      expect(new Set(texts).size).toBe(outcomes.length);
    });
  });

  /**
   * The poll loop's trouble state machine. Every post-boot tick used to discard
   * its outcome entirely; the transition function makes trouble ENTRY and
   * RECOVERY each log exactly once, while steady states - healthy or troubled -
   * stay silent so a 2-second poll cannot flood the log.
   */
  describe('tickTroubleTransition (announce trouble once, recovery once)', () => {
    const READ_ERROR = { kind: 'read-error', reason: 'corpus root unreadable (EACCES)' } as const;
    const SUMMARY: CorpusIngestSummary = {
      sessionsDiscovered: 1,
      sessionsOk: 1,
      sessionsFailed: 0,
      sessionsSkipped: 0,
      agentsUpserted: 1,
      edgesInserted: 0,
      usageRowsInserted: 1,
      filesSkipped: 0,
      totalCostUsd: 0,
      failures: [],
    };

    it('entering read-error logs once, at error level, with the carried reason', () => {
      expect(tickTroubleTransition(null, READ_ERROR)).toEqual({
        next: 'read-error',
        line: {
          level: 'error',
          text:
            'corpus watcher: the corpus could not be read (corpus root unreadable (EACCES)) - ' +
            'the dashboard is stale until this clears.',
        },
      });
    });

    it('a persisting read-error is silent (no line per poll interval)', () => {
      expect(tickTroubleTransition('read-error', READ_ERROR)).toEqual({
        next: 'read-error',
        line: null,
      });
    });

    it('entering no-corpus-root logs once at log level; persisting is silent', () => {
      expect(tickTroubleTransition(null, { kind: 'no-corpus-root' })).toEqual({
        next: 'no-corpus-root',
        line: {
          level: 'log',
          text: 'corpus watcher: no corpus root resolved - nothing to ingest until one appears.',
        },
      });
      expect(tickTroubleTransition('no-corpus-root', { kind: 'no-corpus-root' })).toEqual({
        next: 'no-corpus-root',
        line: null,
      });
    });

    it('switching between the two troubles re-announces (they are different facts)', () => {
      expect(tickTroubleTransition('no-corpus-root', READ_ERROR).line?.level).toBe('error');
      expect(tickTroubleTransition('read-error', { kind: 'no-corpus-root' }).line?.level).toBe(
        'log',
      );
    });

    it('recovery from either trouble logs once; a healthy steady state is silent', () => {
      const recovery = {
        next: null,
        line: {
          level: 'log',
          text: 'corpus watcher: the corpus is readable again - resuming normal ingest.',
        },
      };
      expect(tickTroubleTransition('read-error', { kind: 'unchanged' })).toEqual(recovery);
      expect(
        tickTroubleTransition('no-corpus-root', { kind: 'ingested', summary: SUMMARY }),
      ).toEqual(recovery);
      expect(tickTroubleTransition(null, { kind: 'unchanged' })).toEqual({
        next: null,
        line: null,
      });
      expect(tickTroubleTransition(null, { kind: 'ingested', summary: SUMMARY })).toEqual({
        next: null,
        line: null,
      });
    });

    it("'stopped', 'overlapped' and 'containment-halt' neither log nor move the state", () => {
      // None of the three says anything about whether the corpus reads: the
      // halt already has its own FATAL line, and the other two are watcher
      // lifecycle facts. The PREVIOUS trouble state must survive them, or a
      // stray overlapped pass would suppress the eventual recovery line.
      for (const kind of ['stopped', 'overlapped', 'containment-halt'] as const) {
        expect(tickTroubleTransition(null, { kind })).toEqual({ next: null, line: null });
        expect(tickTroubleTransition('read-error', { kind })).toEqual({
          next: 'read-error',
          line: null,
        });
      }
    });
  });
});
