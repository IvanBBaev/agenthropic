/**
 * Lane Z read-API audit (SA-Z1): every "recent-first" / "earliest-first"
 * ordering over a NON-canonical timestamp column must order by the instant,
 * not by the stored text.
 *
 * `sessions.started_at`, `sessions.last_activity_at`, `agents.first_seen_at`
 * and `agents.last_seen_at` are not canonicalized by a trigger, so one DB can
 * hold '...T00:00:00Z', '...T00:00:00.500Z' and '...T02:00:00+02:00' side by
 * side. As text, 'Z' sorts above '.', and an offset spelling sorts by its
 * local wall clock - so a raw-text ORDER BY serves a list whose head is NOT
 * the most recent item, and a capped DAG whose cap keeps an older agent and
 * drops a newer one while `truncated` reports the cap as honest.
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

async function ids(server: FastifyInstance, url: string, key: string): Promise<string[]> {
  const res = await server.inject({ method: 'GET', url, headers: AUTH });
  expect(res.statusCode).toBe(200);
  const body = res.json<Record<string, Array<{ id: string }>>>();
  return (body[key] ?? []).map((row) => row.id);
}

/**
 * Three sessions whose true chronological order (latest first) is
 * s-late, s-mid, s-early - but whose raw TEXT order is the reverse:
 *   s-early '2026-07-10T00:00:00Z'       (instant 00:00:00.000)
 *   s-mid   '2026-07-10T00:00:00.500Z'   (instant 00:00:00.500) - sorts BELOW 'Z'
 *   s-late  '2026-07-09T23:00:01-01:00'  (instant 2026-07-10T00:00:01Z) - a 07-09 text
 */
function seedSessions(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
      ('s-early', 'p', '2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z', 'active'),
      ('s-mid',   'p', '2026-07-01T00:00:00Z', '2026-07-10T00:00:00.500Z', 'active'),
      ('s-late',  'p', '2026-07-01T00:00:00Z', '2026-07-09T23:00:01-01:00', 'active'),
      ('s-none',  'p', NULL, NULL, 'active');
  `);
}

describe('SA-Z1: session list is recent-first by instant', () => {
  it('orders mixed spellings chronologically, undated last', async () => {
    const server = await serve(seedSessions);
    expect(await ids(server, '/api/sessions', 'sessions')).toEqual([
      's-late',
      's-mid',
      's-early',
      's-none',
    ]);
  });

  it('the page boundary follows the same instant order', async () => {
    const server = await serve(seedSessions);
    expect(await ids(server, '/api/sessions?limit=1', 'sessions')).toEqual(['s-late']);
    expect(await ids(server, '/api/sessions?limit=1&offset=1', 'sessions')).toEqual(['s-mid']);
  });
});

/** Agents in one session with the same text-vs-instant inversion. */
function seedAgents(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
      VALUES ('s1', 'p', '2026-07-10T00:00:00Z', '2026-07-10T03:00:00Z', 'active');
    INSERT INTO agents (id, session_id, type, status, first_seen_at, last_seen_at) VALUES
      ('a-early', 's1', 'subagent', 'working', '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z'),
      ('a-mid',   's1', 'subagent', 'working', '2026-07-10T00:00:00.500Z', '2026-07-10T00:00:00.500Z'),
      ('a-late',  's1', 'subagent', 'working', '2026-07-09T23:00:01-01:00', '2026-07-09T23:00:01-01:00'),
      ('a-none',  's1', 'subagent', 'working', NULL, NULL);
  `);
}

describe('SA-Z1: session tree is earliest-first by instant', () => {
  it('orders mixed spellings chronologically, undated first', async () => {
    const server = await serve(seedAgents);
    expect(await ids(server, '/api/sessions/s1/tree', 'agents')).toEqual([
      'a-none',
      'a-early',
      'a-mid',
      'a-late',
    ]);
  });
});

describe('SA-Z1: global DAG cap keeps the most recent agents by instant', () => {
  it('orders nodes recent-first by instant', async () => {
    const server = await serve(seedAgents);
    expect(await ids(server, '/api/dag/global', 'nodes')).toEqual([
      'a-late',
      'a-mid',
      'a-early',
      'a-none',
    ]);
  });

  it('a cap of 1 keeps the latest agent, not the text-greatest one', async () => {
    const server = await serve(seedAgents);
    expect(await ids(server, '/api/dag/global?limit=1', 'nodes')).toEqual(['a-late']);
  });

  it('falls back to first_seen_at when last_seen_at is absent', async () => {
    const server = await serve((db) =>
      db.exec(`
        INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
          VALUES ('s1', 'p', '2026-07-10T00:00:00Z', '2026-07-10T03:00:00Z', 'active');
        INSERT INTO agents (id, session_id, type, status, first_seen_at, last_seen_at) VALUES
          ('a-z', 's1', 'subagent', 'working', '2026-07-10T00:00:00Z', NULL),
          ('a-dot', 's1', 'subagent', 'working', '2026-07-10T00:00:00.001Z', NULL);
      `),
    );
    expect(await ids(server, '/api/dag/global?limit=1', 'nodes')).toEqual(['a-dot']);
  });
});
