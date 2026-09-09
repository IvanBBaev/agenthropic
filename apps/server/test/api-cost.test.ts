/**
 * WP-U4 - /api/cost/summary against a real migrated temp-file database.
 * Seeded rates (WP-C1): claude-fable-5 input $10 / output $50 per Mtok,
 * claude-sonnet-5 input $3 / output $15 per Mtok.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import type { SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

function seed(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
      ('s1', 'proj-x', '2026-07-10T00:00:00Z', '2026-07-11T02:00:00Z', 'active'),
      ('s2', 'proj-y', '2026-07-11T00:00:00Z', '2026-07-11T03:00:00Z', 'active');
    INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
      ('s1', NULL, 'c1', 'claude-fable-5', 'input', 1000000, 0, '2026-07-10T01:00:00Z'),
      ('s1', NULL, 'c2', 'claude-sonnet-5', 'output', 1000000, 0, '2026-07-11T01:00:00Z'),
      ('s2', NULL, 'c3', 'claude-fable-5', 'output', 200000, 0, '2026-07-11T02:00:00Z'),
      ('s2', NULL, 'c4', 'unknown-model', 'input', 400, 0, '2026-07-11T03:00:00Z'),
      ('s2', NULL, 'c5', 'claude-fable-5', 'input', 300, 0, NULL);
  `);
}

describe('/api/cost/summary (WP-U4)', () => {
  let temp: TempDb;
  let app: FastifyInstance;

  beforeEach(async () => {
    temp = createMigratedTempDb();
    seed(temp.db);
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    temp.cleanup();
  });

  it('requires auth (401 without a token)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/cost/summary' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized.' });
  });

  it('totals trace to tokens x seeded prices, with unpriced tokens surfaced', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // c1: 1M input fable = $10; c2: 1M output sonnet = $15; c3: 0.2M output
    // fable = $10. c4 (unknown model) and c5 (no timestamp) are unpriceable.
    expect(body.totals.tokens).toBe(2_200_700);
    expect(body.totals.costUsd).toBeCloseTo(35, 9);
    expect(body.totals.unpricedTokens).toBe(700);
  });

  it('breaks cost down per model, ordered by cost descending', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
    const { perModel } = response.json();
    expect(perModel.map((m: { model: string }) => m.model)).toEqual([
      'claude-fable-5',
      'claude-sonnet-5',
      'unknown-model',
    ]);
    const [fable, sonnet, unknown] = perModel;
    expect(fable.tokens).toBe(1_200_300);
    expect(fable.costUsd).toBeCloseTo(20, 9);
    expect(fable.unpricedTokens).toBe(300);
    expect(sonnet.costUsd).toBeCloseTo(15, 9);
    // The unknown model shows $0 WITH its tokens flagged unpriced - the
    // estimated-is-never-silently-zero rule.
    expect(unknown).toEqual({
      model: 'unknown-model',
      tokens: 400,
      costUsd: 0,
      unpricedTokens: 400,
    });
  });

  it('breaks cost down per day, newest first, with the unknown-day bucket last', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
    const { perDay } = response.json();
    expect(perDay.map((d: { day: string }) => d.day)).toEqual([
      '2026-07-11',
      '2026-07-10',
      'unknown',
    ]);
    const [day11, day10, unknownDay] = perDay;
    expect(day11.tokens).toBe(1_200_400);
    expect(day11.costUsd).toBeCloseTo(25, 9);
    expect(day11.unpricedTokens).toBe(400);
    expect(day10.costUsd).toBeCloseTo(10, 9);
    expect(unknownDay).toEqual({ day: 'unknown', tokens: 300, costUsd: 0, unpricedTokens: 300 });
  });

  it('ranks top sessions by cost and honors the topN cap', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
    const { topSessions } = all.json();
    expect(
      topSessions.map((s: { sessionId: string; projectSlug: string }) => [
        s.sessionId,
        s.projectSlug,
      ]),
    ).toEqual([
      ['s1', 'proj-x'],
      ['s2', 'proj-y'],
    ]);
    expect(topSessions[0].costUsd).toBeCloseTo(25, 9);
    expect(topSessions[1].costUsd).toBeCloseTo(10, 9);
    expect(topSessions[1].unpricedTokens).toBe(700);

    const limited = await app.inject({
      method: 'GET',
      url: '/api/cost/summary?topN=1',
      headers: AUTH,
    });
    expect(limited.json().topSessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      's1',
    ]);

    for (const url of ['/api/cost/summary?topN=100', '/api/cost/summary?topN=0']) {
      const rejected = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toContain('topN');
    }
  });

  it('returns honest zeros on a virgin database', async () => {
    const empty = createMigratedTempDb();
    const emptyApp = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: empty.db });
    try {
      const response = await emptyApp.inject({
        method: 'GET',
        url: '/api/cost/summary',
        headers: AUTH,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totals: { tokens: 0, costUsd: 0, unpricedTokens: 0 },
        perModel: [],
        perDay: [],
        topSessions: [],
      });
    } finally {
      await emptyApp.close();
      empty.cleanup();
    }
  });

  /**
   * Every internal failure of this route must reach the client as the same
   * opaque envelope. Asserted on the RAW payload as well as the parsed body,
   * because a leak would arrive as extra text (a SQL fragment, a table name, a
   * stack frame) that a shape assertion on `{ error }` alone would not see.
   */
  async function expectUniform500(): Promise<void> {
    const response = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error.' });
    // The vocabulary of the three throws below, plus the words a stack or a
    // SQLite message would carry. None of it may cross the HTTP boundary.
    for (const secret of [
      'token_usage_rollup',
      'model_pricing',
      'SELECT',
      'SQLITE',
      'no such table',
      'refusing',
      'canonicalization',
      'effective_from',
      'stack',
      '.ts:',
    ]) {
      expect(response.payload).not.toContain(secret);
    }
  }

  it('maps an internal query failure to the uniform 500 shape without leaking details', async () => {
    // The fault is injected into the table this read is actually bound to.
    // Before M-19 this test dropped `token_usage`; the cutover made that a
    // no-op for /api/cost/summary, so the test would have passed with a 200
    // while claiming to prove a 500. `token_usage_rollup` is what the read
    // scans, and dropping it exercises the documented NO FALLBACK contract:
    // there is deliberately no "scan the ledger instead" arm, so the request
    // must fail loudly rather than serve a silently different number.
    temp.db.exec('DROP TABLE token_usage_rollup');
    await expectUniform500();
  });

  it('refuses, opaquely, when the rollup names a pricing row that is gone', async () => {
    // Torn invariant, arm one: a rollup row carrying a `rate_effective_from`
    // no `model_pricing` row can satisfy. Costing it at $0 would present real
    // priced spend as unpriced, so the read throws - and the client sees only
    // the uniform envelope.
    const torn = temp.db
      .prepare(
        `UPDATE token_usage_rollup
            SET rate_effective_from = '2999-01-01T00:00:00.000Z'
          WHERE rate_effective_from <> ''`,
      )
      .run();
    // Guards the guard: a fault that injected nothing would leave a passing
    // 200 masquerading as this test's premise.
    expect(torn.changes).toBeGreaterThan(0);
    await expectUniform500();
  });

  it('refuses, opaquely, when two pricing rows mean the same instant', async () => {
    // Torn invariant, arm two: two `model_pricing` rows that canonicalize to
    // one instant. A SQL LEFT JOIN would emit the rollup row twice and double
    // its dollars in silence; the JS rate map makes it a throw. Reaching it
    // requires dropping migration 14's canonicalizing trigger first - through
    // SQL alone the second row collides on the primary key instead.
    temp.db.exec(`
      DROP TRIGGER model_pricing_effective_from_canonical_insert;
      INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES
        ('claude-fable-5', 'input', 10, '2026-02-01T00:00:00.000Z'),
        ('claude-fable-5', 'input', 99, '2026-02-01');
    `);
    await expectUniform500();
  });
});
