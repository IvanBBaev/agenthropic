/**
 * Row-1 performance - the incremental per-session cache behind
 * `getAggregateDelegationSavings`, tested directly on a real migrated
 * temp-file database. The never-stale contract: a session's cached outcome is
 * served ONLY while its `ingest_seq` stamp and the global key (pricing,
 * routing override, ledger epoch, `data_version`) prove nothing it depends on
 * can have changed. Work is proven by COUNTING per-session rebuilds through
 * the probe seam, never by timing.
 *
 * Seeded output rates (WP-C1, migrations 7 and 20): claude-fable-5 $50,
 * claude-sonnet-5 $10, claude-opus-4-8 $25 per Mtok.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAggregateDelegationSavings, type DelegationSavingsProbe } from '../src/api/queries';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { loadPricing } from '../src/db/pricing';
import { deleteExpiredWindow } from '../src/db/retention-queries';
import { createMigratedTempDb, type TempDb } from './helpers';

const AT = '2026-07-10T01:00:00.000Z';

/**
 * One delegating session: main on fable (1 Mtok output) and one subagent on
 * sonnet (1 Mtok output) - $10 actual, $50 hypothetical, $40 savings.
 */
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

function makeProbe(): { probe: DelegationSavingsProbe; priced: string[] } {
  const priced: string[] = [];
  return {
    probe: {
      onSessionPriced(sessionId) {
        priced.push(sessionId);
      },
    },
    priced,
  };
}

describe('aggregate delegation savings - incremental per-session cache', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    seedSession(temp.db, 's-a');
    seedSession(temp.db, 's-b');
  });

  afterEach(() => {
    temp.cleanup();
  });

  const read = (probe?: DelegationSavingsProbe, topTierModel?: string) =>
    getAggregateDelegationSavings(
      temp.db,
      loadPricing(temp.db),
      topTierModel === undefined ? {} : { topTierModel },
      probe,
    );

  it('prices every session on the first read and none on an unchanged second read', () => {
    const { probe, priced } = makeProbe();
    const first = read(probe);
    expect(priced).toEqual(['s-a', 's-b']);
    expect(first.savingsUsd).toBeCloseTo(80, 9);
    const second = read(probe);
    expect(priced).toEqual(['s-a', 's-b']);
    expect(second).toEqual(first);
  });

  it('reprices ONLY the session whose rows changed', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    temp.db.prepare(`UPDATE token_usage SET tokens = 2000000 WHERE message_id = 's-b-s'`).run();
    const after = read(probe);
    expect(priced).toEqual(['s-a', 's-b', 's-b']);
    // s-b's subagent doubled: $20 actual, $100 hypothetical, $80 savings.
    expect(after.actualUsd).toBeCloseTo(30, 9);
    expect(after.savingsUsd).toBeCloseTo(120, 9);
  });

  it('does not reprice on an idempotent rewrite (no stamp moves)', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    temp.db.prepare(`UPDATE token_usage SET tokens = tokens WHERE session_id = 's-a'`).run();
    read(probe);
    expect(priced).toEqual(['s-a', 's-b']);
  });

  it('prices a newly delegating session and drops one that stopped delegating', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    seedSession(temp.db, 's-c');
    temp.db.prepare(`UPDATE agents SET type = 'main' WHERE id = 's-a-sub'`).run();
    const after = read(probe);
    expect(priced).toEqual(['s-a', 's-b', 's-c']);
    expect(after.sessionsWithSubagents).toBe(2);
    expect(after.sessionsPriced).toBe(2);
    expect(after.savingsUsd).toBeCloseTo(80, 9);
  });

  it('flushes everything when a retention DELETE moves the ledger epoch', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    // s-b's rows are dated a year earlier, so a cutoff between the two dates
    // expires only them. A DELETE stamps nothing; the epoch is the signal.
    temp.db
      .prepare(`UPDATE token_usage SET occurred_at = ? WHERE session_id = 's-b'`)
      .run('2025-07-10T01:00:00.000Z');
    read(probe);
    priced.length = 0;
    const maxId = (temp.db.prepare('SELECT MAX(id) AS m FROM token_usage').get() as { m: number })
      .m;
    expect(deleteExpiredWindow(temp.db, 'token_usage', '2026-01-01T00:00:00.000Z', maxId)).toBe(2);
    const after = read(probe);
    expect(priced).toEqual(['s-a', 's-b']);
    // s-b keeps its subagent but has no usage left: it prices to $0.
    expect(after.savingsUsd).toBeCloseTo(40, 9);
    expect(after.sessionsPriced).toBe(2);
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
    expect(priced).toEqual(['s-a', 's-b', 's-a', 's-b']);
    expect(after.savingsUsd).toBeCloseTo(40, 9);
  });

  it('flushes everything when the routing override or the pricing changes', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    const opus = read(probe, 'claude-opus-4-8');
    expect(priced).toHaveLength(4);
    // 1 Mtok sonnet ($10) against opus ($25) per session: $15 savings each.
    expect(opus.savingsUsd).toBeCloseTo(30, 9);
    getAggregateDelegationSavings(
      temp.db,
      loadPricing(temp.db).map((entry) => ({ ...entry, usdPerMtok: entry.usdPerMtok * 2 })),
      {},
      probe,
    );
    expect(priced).toHaveLength(6);
  });

  it('caches a skipped session as a skip and serves it again unchanged', () => {
    const { probe, priced } = makeProbe();
    temp.db
      .prepare(`UPDATE token_usage SET model = 'no-such-model' WHERE message_id = 's-b-s'`)
      .run();
    const first = read(probe);
    const second = read(probe);
    expect(priced).toEqual(['s-a', 's-b']);
    expect(second.skippedSessions).toEqual(first.skippedSessions);
    expect(second.skippedSessions[0]?.reason).toBe('unpriceable');
  });

  it('never trusts a session whose sessions row is missing (no stamp)', () => {
    const { probe, priced } = makeProbe();
    // Only reachable through a writer that does not enforce the foreign key,
    // which this connection always does - so switch it off for the seed.
    temp.db.pragma('foreign_keys = OFF');
    temp.db.prepare(`DELETE FROM sessions WHERE id = 's-b'`).run();
    temp.db.pragma('foreign_keys = ON');
    read(probe);
    read(probe);
    expect(priced).toEqual(['s-a', 's-b', 's-b']);
  });

  it('keeps the previous entry when a non-pricing failure aborts a read', () => {
    const { probe, priced } = makeProbe();
    read(probe);
    expect(() =>
      getAggregateDelegationSavings(
        temp.db,
        [{ model: 'claude-sonnet-5', bucket: 'output', usdPerMtok: 1, effectiveFrom: 'bad' }],
        {},
        probe,
      ),
    ).toThrow(RangeError);
    priced.length = 0;
    read(probe);
    expect(priced).toEqual([]);
  });
});
