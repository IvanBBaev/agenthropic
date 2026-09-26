/**
 * Served-honesty regressions: a response must not claim more than was
 * computed. Three shapes are pinned here:
 *
 * - a `model_pricing` rate that is not a finite, non-negative number must
 *   surface its tokens as UNPRICED on every route (never a negative dollar
 *   figure, a null money field, a text-coerced price or a 500), and every
 *   route must agree;
 * - a `since` whose canonical instant falls outside years 0000-9999 is a 400,
 *   not a window that sorts inside out as text;
 * - the global DAG attributes usage to an agent only within the agent's own
 *   session, exactly as the session tree does.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '../src/db/connection';
import { normalizeSinceInstant } from '../src/api/queries';
import { buildServer } from '../src/server';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const MTOK = 1_000_000;

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

interface Node {
  readonly id: string;
  readonly totalTokens: number;
  readonly costUsd: number | null;
  readonly unpricedTokens: number;
}
interface Money {
  readonly costUsd: number | null;
  readonly unpricedTokens: number;
}
interface Body {
  readonly sessions: { totalCostUsd: number | null; unpricedTokens: number }[];
  readonly totalCostUsd: number | null;
  readonly unpricedTokens: number;
  readonly agents: Node[];
  readonly nodes: Node[];
  readonly unattributed: Money & { totalTokens: number };
  readonly totals: Money & { costAddedUsd: number | null; unpricedTokensAdded: number };
}

async function getJson(
  server: FastifyInstance,
  url: string,
): Promise<{ status: number; body: Body }> {
  const res = await server.inject({ method: 'GET', url, headers: AUTH });
  return { status: res.statusCode, body: res.json<Body>() };
}

/** One session, one agent, 1M input tokens of a synthetic model. */
function seedUsage(db: SqliteDatabase, pricingSql: string): void {
  db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
      VALUES ('s1', 'p', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active');
    INSERT INTO agents (id, session_id, type, status) VALUES ('s1', 's1', 'main', 'working');
    INSERT INTO token_usage
      (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
      VALUES ('s1', 's1', 'm1', 'm-x', 'input', ${MTOK}, 0, '2026-07-10T01:00:00Z');
    ${pricingSql}
  `);
}

interface Served {
  readonly costUsd: number | null | undefined;
  readonly unpricedTokens: number | undefined;
}

/** The (cost, unpriced) pair each money-serving route reports for the corpus. */
async function servedEverywhere(server: FastifyInstance): Promise<Record<string, Served>> {
  const list = await getJson(server, '/api/sessions');
  const detail = await getJson(server, '/api/sessions/s1');
  const tree = await getJson(server, '/api/sessions/s1/tree');
  const dag = await getJson(server, '/api/dag/global');
  const summary = await getJson(server, '/api/cost/summary');
  const changes = await getJson(server, '/api/changes?since=2026-07-01T00:00:00Z');
  for (const r of [list, detail, tree, dag, summary, changes]) {
    expect(r.status).toBe(200);
  }
  return {
    list: {
      costUsd: list.body.sessions[0]?.totalCostUsd,
      unpricedTokens: list.body.sessions[0]?.unpricedTokens,
    },
    detail: { costUsd: detail.body.totalCostUsd, unpricedTokens: detail.body.unpricedTokens },
    tree: {
      costUsd: tree.body.agents[0]?.costUsd,
      unpricedTokens: tree.body.agents[0]?.unpricedTokens,
    },
    dag: { costUsd: dag.body.nodes[0]?.costUsd, unpricedTokens: dag.body.nodes[0]?.unpricedTokens },
    summary: {
      costUsd: summary.body.totals.costUsd,
      unpricedTokens: summary.body.totals.unpricedTokens,
    },
    changes: {
      costUsd: changes.body.totals.costAddedUsd,
      unpricedTokens: changes.body.totals.unpricedTokensAdded,
    },
  };
}

function everyRoute(expected: Served): Record<string, Served> {
  return Object.fromEntries(
    ['list', 'detail', 'tree', 'dag', 'summary', 'changes'].map((k) => [k, expected]),
  );
}

describe('an invalid model_pricing rate is unpriced on every route', () => {
  it('control: a valid rate prices the tokens identically everywhere', async () => {
    const server = await serve((db) =>
      seedUsage(
        db,
        `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
           VALUES ('m-x', 'input', 3, '2026-01-01');`,
      ),
    );
    expect(await servedEverywhere(server)).toEqual(everyRoute({ costUsd: 3, unpricedTokens: 0 }));
  });

  it.each([
    ['a negative rate', '-3'],
    ['an infinite rate', '9e999'],
    ['a non-numeric text rate', `'abc'`],
    ['a numeric-prefixed text rate', `'3.00$'`],
  ])('%s', async (_label, literal) => {
    const server = await serve((db) =>
      seedUsage(
        db,
        `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
           VALUES ('m-x', 'input', ${literal}, '2026-01-01');`,
      ),
    );
    expect(await servedEverywhere(server)).toEqual(
      everyRoute({ costUsd: 0, unpricedTokens: MTOK }),
    );
  });

  it('an invalid LATEST rate does not fall back to an older valid one', async () => {
    const server = await serve((db) =>
      seedUsage(
        db,
        `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES
           ('m-x', 'input', 3, '2026-01-01'),
           ('m-x', 'input', -1, '2026-06-01');`,
      ),
    );
    expect(await servedEverywhere(server)).toEqual(
      everyRoute({ costUsd: 0, unpricedTokens: MTOK }),
    );
  });
});

describe('a since outside the 4-digit-year range is refused', () => {
  it.each(['9999-12-31T23:00:00-05:00', '0000-01-01T00:30:00+01:00'])(
    '%s is a 400, not an inside-out window',
    async (since) => {
      expect(normalizeSinceInstant(since)).toBeNull();
      const server = await serve((db) => seedUsage(db, ''));
      const res = await server.inject({
        method: 'GET',
        url: `/api/changes?since=${encodeURIComponent(since)}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(400);
    },
  );

  it('the last representable instant is still accepted', () => {
    expect(normalizeSinceInstant('9999-12-31T23:59:59Z')).toBe('9999-12-31T23:59:59.000Z');
  });
});

describe('global DAG usage is scoped to the agent own session', () => {
  it('usage in another session naming the same agent id is not double-counted', async () => {
    const server = await serve((db) =>
      db.exec(`
        INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
          ('s1', 'p', '2026-07-10T00:00:00Z', '2026-07-11T02:00:00Z', 'active'),
          ('s2', 'p', '2026-07-10T00:00:00Z', '2026-07-11T02:00:00Z', 'active');
        INSERT INTO agents (id, session_id, type, status) VALUES
          ('s1', 's1', 'main', 'working'), ('a1', 's1', 'subagent', 'working'),
          ('s2', 's2', 'main', 'working');
        INSERT INTO token_usage
          (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
          VALUES
          ('s1', 'a1', 'c1', 'claude-fable-5', 'input', 100, 0, '2026-07-10T01:00:00Z'),
          ('s2', 'a1', 'c2', 'claude-fable-5', 'input', 900, 0, '2026-07-10T01:00:00Z');
      `),
    );
    const dag = await getJson(server, '/api/dag/global');
    const t1 = await getJson(server, '/api/sessions/s1/tree');
    const t2 = await getJson(server, '/api/sessions/s2/tree');
    const dagA1 = dag.body.nodes.find((n) => n.id === 'a1');
    const treeA1 = t1.body.agents.find((n) => n.id === 'a1');
    expect(dagA1?.totalTokens).toBe(100);
    expect(dagA1?.totalTokens).toBe(treeA1?.totalTokens);
    expect(t2.body.unattributed.totalTokens).toBe(900);
    const dagSum = dag.body.nodes.reduce((acc, n) => acc + n.totalTokens, 0);
    const treeSum = [...t1.body.agents, ...t2.body.agents].reduce(
      (acc, n) => acc + n.totalTokens,
      0,
    );
    expect(dagSum).toBe(treeSum);
  });
});
