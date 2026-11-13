/**
 * Row-1 performance - the per-session agent-usage cache behind
 * `getGlobalDag`, tested on a real migrated temp-file database. A session's
 * cached rollup is served only while its `ingest_seq` stamp and the global key
 * (pricing, ledger epoch, `data_version`) prove it cannot have moved. Work is
 * proven by COUNTING re-priced sessions through the probe seam, never by timing.
 *
 * Seeded output rates (WP-C1): claude-fable-5 $50, claude-sonnet-5 $10 per Mtok.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDag, type GlobalDagProbe } from '../src/api/queries';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { deleteExpiredWindow } from '../src/db/retention-queries';
import { createMigratedTempDb, type TempDb } from './helpers';

const AT = '2026-07-10T01:00:00.000Z';

/** Main on fable (1 Mtok, $50) and one subagent on sonnet (1 Mtok, $10). */
function seedSession(db: SqliteDatabase, sessionId: string, at: string = AT): void {
  db.prepare(
    `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
     VALUES (?, 'proj', ?, ?, 'active')`,
  ).run(sessionId, at, at);
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, NULL, 'completed', ?, ?, ?)`,
  );
  insertAgent.run(`${sessionId}-main`, sessionId, 'main', null, at, at);
  insertAgent.run(`${sessionId}-sub`, sessionId, 'subagent', `${sessionId}-main`, at, at);
  const insertUsage = db.prepare(
    `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
     VALUES (?, ?, ?, ?, 'output', 1000000, 0, ?)`,
  );
  insertUsage.run(sessionId, `${sessionId}-main`, `${sessionId}-m`, 'claude-fable-5', at);
  insertUsage.run(sessionId, `${sessionId}-sub`, `${sessionId}-s`, 'claude-sonnet-5', at);
}

function makeProbe(): { probe: GlobalDagProbe; priced: string[] } {
  const priced: string[] = [];
  return { probe: { onSessionPriced: (id) => priced.push(id) }, priced };
}

describe('global DAG - per-session agent usage cache', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    seedSession(temp.db, 's-a');
    seedSession(temp.db, 's-b');
  });

  afterEach(() => {
    temp.cleanup();
  });

  const read = (probe?: GlobalDagProbe, limit = 100) => getGlobalDag(temp.db, limit, probe);
  const cost = (dag: ReturnType<typeof read>, id: string) =>
    dag.nodes.find((node) => node.id === id)?.costUsd;
  const sortedPriced = (priced: string[]) => [...priced].sort();

  it('prices each selected session once, then serves an unchanged read from cache', () => {
    const { probe, priced } = makeProbe();
    const first = read(probe);
    expect(sortedPriced(priced)).toEqual(['s-a', 's-b']);
    expect(cost(first, 's-a-main')).toBeCloseTo(50, 9);
    expect(cost(first, 's-a-sub')).toBeCloseTo(10, 9);
    const second = read(probe);
    expect(priced).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('reprices ONLY the session whose rows changed', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    temp.db.prepare(`UPDATE token_usage SET tokens = 2000000 WHERE message_id = 's-b-s'`).run();
    const after = read(probe);
    expect(priced.slice(2)).toEqual(['s-b']);
    expect(cost(after, 's-b-sub')).toBeCloseTo(20, 9);
    expect(cost(after, 's-a-sub')).toBeCloseTo(10, 9);
  });

  it('does not reprice on an idempotent rewrite', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    temp.db.prepare(`UPDATE token_usage SET tokens = tokens WHERE session_id = 's-a'`).run();
    read(probe);
    expect(priced).toHaveLength(2);
  });

  it('prices a new session and reports zero for an agent with no usage', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    seedSession(temp.db, 's-c');
    temp.db
      .prepare(
        `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
         VALUES ('s-a-idle', 's-a', 'subagent', NULL, 'completed', 's-a-main', ?, ?)`,
      )
      .run(AT, AT);
    const after = read(probe);
    expect(sortedPriced(priced.slice(2))).toEqual(['s-a', 's-c']);
    const idle = after.nodes.find((node) => node.id === 's-a-idle');
    expect(idle?.totalTokens).toBe(0);
    expect(idle?.costUsd).toBe(0);
  });

  it('flushes everything when a retention DELETE moves the ledger epoch', () => {
    const { probe, priced } = makeProbe();
    temp.db
      .prepare(`UPDATE token_usage SET occurred_at = ? WHERE session_id = 's-b'`)
      .run('2025-07-10T01:00:00.000Z');
    read(probe);
    priced.length = 0;
    const maxId = (temp.db.prepare('SELECT MAX(id) AS m FROM token_usage').get() as { m: number })
      .m;
    expect(deleteExpiredWindow(temp.db, 'token_usage', '2026-01-01T00:00:00.000Z', maxId)).toBe(2);
    const after = read(probe);
    expect(sortedPriced(priced)).toEqual(['s-a', 's-b']);
    expect(cost(after, 's-b-sub')).toBe(0);
  });

  it('flushes everything on a FOREIGN connection commit (data_version)', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    const other = openDatabase(temp.path);
    try {
      other.prepare(`DELETE FROM token_usage WHERE message_id = 's-a-s'`).run();
    } finally {
      other.close();
    }
    const after = read(probe);
    expect(priced).toHaveLength(4);
    expect(cost(after, 's-a-sub')).toBe(0);
  });

  it('flushes everything when the pricing table changes', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    temp.db
      .prepare(
        `UPDATE model_pricing SET usd_per_mtok = usd_per_mtok * 2 WHERE model = 'claude-sonnet-5'`,
      )
      .run();
    const after = read(probe);
    expect(priced).toHaveLength(4);
    expect(cost(after, 's-a-sub')).toBeCloseTo(20, 9);
  });

  it('never trusts a session whose sessions row is missing (no stamp)', () => {
    const { probe, priced } = makeProbe();
    temp.db.pragma('foreign_keys = OFF');
    temp.db.prepare(`DELETE FROM sessions WHERE id = 's-b'`).run();
    temp.db.pragma('foreign_keys = ON');
    read(probe);
    read(probe);
    expect(sortedPriced(priced)).toEqual(['s-a', 's-b', 's-b']);
  });

  it('keeps only the current selection in the cache', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    // A one-node cap selects one session; the other falls out of the cache and
    // is priced again when a wider read selects it.
    read(probe, 1);
    priced.length = 0;
    read(probe);
    expect(priced).toHaveLength(1);
  });
});
