/**
 * WP-C4 + WP-C5 - GET /api/sessions/:id/cost-analysis against a REAL on-disk
 * fixture corpus (mkdtemp, never the live ~/.claude/projects) and a real
 * migrated temp-file database.
 *
 * The `task-notification-recovery` fixture is the ideal probe: its main
 * transcript carries a `compact_boundary` (WP-C4 segmentation) and its
 * subagent carries the only usage rows while the MAIN agent has none - so the
 * default WP-C5 ancestor derivation finds no settled model and must honestly
 * SKIP the subagent, while `?topTierModel=` prices the explicit alternative.
 *
 * Honesty rules under test: `isEstimate: true` stays visible, a priceless
 * model is an explicit 422 (never a silent $0), and every internal corruption
 * (crafted corpus, unparsable usage timestamp) surfaces as the uniform
 * detail-free 500.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getFixture, type Fixture } from '@agenthropic/test-fixtures';
import { buildServer } from '../src/server';
import { createSubstrateProvider, type SubstrateProvider } from '../src/api/substrate-provider';
import type { CorpusFs } from '../src/corpus/index';
import type { SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, TEST_TOKEN } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const SLUG = '-Users-synthetic-cost-analysis-project';
/** The fixture's session id (its bare `<uuid>.jsonl` stem). */
const SESSION_ID = '33333333-4444-4555-8666-777777777777';
const AGENT_HEX = 'c0ffee42';
const URL = `/api/sessions/${SESSION_ID}/cost-analysis`;
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

// Fixture usage (subagent only): input 19 + cacheRead 3100 + output 64 = 3183
// tokens. At $1/Mtok on every bucket that is $0.003183; at $10/Mtok, $0.03183.
const ACTUAL_USD = 0.003183;
const HYPOTHETICAL_USD = 0.03183;

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

describe('/api/sessions/:id/cost-analysis (WP-C4 + WP-C5)', () => {
  const dirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A throwaway parent dir; `projects/` inside it is the corpus root (may stay absent). */
  function newCorpusRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-cost-analysis-'));
    dirs.push(dir);
    return join(dir, 'projects');
  }

  /**
   * Lay the fixture out on REAL disk the way Claude Code does (bare
   * `<uuid>.jsonl` main + `<uuid>/subagents/**`), optionally rewriting lines
   * to produce corrupted variants.
   */
  function materializeFixture(
    corpusRoot: string,
    fixture: Fixture,
    mapLine: (relativePath: string, line: string) => string = (_rel, line) => line,
  ): void {
    for (const f of fixture.files) {
      const rel = f.relativePath.includes('/')
        ? join(SESSION_ID, ...f.relativePath.split('/'))
        : f.relativePath;
      const abs = join(corpusRoot, SLUG, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.lines.map((line) => mapLine(f.relativePath, line)).join('\n') + '\n');
    }
  }

  function seedPricing(db: SqliteDatabase, model: string, usdPerMtok: number): void {
    const insert = db.prepare(
      'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
    );
    for (const bucket of BUCKETS) {
      insert.run(model, bucket, usdPerMtok, '2020-01-01');
    }
  }

  function providerFor(corpusRoot: string): SubstrateProvider {
    // Explicit env only - the provider must never see the real ~/.claude.
    return createSubstrateProvider({ env: { CLAUDE_PROJECTS_DIR: corpusRoot } });
  }

  async function startApp(substrateProvider?: SubstrateProvider): Promise<{
    app: FastifyInstance;
    db: SqliteDatabase;
  }> {
    const temp = createMigratedTempDb();
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 7,
      db: temp.db,
      substrateProvider,
    });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      temp.cleanup();
    });
    return { app, db: temp.db };
  }

  /** Fixture corpus on disk + app whose db has the given per-model $/Mtok rates. */
  async function startFixtureApp(
    models: ReadonlyArray<readonly [string, number]>,
  ): Promise<FastifyInstance> {
    const corpusRoot = newCorpusRoot();
    materializeFixture(corpusRoot, getFixture('task-notification-recovery'));
    const { app, db } = await startApp(providerFor(corpusRoot));
    for (const [model, rate] of models) {
      seedPricing(db, model, rate);
    }
    return app;
  }

  it('requires auth (401 without a token)', async () => {
    const app = await startFixtureApp([['synthetic-model-a', 1]]);
    const response = await app.inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized.' });
  });

  it('replies 503 when no substrate provider is configured', async () => {
    const { app } = await startApp(undefined);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'corpus access is not configured' });
  });

  it('replies 404 when the corpus root does not exist', async () => {
    const { app } = await startApp(providerFor(newCorpusRoot()));
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Session not found.' });
  });

  it('replies 404 for a session id no enumerated session matches', async () => {
    const app = await startFixtureApp([['synthetic-model-a', 1]]);
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/eeeeeeee-0000-4000-8000-000000000000/cost-analysis',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Session not found.' });
  });

  it('replies 404 for a session whose substrate yields nothing parseable', async () => {
    const corpusRoot = newCorpusRoot();
    const emptyId = 'eeeeeeee-0000-4000-8000-000000000000';
    mkdirSync(join(corpusRoot, SLUG), { recursive: true });
    writeFileSync(join(corpusRoot, SLUG, `${emptyId}.jsonl`), '');
    const { app } = await startApp(providerFor(corpusRoot));
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${emptyId}/cost-analysis`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Session not found.' });
  });

  it('reprices across the compaction boundary with the delta ~0 invariant intact', async () => {
    const app = await startFixtureApp([['synthetic-model-a', 1]]);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(200);
    const { compaction } = response.json();

    expect(compaction.naiveUsd).toBeCloseTo(ACTUAL_USD, 12);
    expect(compaction.repricedUsd).toBeCloseTo(ACTUAL_USD, 12);
    expect(compaction.deltaUsd).toBeCloseTo(0, 12);
    expect(compaction.compactionCount).toBe(1);

    // Main transcript first (both its segments empty - the fixture's usage all
    // lives on the subagent), then the subagent's single segment.
    expect(compaction.segments).toHaveLength(3);
    expect(compaction.segments[0]).toEqual({
      agentId: null,
      index: 0,
      boundary: null,
      usd: 0,
      messageCount: 0,
      tokens: ZERO_TOKENS,
    });
    expect(compaction.segments[1]).toEqual({
      agentId: null,
      index: 1,
      boundary: {
        agentId: null,
        timestamp: '2026-01-17T14:00:00.000Z',
        trigger: 'auto',
        preTokens: 165000,
      },
      usd: 0,
      messageCount: 0,
      tokens: ZERO_TOKENS,
    });
    const agentSegment = compaction.segments[2];
    expect(agentSegment.agentId).toBe(AGENT_HEX);
    expect(agentSegment.index).toBe(0);
    expect(agentSegment.boundary).toBeNull();
    expect(agentSegment.usd).toBeCloseTo(ACTUAL_USD, 12);
    expect(agentSegment.messageCount).toBe(1);
    expect(agentSegment.tokens).toEqual({
      input: 19,
      output: 64,
      cacheRead: 3100,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
  });

  it('skips a subagent with no derivable top-tier model - honest skip, never a guess', async () => {
    const app = await startFixtureApp([['synthetic-model-a', 1]]);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(200);
    // The fixture's MAIN agent has no usage rows, so ancestor derivation finds
    // no settled model: the subagent lands in skippedAgentIds with zero sums.
    expect(response.json().delegationSavings).toEqual({
      actualUsd: 0,
      hypotheticalUsd: 0,
      savingsUsd: 0,
      perAgent: [],
      skippedAgentIds: [AGENT_HEX],
      isEstimate: true,
    });
  });

  it('?topTierModel= prices the explicit routing alternative, isEstimate kept', async () => {
    const app = await startFixtureApp([
      ['synthetic-model-a', 1],
      ['synthetic-model-b', 10],
    ]);
    const response = await app.inject({
      method: 'GET',
      url: `${URL}?topTierModel=synthetic-model-b`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const { delegationSavings } = response.json();

    expect(delegationSavings.actualUsd).toBeCloseTo(ACTUAL_USD, 12);
    expect(delegationSavings.hypotheticalUsd).toBeCloseTo(HYPOTHETICAL_USD, 12);
    expect(delegationSavings.savingsUsd).toBeCloseTo(HYPOTHETICAL_USD - ACTUAL_USD, 12);
    expect(delegationSavings.skippedAgentIds).toEqual([]);
    expect(delegationSavings.isEstimate).toBe(true);

    expect(delegationSavings.perAgent).toHaveLength(1);
    const [agent] = delegationSavings.perAgent;
    expect(agent.agentId).toBe(AGENT_HEX);
    expect(agent.parentAgentId).toBe(SESSION_ID);
    expect(agent.actualUsd).toBeCloseTo(ACTUAL_USD, 12);
    expect(agent.hypotheticalUsd).toBeCloseTo(HYPOTHETICAL_USD, 12);
    expect(agent.savingsUsd).toBeCloseTo(HYPOTHETICAL_USD - ACTUAL_USD, 12);
    expect(agent.hypotheticalModel).toBe('synthetic-model-b');
    expect(agent.isEstimate).toBe(true);
  });

  it('replies 422 naming the priceless model - never a silent $0', async () => {
    const app = await startFixtureApp([]); // no pricing rows at all
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(422);
    const { error } = response.json();
    expect(error).toContain('synthetic-model-a');
    expect(error).toContain('refusing to price at $0');
  });

  it('replies 422 when the HYPOTHETICAL model is priceless too', async () => {
    const app = await startFixtureApp([['synthetic-model-a', 1]]);
    const response = await app.inject({
      method: 'GET',
      url: `${URL}?topTierModel=unpriced-model-z`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('unpriced-model-z');
  });

  it('replies 422 on a poisoned transcript without echoing corpus internals', async () => {
    const corpusRoot = newCorpusRoot();
    materializeFixture(corpusRoot, getFixture('task-notification-recovery'), (rel, line) =>
      // Poison the FIRST main-transcript line with non-JSON garbage.
      !rel.includes('/') && line.includes('compact_boundary') ? '{this is not json' : line,
    );
    const { app, db } = await startApp(providerFor(corpusRoot));
    seedPricing(db, 'synthetic-model-a', 1);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'Session transcripts could not be parsed.' });
  });

  it('replies 400 on an invalid topTierModel query value', async () => {
    const app = await startFixtureApp([['synthetic-model-a', 1]]);
    const response = await app.inject({
      method: 'GET',
      url: `${URL}?topTierModel=`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('topTierModel');
  });

  it('maps a crafted-corpus ContainmentError to the uniform detail-free 500', async () => {
    // A CorpusFs whose readdir returns a traversal-shaped name - exactly the
    // signal enumerateSessions turns into a ContainmentError the provider must
    // NEVER swallow.
    const craftedFs: CorpusFs = {
      readDirNames: () => ['evil/slug'],
      lstat: () => {
        throw new Error('unreachable');
      },
      realpath: (absPath: string) => absPath,
      readFileConfined: () => {
        throw new Error('unreachable');
      },
    };
    const provider = createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: '/synthetic/crafted-corpus' },
      fs: craftedFs,
    });
    const { app } = await startApp(provider);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(500);
    // Uniform shape - no path, no root, no error class leaks.
    expect(response.json()).toEqual({ error: 'Internal server error.' });
  });

  it('maps an unparsable usage timestamp to the uniform detail-free 500', async () => {
    const corpusRoot = newCorpusRoot();
    // Strip the timestamp off the subagent's assistant record: the parser
    // defaults the usage row's timestamp to '' and pricing then throws a
    // RangeError - internal corruption, not a client error.
    materializeFixture(corpusRoot, getFixture('task-notification-recovery'), (rel, line) => {
      if (!rel.includes('/')) {
        return line;
      }
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['type'] !== 'assistant') {
        return line;
      }
      delete record['timestamp'];
      return JSON.stringify(record);
    });
    const { app, db } = await startApp(providerFor(corpusRoot));
    seedPricing(db, 'synthetic-model-a', 1);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error.' });
  });
});
