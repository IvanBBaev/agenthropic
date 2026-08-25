/**
 * Ingest-coverage visibility. `unpricedTokens` already discloses tokens that are
 * IN the database without a dollar figure; this closes the opposite and larger
 * gap - sessions that are not in the database at all, because ingest could not
 * read or price them. Their tokens are in no total and no counter, and the
 * omission is one-directional: a total missing sessions is always too SMALL, so
 * the failure mode is a dashboard that quietly under-reports spend and looks
 * healthy doing it.
 *
 * Pinned here at the `buildServer` seam (present / absent / a genuine zero) on
 * both routes that publish dollar figures, and end-to-end through the real
 * composition root over a corpus that genuinely cannot be priced.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFixture } from '@agenthropic/test-fixtures';
import { openDatabase, runMigrations, start } from '../src/index';
import { buildServer } from '../src/server';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

describe('/api/health ingest exclusions', () => {
  it("mirrors the seam's answer", async () => {
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 0,
      ingestExclusions: () => ({ failing: 5, quarantined: 3 }),
    });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });

      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({
        status: 'ok',
        schemaVersion: 0,
        sessionsExcluded: 5,
        sessionsQuarantined: 3,
      });
    } finally {
      await app.close();
    }
  });

  it("stays 'ok' while sessions are excluded", async () => {
    // Deliberate: an excluded session is a COVERAGE fact, not a liveness fault.
    // Flipping `status` would make every unpriced model look like a broken
    // server to a probe, and a probe that cries wolf gets muted - after which
    // the honest fields here are the only thing left telling the truth.
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 0,
      ingestExclusions: () => ({ failing: 16, quarantined: 16 }),
    });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });

      expect(health.json()).toMatchObject({ status: 'ok', sessionsExcluded: 16 });
    } finally {
      await app.close();
    }
  });

  it('reports a genuine zero rather than hiding it', async () => {
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 0,
      ingestExclusions: () => ({ failing: 0, quarantined: 0 }),
    });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });

      expect(health.json()).toEqual({
        status: 'ok',
        schemaVersion: 0,
        sessionsExcluded: 0,
        sessionsQuarantined: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('omits both fields when no ingest seam is wired', async () => {
    // "We did not ask" and "we asked and the answer is none" are different
    // facts. A zero here would assert the second while meaning the first.
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0 });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });

      expect(health.json()).toEqual({ status: 'ok', schemaVersion: 0 });
    } finally {
      await app.close();
    }
  });
});

describe('/api/cost/summary coverage', () => {
  let temp: TempDb;

  afterEach(() => {
    temp.cleanup();
  });

  function seeded(): TempDb {
    temp = createMigratedTempDb();
    temp.db.exec(`
      INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
        ('s1', 'proj-x', '2026-07-10T00:00:00Z', '2026-07-11T02:00:00Z', 'active');
      INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
        ('s1', NULL, 'c1', 'claude-fable-5', 'input', 1000000, 0, '2026-07-10T01:00:00Z');
    `);
    return temp;
  }

  it('carries the coverage object alongside the dollar figures it qualifies', async () => {
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 7,
      db: seeded().db,
      ingestExclusions: () => ({ failing: 16, quarantined: 16 }),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/cost/summary',
        headers: AUTH,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // The totals stay exactly what the stored rows say - coverage QUALIFIES
      // the figure, it never adjusts it. Guessing at the missing sessions'
      // spend would be the same sin as pricing an unknown model at $0.
      expect(body.totals.costUsd).toBeCloseTo(10, 9);
      expect(body.coverage).toEqual({ sessionsExcluded: 16, sessionsQuarantined: 16 });
    } finally {
      await app.close();
    }
  });

  it('omits coverage entirely when no ingest seam is wired', async () => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: seeded().db });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/cost/summary',
        headers: AUTH,
      });

      expect(response.json().coverage).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe('the exclusion counts over a corpus that cannot be priced', () => {
  const SLUG = '-Users-synthetic-unpriceable-project';
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a halt-gate refusal becomes a visible exclusion on both routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-exclusions-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agent.db');
    const corpusRoot = join(dir, 'projects');

    const db = openDatabase(dbPath);
    runMigrations(db);
    db.close();

    // The fixture prices against `synthetic-model-a`, and the rows for it are
    // deliberately NOT seeded: this is the real 16-of-52 failure the dashboard
    // hits on a live corpus whenever a new model ships before its price does.
    const fixture = getFixture('flat-tool-use');
    const sessionId = fixture.files
      .find((f) => !f.relativePath.includes('/'))!
      .relativePath.slice(0, -'.jsonl'.length);
    for (const f of fixture.files) {
      const rel = f.relativePath.includes('/')
        ? join(sessionId, ...f.relativePath.split('/'))
        : f.relativePath;
      const abs = join(corpusRoot, SLUG, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.lines.join('\n') + '\n');
    }

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      CLAUDE_PROJECTS_DIR: corpusRoot,
      DASHBOARD_POLL_INTERVAL_MS: '600000', // park the poll loop: one replay only
    });
    try {
      const health = await server.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: AUTH,
      });
      // One replay pass = attempt 1 of the retry budget: excluded from the
      // totals right now, but not yet abandoned, so not yet quarantined.
      expect(health.json()).toMatchObject({
        status: 'ok',
        sessionsExcluded: 1,
        sessionsQuarantined: 0,
      });

      const summary = await server.app.inject({
        method: 'GET',
        url: '/api/cost/summary',
        headers: AUTH,
      });
      const body = summary.json();
      // The whole point, in one pair of assertions: the totals are $0 and
      // look complete, and only `coverage` says they are not.
      expect(body.totals).toEqual({ tokens: 0, costUsd: 0, unpricedTokens: 0 });
      expect(body.coverage).toEqual({ sessionsExcluded: 1, sessionsQuarantined: 0 });
    } finally {
      await server.close();
    }
  });

  it('an ingest-less server publishes no coverage claim at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-exclusions-off-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agent.db');

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      DASHBOARD_INGEST: 'false',
    });
    try {
      const health = await server.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: AUTH,
      });
      const body = health.json() as Record<string, unknown>;

      expect(body.status).toBe('ok');
      // With no watcher there is no exclusion set to report - and reporting a
      // zero would claim a completeness nobody measured.
      expect(body).not.toHaveProperty('sessionsExcluded');
      expect(body).not.toHaveProperty('sessionsQuarantined');
    } finally {
      await server.close();
    }
  });
});
