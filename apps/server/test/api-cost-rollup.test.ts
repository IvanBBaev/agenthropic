/**
 * WP-U4 - the single-scan cost rollup, at the edges the happy-path suite does
 * not reach.
 *
 * `getCostSummary` derives totals, per-model, per-day and top-sessions from ONE
 * pass over `token_usage` instead of four. Aggregating in TypeScript means the
 * ordering and the null-slug fallback are now this layer's responsibility
 * rather than SQL's, so they are asserted here explicitly: a refactor that
 * scans less must not quietly rank differently or drop a row it cannot label.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import type { SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * Four exactly-$3 slices, arranged so that BOTH rankings are decided purely by
 * the tie-break: every session is worth $3, and the two models are worth $6
 * each. Seeded rates (WP-C1) make the amounts exact integers - fable input
 * $10/Mtok so 300k = $3, sonnet output $15/Mtok so 200k = $3 - because a
 * ranking test that leans on float slop tests the slop, not the ranking.
 *
 * `orphan` has usage but no `sessions` row: the state a corpus is in when a
 * transcript is deleted while its usage rows remain.
 */
function seed(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
      ('s-c', 'proj-c', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active'),
      ('s-a', 'proj-a', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active'),
      ('s-b', 'proj-b', '2026-07-11T00:00:00Z', '2026-07-11T02:00:00Z', 'active');
    INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
      ('s-a',    NULL, 'm1', 'claude-fable-5',  'input',  300000, 0, '2026-07-10T01:00:00Z'),
      ('s-c',    NULL, 'm2', 'claude-fable-5',  'input',  300000, 0, '2026-07-10T09:00:00Z'),
      ('s-b',    NULL, 'm3', 'claude-sonnet-5', 'output', 200000, 0, '2026-07-11T01:00:00Z'),
      ('orphan', NULL, 'm4', 'claude-sonnet-5', 'output', 200000, 0, '2026-07-12T01:00:00Z');
  `);
}

interface CostRow {
  readonly costUsd: number;
}

describe('/api/cost/summary rollup edges', () => {
  let temp: TempDb;
  let app: FastifyInstance;

  beforeEach(async () => {
    temp = createMigratedTempDb();
    seed(temp.db);
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 8, db: temp.db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    temp.cleanup();
  });

  it('breaks equal-cost ties by key, ascending, so the ranking is stable', async () => {
    const body = (
      await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH })
    ).json();

    // All four sessions are worth $3, so only the tie-break can order them -
    // and it orders by id, byte-wise ascending, exactly as the SQL it replaces.
    const sessions = body.topSessions as Array<{ sessionId: string; costUsd: number }>;
    expect(sessions.map((s) => s.sessionId)).toEqual(['orphan', 's-a', 's-b', 's-c']);
    for (const session of sessions) {
      expect(session.costUsd).toBeCloseTo(3, 9);
    }

    // Both models are worth $6, so the model name decides.
    const models = body.perModel as Array<{ model: string; costUsd: number }>;
    expect(models.map((m) => m.model)).toEqual(['claude-fable-5', 'claude-sonnet-5']);
    expect(models[0]?.costUsd).toBeCloseTo(6, 9);
    expect(models[1]?.costUsd).toBeCloseTo(6, 9);
  });

  it('keeps days newest-first regardless of insertion order', async () => {
    const body = (
      await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH })
    ).json();
    const days = body.perDay as Array<{ day: string; costUsd: number }>;
    expect(days.map((d) => d.day)).toEqual(['2026-07-12', '2026-07-11', '2026-07-10']);
    // 07-10 carries two sessions, so the day bucket has to merge rather than
    // overwrite - the arm a single-row-per-day fixture never exercises.
    expect(days[2]?.costUsd).toBeCloseTo(6, 9);
  });

  it('reports usage from a session with no sessions row, with a null slug', async () => {
    const body = (
      await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH })
    ).json();
    const orphan = (
      body.topSessions as Array<{ sessionId: string; projectSlug: string | null; costUsd: number }>
    ).find((s) => s.sessionId === 'orphan');
    // Dropping it would hide $3 of real spend; inventing a slug would be worse.
    expect(orphan?.projectSlug).toBeNull();
    expect(orphan?.costUsd).toBeCloseTo(3, 9);
    expect(body.totals.costUsd).toBeCloseTo(12, 9);
  });

  it('totals equal the sum of every breakdown, so no pass disagrees with another', async () => {
    const body = (
      await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH })
    ).json();
    const sum = (rows: CostRow[]): number => rows.reduce((acc, row) => acc + row.costUsd, 0);
    expect(sum(body.perModel as CostRow[])).toBeCloseTo(body.totals.costUsd, 9);
    expect(sum(body.perDay as CostRow[])).toBeCloseTo(body.totals.costUsd, 9);
    expect(sum(body.topSessions as CostRow[])).toBeCloseTo(body.totals.costUsd, 9);
  });
});

describe('/api/sessions paging past the end', () => {
  it('returns an empty page without pricing anything', async () => {
    const temp = createMigratedTempDb();
    temp.db.exec(`
      INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
      VALUES ('only', 'proj', '2026-07-10T00:00:00Z', '2026-07-10T01:00:00Z', 'active');
    `);
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 8, db: temp.db });
    try {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions?limit=10&offset=10',
        headers: AUTH,
      });
      expect(response.statusCode).toBe(200);
      // The total still reports the session that exists - an empty PAGE is not
      // an empty corpus, and conflating them would understate the truth.
      expect(response.json()).toEqual({ sessions: [], total: 1, limit: 10, offset: 10 });
    } finally {
      await app.close();
      temp.cleanup();
    }
  });
});
