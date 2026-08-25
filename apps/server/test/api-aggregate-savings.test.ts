/**
 * M-9 (aggregate half) - GET /api/cost/delegation-savings against a real
 * migrated temp-file database.
 *
 * Seeded rates (WP-C1, migration 7): output $/Mtok is claude-fable-5 50,
 * claude-sonnet-5 15, claude-opus-4-8 25, claude-haiku-4-5-20251001 5. Every
 * expectation below is written so the arithmetic is checkable by hand from
 * those four numbers.
 *
 * The scope counters are the point of this endpoint as much as the dollars
 * are: an aggregate computed over an unstated subset would be a lie, so each
 * exclusion path (unpriceable model, undated row, untyped agent, underivable
 * top-tier model) has a test asserting BOTH that the figure survives and that
 * the exclusion is named in the payload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MAX_AGGREGATE_SKIPPED_SAMPLE } from '@agenthropic/shared';
import { buildServer } from '../src/server';
import type { SqliteDatabase } from '../src/db/connection';
import { getAggregateDelegationSavings } from '../src/api/queries';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const URL = '/api/cost/delegation-savings';
const AT = '2026-07-10T01:00:00Z';

/**
 * Two sessions: `s-deleg` delegates (main -> a-1 -> a-2, a two-level chain so
 * ancestor-derived top-tier models differ per subagent), `s-solo` does not.
 *
 * Hand arithmetic for `s-deleg`:
 * - a-1 runs 1 Mtok output on sonnet = $15 actual; its nearest usage-bearing
 *   ancestor is the main agent on fable, so the hypothetical is 1 Mtok at
 *   fable output = $50, savings $35.
 * - a-2 runs 1 Mtok output on haiku = $5 actual; its ancestor a-1 settled on
 *   sonnet, so the hypothetical is $15, savings $10.
 * Totals: actual $20, hypothetical $65, savings $45.
 */
function seed(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
      ('s-deleg', 'proj-a', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active'),
      ('s-solo',  'proj-b', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active');
    INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at) VALUES
      ('m-1',    's-deleg', 'main',     NULL,       'completed', NULL,    '${AT}', '${AT}'),
      ('a-1',    's-deleg', 'subagent', 'explorer', 'completed', 'm-1',   '${AT}', '${AT}'),
      ('a-2',    's-deleg', 'subagent', 'explorer', 'completed', 'a-1',   '${AT}', '${AT}'),
      ('m-solo', 's-solo',  'main',     NULL,       'completed', NULL,    '${AT}', '${AT}');
    INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
      ('s-deleg', 'm-1',    'msg-main', 'claude-fable-5',             'output', 1000000, 0, '${AT}'),
      ('s-deleg', 'a-1',    'msg-a1',   'claude-sonnet-5',            'output', 1000000, 0, '${AT}'),
      ('s-deleg', 'a-2',    'msg-a2',   'claude-haiku-4-5-20251001',  'output', 1000000, 0, '${AT}'),
      ('s-solo',  'm-solo', 'msg-solo', 'claude-fable-5',             'output', 1000000, 0, '${AT}');
  `);
}

/**
 * A delegating session whose MAIN agent is priceable and whose single
 * SUBAGENT usage row names `model` at `occurredAt` - the estimator prices only
 * subagent rows, so a defect parked on the main agent would never be reached.
 */
function seedDelegatingSession(
  db: SqliteDatabase,
  sessionId: string,
  model: string,
  occurredAt: string | null,
): void {
  db.prepare(
    `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
     VALUES (?, 'proj-x', ?, ?, 'active')`,
  ).run(sessionId, AT, AT);
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, NULL, 'completed', ?, ?, ?)`,
  );
  insertAgent.run(`${sessionId}-main`, sessionId, 'main', null, AT, AT);
  insertAgent.run(`${sessionId}-sub`, sessionId, 'subagent', `${sessionId}-main`, AT, AT);
  const insertUsage = db.prepare(
    `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
     VALUES (?, ?, ?, ?, 'output', 1000000, 0, ?)`,
  );
  insertUsage.run(sessionId, `${sessionId}-main`, `${sessionId}-msg-main`, 'claude-fable-5', AT);
  insertUsage.run(sessionId, `${sessionId}-sub`, `${sessionId}-msg-sub`, model, occurredAt);
}

describe('/api/cost/delegation-savings (M-9 aggregate)', () => {
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
    const response = await app.inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized.' });
  });

  it('rejects a bad token exactly like its neighbours', async () => {
    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { authorization: 'Bearer wrong-token-0123456789abcdef' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized.' });
  });

  it('sums the per-subagent counterfactual across the corpus, labelled as an estimate', async () => {
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.actualUsd).toBeCloseTo(20, 9);
    expect(body.hypotheticalUsd).toBeCloseTo(65, 9);
    expect(body.savingsUsd).toBeCloseTo(45, 9);
    expect(body.isEstimate).toBe(true);
    expect(body.basis).toBe('stored-usage-rows');
    // Both derived models are named, so the reader can see WHAT the
    // hypothetical was priced against rather than trusting a bare number.
    expect(body.hypotheticalModels).toEqual(['claude-fable-5', 'claude-sonnet-5']);
  });

  it('states its scope: the non-delegating session is a measured zero, not a gap', async () => {
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    const body = response.json();
    expect(body.sessionsTotal).toBe(2);
    expect(body.sessionsWithSubagents).toBe(1);
    expect(body.sessionsPriced).toBe(1);
    expect(body.subagentsPriced).toBe(2);
    expect(body.subagentsSkipped).toBe(0);
    expect(body.untypedAgents).toBe(0);
    expect(body.skippedSessionCount).toBe(0);
    expect(body.skippedSessions).toEqual([]);
  });

  it('reprices every subagent at an explicit topTierModel when one is given', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${URL}?topTierModel=claude-opus-4-8`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // 2 Mtok output at opus $25/Mtok = $50 hypothetical against $20 actual;
    // savings is the per-agent max(0, ...) sum: (25-15) + (25-5) = $30.
    expect(body.actualUsd).toBeCloseTo(20, 9);
    expect(body.hypotheticalUsd).toBeCloseTo(50, 9);
    expect(body.savingsUsd).toBeCloseTo(30, 9);
    expect(body.hypotheticalModels).toEqual(['claude-opus-4-8']);
  });

  it('rejects an empty topTierModel with the uniform 400 shape', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${URL}?topTierModel=`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(Object.keys(response.json())).toEqual(['error']);
  });

  it('excludes an unpriceable session by NAME and still reports the rest', async () => {
    seedDelegatingSession(temp.db, 's-unknown-model', 'no-such-model', AT);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The whole aggregate does not collapse to $0, and does not silently
    // absorb the bad session either.
    expect(body.savingsUsd).toBeCloseTo(45, 9);
    expect(body.sessionsWithSubagents).toBe(2);
    expect(body.sessionsPriced).toBe(1);
    expect(body.skippedSessionCount).toBe(1);
    expect(body.skippedSessions).toHaveLength(1);
    const [skip] = body.skippedSessions;
    expect(skip.sessionId).toBe('s-unknown-model');
    expect(skip.reason).toBe('unpriceable');
    expect(skip.detail).toContain('no-such-model');
  });

  it('excludes a session whose stored usage carries no timestamp, and says so', async () => {
    seedDelegatingSession(temp.db, 's-undated', 'claude-fable-5', null);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.savingsUsd).toBeCloseTo(45, 9);
    expect(body.skippedSessions).toEqual([
      {
        sessionId: 's-undated',
        reason: 'undated-usage',
        detail: '1 stored usage row(s) carry no timestamp, so no dated rate applies',
      },
    ]);
  });

  it('caps the skipped sample while keeping the count authoritative', async () => {
    const overflow = MAX_AGGREGATE_SKIPPED_SAMPLE + 2;
    for (let i = 0; i < overflow; i += 1) {
      seedDelegatingSession(temp.db, `s-bad-${String(i).padStart(3, '0')}`, 'no-such-model', AT);
    }
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    const body = response.json();
    expect(body.skippedSessionCount).toBe(overflow);
    expect(body.skippedSessions).toHaveLength(MAX_AGGREGATE_SKIPPED_SAMPLE);
    expect(body.sessionsPriced).toBe(1);
    expect(body.savingsUsd).toBeCloseTo(45, 9);
  });

  it('counts NULL-typed agents separately instead of guessing their place in the tree', async () => {
    temp.db
      .prepare(
        `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
         VALUES ('a-untyped', 's-deleg', NULL, NULL, 'unknown', 'm-1', ?, ?)`,
      )
      .run(AT, AT);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    const body = response.json();
    expect(body.untypedAgents).toBe(1);
    // The untyped row changes nothing about the priced tree - it is reported,
    // not folded in.
    expect(body.subagentsPriced).toBe(2);
    expect(body.savingsUsd).toBeCloseTo(45, 9);
  });

  it('reports a subagent with no derivable top-tier model rather than guessing one', async () => {
    temp.db
      .prepare(
        `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
         VALUES ('a-orphan', 's-deleg', 'subagent', 'explorer', 'unknown', NULL, ?, ?)`,
      )
      .run(AT, AT);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    const body = response.json();
    expect(body.subagentsPriced).toBe(2);
    expect(body.subagentsSkipped).toBe(1);
    expect(body.savingsUsd).toBeCloseTo(45, 9);
  });

  it('treats main-agent usage stored without an agent id as main-agent usage', async () => {
    // Ingest attributes a main-transcript turn to the main agent's node id,
    // but a row that could not be joined lands with agent_id NULL. The parser
    // keys main usage as `null`, so BOTH forms must resolve the ancestor model.
    temp.db.exec(`
      INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
        ('s-nullusage', 'proj-c', '${AT}', '${AT}', 'active');
      INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at) VALUES
        ('n-main', 's-nullusage', 'main',     NULL,       'completed', NULL,     '${AT}', '${AT}'),
        ('n-sub',  's-nullusage', 'subagent', 'explorer', 'completed', 'n-main', '${AT}', '${AT}');
      INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
        ('s-nullusage', NULL,    'msg-n-main', 'claude-fable-5',  'output', 1000000, 0, '${AT}'),
        ('s-nullusage', 'n-sub', 'msg-n-sub',  'claude-sonnet-5', 'output', 1000000, 0, '${AT}');
    `);
    const response = await app.inject({ method: 'GET', url: URL, headers: AUTH });
    const body = response.json();
    expect(body.sessionsPriced).toBe(2);
    expect(body.subagentsPriced).toBe(3);
    expect(body.subagentsSkipped).toBe(0);
    // The new session repeats the a-1 arithmetic: $15 actual, $50 at fable.
    expect(body.actualUsd).toBeCloseTo(35, 9);
    expect(body.savingsUsd).toBeCloseTo(80, 9);
  });

  it('rethrows a non-pricing failure instead of laundering it into a skip note', () => {
    // A `skippedSessions` entry is a claim about the DATA's priceability. A
    // corrupt input is a different fact and must reach the route's uniform
    // detail-free 500 rather than be reported as a priced-with-exclusions
    // aggregate.
    //
    // Seeded through the pricing ARGUMENT, not the database: migration 15
    // canonicalizes every stored `occurred_at` and then makes a non-instant
    // unstorable by trigger (migration 14 does the same for
    // `model_pricing.effective_from`), so a schema-current database can no
    // longer hold either spelling of this corruption. The exported function
    // still accepts any `PricingEntry[]` — ingest passes its own — so that is
    // where the failure can genuinely originate.
    expect(() =>
      getAggregateDelegationSavings(temp.db, [
        {
          model: 'claude-sonnet-5',
          bucket: 'output',
          usdPerMtok: 1,
          effectiveFrom: 'not-a-timestamp',
        },
      ]),
    ).toThrow(RangeError);
  });
});
