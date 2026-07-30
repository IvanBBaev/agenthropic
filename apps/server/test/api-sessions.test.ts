/**
 * WP-U3 - /api/sessions list, detail and tree endpoints against a real
 * migrated temp-file database seeded by direct SQL. Every dollar asserted
 * here traces to seeded tokens x the WP-C1 seeded price rows
 * (claude-fable-5: input $10/Mtok, output $50/Mtok).
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
      ('session-a', 'proj-a', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active'),
      ('session-b', 'proj-b', '2026-07-12T00:00:00Z', '2026-07-12T01:00:00Z', 'active');
    INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at) VALUES
      ('a-main', 'session-a', 'main', NULL, 'working', NULL, '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z'),
      ('a-sub1', 'session-a', 'subagent', 'explorer', 'completed', 'a-main', '2026-07-10T00:10:00Z', '2026-07-10T01:00:00Z'),
      ('a-sub2', 'session-a', 'subagent', NULL, NULL, 'a-main', '2026-07-10T00:20:00Z', '2026-07-10T00:30:00Z');
    INSERT INTO orchestration_edges (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at) VALUES
      ('session-a', 'a-main', 'a-sub1', 'tool_use', 'default', 'host-1', '2026-07-10T00:10:00Z'),
      ('session-a', 'a-main', 'a-sub2', 'task_notification', 'default', 'host-1', '2026-07-10T00:20:00Z');
    INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
      ('session-a', 'a-sub1', 'm1', 'claude-fable-5', 'input', 1000000, 0, '2026-07-10T01:00:00Z'),
      ('session-a', NULL, 'm2', 'claude-fable-5', 'output', 100000, 0, '2026-07-10T01:30:00Z'),
      ('session-a', 'a-sub1', 'm3', 'mystery-model', 'input', 500, 0, '2026-07-10T01:40:00Z'),
      ('session-a', 'a-sub1', 'm4', 'claude-fable-5', 'input', 250, 0, NULL),
      ('session-a', 'ghost-agent', 'm5', 'claude-fable-5', 'input', 111, 0, '2026-07-10T01:50:00Z');
  `);
}

describe('session endpoints (WP-U3)', () => {
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

  it('requires auth on every session route (401 without a token)', async () => {
    for (const url of [
      '/api/sessions',
      '/api/sessions/session-a',
      '/api/sessions/session-a/tree',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Unauthorized.' });
    }
  });

  it('lists sessions recent-first with agent, token, cost and status rollups', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions', headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50); // schema default applied
    expect(body.offset).toBe(0);
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['session-b', 'session-a']);

    const [sessionB, sessionA] = body.sessions;
    // The empty session reports honest zeros, not absent fields.
    expect(sessionB).toMatchObject({
      projectSlug: 'proj-b',
      agentCount: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      unpricedTokens: 0,
      statusCounts: { working: 0, waiting: 0, completed: 0, error: 0, unknown: 0 },
    });
    // m1 $10 + m2 $5 + m5 $0.00111; m3 (unknown model) and m4 (no timestamp)
    // stay unpriced - never silently $0-priced into the total silently.
    expect(sessionA.agentCount).toBe(3);
    expect(sessionA.totalTokens).toBe(1_100_861);
    expect(sessionA.totalCostUsd).toBeCloseTo(15.00111, 6);
    expect(sessionA.unpricedTokens).toBe(750);
    // The NULL-status agent lands in `unknown` - absence of status IS unknown.
    expect(sessionA.statusCounts).toEqual({
      working: 1,
      waiting: 0,
      completed: 1,
      error: 0,
      unknown: 1,
    });
  });

  it('paginates with defaults, honors offset, and 400s above the caps', async () => {
    const page = await app.inject({
      method: 'GET',
      url: '/api/sessions?limit=1&offset=1',
      headers: AUTH,
    });
    const body = page.json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['session-a']);
    expect(body).toMatchObject({ total: 2, limit: 1, offset: 1 });

    const overLimit = await app.inject({
      method: 'GET',
      url: '/api/sessions?limit=1000',
      headers: AUTH,
    });
    expect(overLimit.statusCode).toBe(400);
    expect(overLimit.json().error).toContain('limit');

    const overOffset = await app.inject({
      method: 'GET',
      url: '/api/sessions?offset=2000000',
      headers: AUTH,
    });
    expect(overOffset.statusCode).toBe(400);

    const zeroLimit = await app.inject({
      method: 'GET',
      url: '/api/sessions?limit=0',
      headers: AUTH,
    });
    expect(zeroLimit.statusCode).toBe(400);
  });

  it('serves the session detail with edge count and per-model cost rollup', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-a',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe('session-a');
    expect(body.edgeCount).toBe(2);
    expect(body.models).toHaveLength(2);
    const [fable, mystery] = body.models; // ordered by cost DESC
    expect(fable.model).toBe('claude-fable-5');
    expect(fable.tokens).toBe(1_100_361);
    expect(fable.costUsd).toBeCloseTo(15.00111, 6);
    expect(fable.unpricedTokens).toBe(250); // m4: no timestamp, no dated rate
    // The unknown model is FULLY unpriced - $0 with every token surfaced.
    expect(mystery).toEqual({
      model: 'mystery-model',
      tokens: 500,
      costUsd: 0,
      unpricedTokens: 500,
    });
  });

  it('404s (uniform error shape) for an unknown session id', async () => {
    for (const url of ['/api/sessions/nope', '/api/sessions/nope/tree']) {
      const response = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Session not found.' });
    }
  });

  it('serves the tree from persisted rows: agents, edges with verbatim source, unattributed usage', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-a/tree',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sessionId).toBe('session-a');
    expect(body.agentCount).toBe(3);
    expect(body.edgeCount).toBe(2);

    // first_seen_at order; parent linkage is the persisted data fact.
    expect(body.agents.map((a: { id: string }) => a.id)).toEqual(['a-main', 'a-sub1', 'a-sub2']);
    const [main, sub1, sub2] = body.agents;
    expect(main.parentAgentId).toBeNull();
    expect(sub1.parentAgentId).toBe('a-main');
    expect(sub2.parentAgentId).toBe('a-main');
    expect(sub2.status).toBeNull(); // served as stored, not coerced

    // Per-agent rollup: m1 + m3 + m4 belong to a-sub1.
    expect(sub1.totalTokens).toBe(1_000_750);
    expect(sub1.costUsd).toBeCloseTo(10, 9);
    expect(sub1.unpricedTokens).toBe(750);
    expect(main.totalTokens).toBe(0);

    // Edge provenance is served verbatim - the inferred (task_notification)
    // edge stays distinguishable from the observed tool_use one.
    expect(
      body.edges.map((e: { childAgentId: string; source: string }) => [e.childAgentId, e.source]),
    ).toEqual([
      ['a-sub1', 'tool_use'],
      ['a-sub2', 'task_notification'],
    ]);

    // m2 (agent_id NULL) + m5 (agent_id pointing at no agent row) are shown
    // as unattributed - never dropped, never guessed onto an agent.
    expect(body.unattributed.totalTokens).toBe(100_111);
    expect(body.unattributed.costUsd).toBeCloseTo(5.00111, 6);
    expect(body.unattributed.unpricedTokens).toBe(0);
  });

  it('returns the honest empty shape on a virgin database', async () => {
    const empty = createMigratedTempDb();
    const emptyApp = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: empty.db });
    try {
      const response = await emptyApp.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: AUTH,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ sessions: [], total: 0, limit: 50, offset: 0 });
    } finally {
      await emptyApp.close();
      empty.cleanup();
    }
  });

  it('without a db handle the API routes stay unregistered (404 as before)', async () => {
    const bare = buildServer({ token: TEST_TOKEN, schemaVersion: 7 });
    try {
      const response = await bare.inject({ method: 'GET', url: '/api/sessions', headers: AUTH });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
