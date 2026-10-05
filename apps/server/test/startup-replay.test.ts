/**
 * The chunked startup replay (runStartupReplay): capped passes with an
 * event-loop turn before each, so a large corpus no longer holds the event loop
 * for the whole replay. While it runs /api/health says 'replaying' and the data
 * endpoints serve what has landed so far; the phase turns 'idle' only once the
 * sweep has drained.
 *
 * The end-to-end half drives the REAL composition root with the per-pass cap
 * lowered to 1 (a module mock - the production default is exercised by every
 * other start() test) and observes the server between passes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFixture } from '@agenthropic/test-fixtures';
import type { CorpusIngestSummary } from '../src/corpus/ingest-corpus';
import type { TickOptions, TickOutcome } from '../src/ingest/corpus-watcher';
import {
  mergeReplaySummaries,
  openDatabase,
  runMigrations,
  runStartupReplay,
  start,
} from '../src/index';
import { TEST_TOKEN } from './helpers';

const hooks = vi.hoisted(() => ({
  beforeTick: null as ((options: TickOptions | undefined) => void) | null,
  app: null as FastifyInstance | null,
}));

vi.mock('../src/ingest/corpus-watcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ingest/corpus-watcher')>();
  return {
    ...actual,
    REPLAY_MAX_SESSIONS_PER_PASS: 1,
    createCorpusWatcher: (deps: Parameters<typeof actual.createCorpusWatcher>[0]) => {
      const watcher = actual.createCorpusWatcher(deps);
      return {
        ...watcher,
        tick: (options?: TickOptions) => {
          hooks.beforeTick?.(options);
          return watcher.tick(options);
        },
      };
    },
  };
});

vi.mock('../src/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server')>();
  return {
    ...actual,
    buildServer: (options: Parameters<typeof actual.buildServer>[0]) => {
      const app = actual.buildServer(options);
      hooks.app = app;
      return app;
    },
  };
});

function summary(n: number, overrides: Partial<CorpusIngestSummary> = {}): CorpusIngestSummary {
  return {
    sessionsDiscovered: n,
    sessionsOk: n,
    sessionsFailed: 0,
    sessionsSkipped: 0,
    agentsUpserted: n,
    edgesInserted: n,
    usageRowsInserted: n,
    filesSkipped: 0,
    totalCostUsd: n,
    failures: [],
    ...overrides,
  };
}

function fakeWatcher(outcomes: TickOutcome[]) {
  const calls: (TickOptions | undefined)[] = [];
  return {
    calls,
    tick(options?: TickOptions): TickOutcome {
      calls.push(options);
      return outcomes.shift() as TickOutcome;
    },
  };
}

const ingested = (s: CorpusIngestSummary, pending: boolean): TickOutcome => ({
  kind: 'ingested',
  summary: s,
  pending,
});

describe('mergeReplaySummaries', () => {
  it('adds every count and concatenates failures in order', () => {
    const a = summary(2, {
      sessionsFailed: 1,
      sessionsSkipped: 1,
      filesSkipped: 2,
      failures: [{ sessionId: 'a', projectSlug: 's', error: 'x' }],
    });
    const b = summary(3, {
      sessionsFailed: 2,
      sessionsSkipped: 0,
      filesSkipped: 1,
      failures: [{ sessionId: 'b', projectSlug: 's', error: 'y' }],
    });

    expect(mergeReplaySummaries(a, b)).toEqual({
      sessionsDiscovered: 5,
      sessionsOk: 5,
      sessionsFailed: 3,
      sessionsSkipped: 1,
      agentsUpserted: 5,
      edgesInserted: 5,
      usageRowsInserted: 5,
      filesSkipped: 3,
      totalCostUsd: 5,
      failures: [
        { sessionId: 'a', projectSlug: 's', error: 'x' },
        { sessionId: 'b', projectSlug: 's', error: 'y' },
      ],
    });
  });
});

describe('runStartupReplay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ticks with the cap until nothing is pending, yielding before every pass', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const watcher = fakeWatcher([
      ingested(summary(2), true),
      ingested(summary(2), true),
      ingested(summary(1), false),
    ]);
    const order: string[] = [];
    const yieldTurn = vi.fn(() => {
      order.push('yield');
      return Promise.resolve();
    });
    const tick = watcher.tick.bind(watcher);
    watcher.tick = (options) => {
      order.push('tick');
      return tick(options);
    };

    const final = await runStartupReplay(watcher, { maxSessionsPerPass: 2, yieldTurn });

    expect(final).toEqual(ingested(summary(1), false));
    expect(watcher.calls).toEqual([{ maxSessions: 2 }, { maxSessions: 2 }, { maxSessions: 2 }]);
    expect(order).toEqual(['yield', 'tick', 'yield', 'tick', 'yield', 'tick']);
    // ONE summary line for the whole sweep, with the aggregated counts.
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([expect.stringContaining('corpus replay: 5/5 sessions ok')]);
  });

  it('logs the outcome line when the first pass ingests nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const final = await runStartupReplay(fakeWatcher([{ kind: 'unchanged' }]), {
      maxSessionsPerPass: 2,
      yieldTurn: () => Promise.resolve(),
    });

    expect(final).toEqual({ kind: 'unchanged' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no session changed'));
  });

  it('logs an error-level outcome line at error level', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runStartupReplay(fakeWatcher([{ kind: 'read-error', reason: 'EIO' }]), {
      maxSessionsPerPass: 2,
      yieldTurn: () => Promise.resolve(),
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be read this pass'));
  });

  it("does not follow a summary with 'nothing replayed' when the remainder vanished or shutdown began", async () => {
    for (const ending of [{ kind: 'unchanged' }, { kind: 'stopped' }] as const) {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const final = await runStartupReplay(fakeWatcher([ingested(summary(1), true), ending]), {
        maxSessionsPerPass: 1,
        yieldTurn: () => Promise.resolve(),
      });

      expect(final).toEqual(ending);
      expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining('corpus replay: 1/1 sessions ok'),
      ]);
      expect(error).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it('still reports trouble that ends a sweep after passes that did ingest', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const final = await runStartupReplay(
      fakeWatcher([ingested(summary(1), true), { kind: 'read-error', reason: 'EIO' }]),
      { maxSessionsPerPass: 1, yieldTurn: () => Promise.resolve() },
    );

    expect(final).toEqual({ kind: 'read-error', reason: 'EIO' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be read this pass'));
  });

  it('yields with setImmediate by default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const spy = vi.spyOn(globalThis, 'setImmediate');
    await runStartupReplay(fakeWatcher([{ kind: 'unchanged' }]), { maxSessionsPerPass: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('start(): the chunked replay end to end', () => {
  const SLUG = '-Users-synthetic-chunked-replay-project';
  const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];
  const IDS = [
    'eeeeeeee-1111-4111-8111-000000000001',
    'eeeeeeee-1111-4111-8111-000000000002',
    'eeeeeeee-1111-4111-8111-000000000003',
  ];
  const dirs: string[] = [];

  afterEach(() => {
    hooks.beforeTick = null;
    hooks.app = null;
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers between passes: health says 'replaying' and reads serve the rows landed so far", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-chunked-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agent.db');
    const corpusRoot = join(dir, 'projects');

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

    // Three copies of one fixture, each under its own session id - in the
    // file name AND the records, or the runner refuses the copy (review L-4).
    const fixture = getFixture('flat-tool-use');
    const main = fixture.files.find((f) => !f.relativePath.includes('/'))!;
    const originalId = main.relativePath.slice(0, -'.jsonl'.length);
    for (const id of IDS) {
      for (const f of fixture.files) {
        const rel = f.relativePath.includes('/')
          ? join(id, ...f.relativePath.split('/'))
          : `${id}.jsonl`;
        const abs = join(corpusRoot, SLUG, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.lines.map((l) => l.split(originalId).join(id)).join('\n') + '\n');
      }
    }

    const auth = { authorization: `Bearer ${TEST_TOKEN}` };
    // A request is issued just before each pass. When the NEXT pass begins,
    // it must already have been answered: that is the server answering
    // between passes, mid-replay, with whatever has landed so far.
    type Observation = { health: unknown; sessions: number };
    const answered: (Observation | null)[] = [];
    const answeredBeforePass: (Observation | null)[] = [];
    const caps: (number | undefined)[] = [];
    hooks.beforeTick = (options) => {
      caps.push(options?.maxSessions);
      answeredBeforePass.push(answered.at(-1) ?? null);
      const slot = answered.length;
      answered.push(null);
      const app = hooks.app as FastifyInstance;
      void Promise.all([
        app.inject({ method: 'GET', url: '/api/health', headers: auth }),
        app.inject({ method: 'GET', url: '/api/sessions', headers: auth }),
      ]).then(([health, sessions]) => {
        answered[slot] = {
          health: health.json(),
          sessions: (sessions.json() as { sessions: unknown[] }).sessions.length,
        };
      });
    };

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      CLAUDE_PROJECTS_DIR: corpusRoot,
      DASHBOARD_POLL_INTERVAL_MS: '600000',
    });
    try {
      // One capped pass per session, every one handed the cap.
      expect(caps).toEqual([1, 1, 1]);
      // Before pass 1 nothing was asked yet; before passes 2 and 3 the
      // previous request had been answered - after one and two sessions had
      // landed - while the replay was still running.
      expect(answeredBeforePass).toEqual([
        null,
        {
          health: expect.objectContaining({ status: 'replaying', ingest: 'replaying' }),
          sessions: 1,
        },
        {
          health: expect.objectContaining({ status: 'replaying', ingest: 'replaying' }),
          sessions: 2,
        },
      ]);

      const after = await server.app.inject({ method: 'GET', url: '/api/health', headers: auth });
      expect(after.json()).toMatchObject({ status: 'ok', ingest: 'idle' });
      const sessions = await server.app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: auth,
      });
      expect((sessions.json() as { sessions: unknown[] }).sessions).toHaveLength(3);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('corpus replay: 3/3 sessions ok'),
      );
    } finally {
      await server.close();
    }
  });
});
