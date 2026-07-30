/**
 * WP-U4 - /api/dag/global: the persisted cross-session DAG, capped and
 * counted so the client can bound its D3 render and SAY it truncated.
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
      ('s1', 'proj-x', '2026-07-10T00:00:00Z', '2026-07-10T03:00:00Z', 'active'),
      ('s2', 'proj-y', '2026-07-12T00:00:00Z', '2026-07-12T01:00:00Z', 'active');
    INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at) VALUES
      ('g-main', 's1', 'main', NULL, 'working', NULL, '2026-07-10T00:00:00Z', '2026-07-10T03:00:00Z'),
      ('g-sub1', 's1', 'subagent', 'explorer', 'completed', 'g-main', '2026-07-10T00:10:00Z', '2026-07-10T02:00:00Z'),
      ('h-main', 's2', 'main', NULL, 'completed', NULL, '2026-07-12T00:00:00Z', '2026-07-12T01:00:00Z'),
      ('h-sub1', 's2', 'subagent', 'planner', 'completed', 'h-main', '2026-07-12T00:10:00Z', '2026-07-12T00:30:00Z');
    INSERT INTO orchestration_edges (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at) VALUES
      ('s1', 'g-main', 'g-sub1', 'tool_use', 'default', 'host-1', '2026-07-10T00:10:00Z'),
      ('s2', 'h-main', 'h-sub1', 'queue_operation', 'default', 'host-1', '2026-07-12T00:10:00Z');
    INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
      ('s1', 'g-sub1', 'd1', 'claude-fable-5', 'input', 1000000, 0, '2026-07-10T01:00:00Z');
  `);
}

describe('/api/dag/global (WP-U4)', () => {
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
    const response = await app.inject({ method: 'GET', url: '/api/dag/global' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized.' });
  });

  it('serves all persisted nodes and edges recent-first with full counts', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/dag/global', headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.nodes.map((n: { id: string }) => n.id)).toEqual([
      'h-main',
      'h-sub1',
      'g-main',
      'g-sub1',
    ]);
    // Node fields carry what D3 needs: session, parent, status, cost rollup.
    const gSub1 = body.nodes[3];
    expect(gSub1).toMatchObject({
      sessionId: 's1',
      type: 'subagent',
      subagentType: 'explorer',
      status: 'completed',
      parentAgentId: 'g-main',
      totalTokens: 1_000_000,
      unpricedTokens: 0,
    });
    expect(gSub1.costUsd).toBeCloseTo(10, 9);

    // Edge provenance stays verbatim and distinguishable per edge.
    expect(body.edges.map((e: { source: string }) => e.source)).toEqual([
      'tool_use',
      'queue_operation',
    ]);
    expect(body.counts).toEqual({
      totalSessions: 2,
      totalAgents: 4,
      totalEdges: 2,
      returnedAgents: 4,
      returnedEdges: 2,
      truncated: false,
    });
  });

  it('caps nodes at ?limit, keeps only edges with both endpoints, and flags truncation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dag/global?limit=2',
      headers: AUTH,
    });
    const body = response.json();
    // The two most recent agents are both from s2, so only the s2 edge has
    // both endpoints in the returned set - no dangling references for D3.
    expect(body.nodes.map((n: { id: string }) => n.id)).toEqual(['h-main', 'h-sub1']);
    expect(body.edges.map((e: { source: string }) => e.source)).toEqual(['queue_operation']);
    expect(body.counts).toEqual({
      totalSessions: 2,
      totalAgents: 4,
      totalEdges: 2,
      returnedAgents: 2,
      returnedEdges: 1,
      truncated: true,
    });
  });

  it('rejects a limit above the cap (400)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dag/global?limit=9999',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('limit');
  });

  it('returns the honest empty shape on a virgin database', async () => {
    const empty = createMigratedTempDb();
    const emptyApp = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: empty.db });
    try {
      const response = await emptyApp.inject({
        method: 'GET',
        url: '/api/dag/global',
        headers: AUTH,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        nodes: [],
        edges: [],
        counts: {
          totalSessions: 0,
          totalAgents: 0,
          totalEdges: 0,
          returnedAgents: 0,
          returnedEdges: 0,
          truncated: false,
        },
      });
    } finally {
      await emptyApp.close();
      empty.cleanup();
    }
  });
});
