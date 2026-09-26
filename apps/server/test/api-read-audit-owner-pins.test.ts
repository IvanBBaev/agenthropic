/**
 * Lane Z read-API audit - CURRENT-BEHAVIOUR PINS for findings that need an
 * owner decision (an API contract change), NOT fixes. Each test asserts what
 * the server does today so the day the decision lands, the test that must
 * change is obvious.
 *
 * SA-Z3: an unknown query parameter is silently dropped (Fastify's default
 * ajv `removeAdditional` runs against the `additionalProperties: false`
 * querystring schemas) and the request answers 200 as if it were never sent.
 * A client that believes `/api/cost/summary?from=...` filters gets all-time
 * figures with nothing in the response to say the filter was ignored.
 *
 * SA-Z4: the global DAG's `counts.totalEdges` counts every stored edge, while
 * `edges` keeps only those whose BOTH endpoints are returned agents. An edge
 * naming an agent id with no `agents` row (orchestration_edges has no FK to
 * agents) is therefore never returnable, yet `truncated` stays false because
 * no node was cut - so `returnedEdges < totalEdges` with `truncated: false`.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '../src/db/connection';
import { buildServer } from '../src/server';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

let temp: TempDb | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  temp?.cleanup();
  app = undefined;
  temp = undefined;
});

async function serve(seed: (db: SqliteDatabase) => void): Promise<FastifyInstance> {
  temp = createMigratedTempDb();
  seed(temp.db);
  app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
  await app.ready();
  return app;
}

async function get(
  server: FastifyInstance,
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await server.inject({ method: 'GET', url, headers: AUTH });
  return { status: res.statusCode, body: res.body };
}

function seedTwoDays(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
      ('s1', 'p', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active'),
      ('s2', 'p', '2026-07-11T00:00:00Z', '2026-07-11T02:00:00Z', 'active');
    INSERT INTO agents (id, session_id, type, status) VALUES
      ('s1', 's1', 'main', 'working'), ('s2', 's2', 'main', 'working');
    INSERT INTO token_usage
      (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
      VALUES
      ('s1', 's1', 'm1', 'm-x', 'input', 100, 0, '2026-07-10T01:00:00Z'),
      ('s2', 's2', 'm2', 'm-x', 'input', 900, 0, '2026-07-11T01:00:00Z');
  `);
}

describe('SA-Z3 (pins current behaviour, owner decision): unknown query params are ignored', () => {
  it('a filter-looking param on the cost summary is dropped and all-time figures are served', async () => {
    const server = await serve(seedTwoDays);
    const plain = await get(server, '/api/cost/summary');
    const filtered = await get(server, '/api/cost/summary?from=2026-07-11');
    expect(filtered.status).toBe(200);
    expect(filtered.body).toBe(plain.body);
  });

  it('a misspelt paging param answers 200 with the default page', async () => {
    const server = await serve(seedTwoDays);
    const res = await get(server, '/api/sessions?limt=1');
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { sessions: unknown[]; limit: number }).sessions).toHaveLength(
      2,
    );
  });
});

describe('SA-Z4 (pins current behaviour, owner decision): dangling edges vs truncated', () => {
  it('an edge to an agent with no row is counted but never returned, and truncated stays false', async () => {
    const server = await serve((db) =>
      db.exec(`
        INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
          VALUES ('s1', 'p', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active');
        INSERT INTO agents (id, session_id, type, status) VALUES ('s1', 's1', 'main', 'working');
        INSERT INTO orchestration_edges
          (session_id, parent_agent_id, child_agent_id, source, instance, host_id)
          VALUES ('s1', 's1', 'ghost', 'tool_use', 'i1', 'h1');
      `),
    );
    const res = await get(server, '/api/dag/global');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { edges: unknown[]; counts: Record<string, unknown> };
    expect(body.edges).toEqual([]);
    expect(body.counts).toMatchObject({
      totalAgents: 1,
      returnedAgents: 1,
      totalEdges: 1,
      returnedEdges: 0,
      truncated: false,
    });
  });
});
