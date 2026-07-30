import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFixture, type Fixture } from '@agenthropic/test-fixtures';
import {
  ContainmentError,
  enforceLoopbackOrExit,
  exitOnCorpusFatal,
  isLoopbackAddress,
  openDatabase,
  runMigrations,
  start,
} from '../src/index';
import { TEST_TOKEN } from './helpers';

describe('composition root (src/index)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
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
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining(`corpus replay failure: session ${SESSION_BAD}`),
        );

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

        const hookBody = { hook_event_name: 'Stop', session_id: sessionId };
        const first = await server.app.inject({
          method: 'POST',
          url: '/api/hooks/event',
          headers: auth,
          payload: hookBody,
        });
        expect(first.statusCode).toBe(202);
        expect(first.json()).toEqual({ stored: true });
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
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining('corpus replay:'));
      } finally {
        await server.close();
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
});
