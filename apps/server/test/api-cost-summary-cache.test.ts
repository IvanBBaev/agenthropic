/**
 * M-19 - the one-entry cost-summary cache, tested directly against
 * `getCostSummary` on a real migrated temp-file database. The never-stale
 * contract: cached dollars are served ONLY while the self-validating state
 * key proves nothing they depend on can have changed. Hits are proven by
 * COUNTING rollup executions through the probe seam, never by timing.
 *
 * Seeded rates (WP-C1 migration): claude-fable-5 input $10 / output $50,
 * claude-sonnet-5 input $3 / output $15 per Mtok.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCostSummary, getSessionProjectSlug, type CostSummaryProbe } from '../src/api/queries';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

// Same seed as api-cost.test.ts: c1 $10 + c2 $15 + c3 $10 = $35 priced;
// c4 (unknown model) + c5 (no timestamp) = 700 unpriced tokens.
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

function makeProbe(): { probe: CostSummaryProbe; scans: () => number } {
  let count = 0;
  return {
    probe: {
      onScan() {
        count += 1;
      },
    },
    scans: () => count,
  };
}

describe('getCostSummary cache (M-19)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    seed(temp.db);
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('serves a repeat read from cache: the rollup scan runs once', () => {
    const { probe, scans } = makeProbe();
    const first = getCostSummary(temp.db, 10, probe);
    expect(scans()).toBe(1);
    expect(first.totals.costUsd).toBeCloseTo(35, 9);

    const second = getCostSummary(temp.db, 10, probe);
    expect(scans()).toBe(1);
    // The hit returns the same DTO object by reference - consumers serialize
    // it, never mutate it.
    expect(second).toBe(first);
  });

  it('invalidates on fresh ingest rows (token_usage INSERT)', () => {
    const { probe, scans } = makeProbe();
    expect(getCostSummary(temp.db, 10, probe).totals.costUsd).toBeCloseTo(35, 9);
    temp.db
      .prepare(
        `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
         VALUES ('s1', NULL, 'c6', 'claude-fable-5', 'input', 1000000, 0, '2026-07-11T04:00:00Z')`,
      )
      .run();
    const after = getCostSummary(temp.db, 10, probe);
    expect(scans()).toBe(2);
    expect(after.totals.costUsd).toBeCloseTo(45, 9);
  });

  it('invalidates on retention-style DELETEs', () => {
    const { probe, scans } = makeProbe();
    expect(getCostSummary(temp.db, 10, probe).totals.costUsd).toBeCloseTo(35, 9);
    temp.db.prepare(`DELETE FROM token_usage WHERE message_id = 'c2'`).run();
    const after = getCostSummary(temp.db, 10, probe);
    expect(scans()).toBe(2);
    expect(after.totals.costUsd).toBeCloseTo(20, 9);
  });

  it('invalidates on an in-place rewrite that changes no row count (the upsert DO UPDATE arm)', () => {
    const { probe, scans } = makeProbe();
    expect(getCostSummary(temp.db, 10, probe).totals.costUsd).toBeCloseTo(35, 9);
    temp.db.prepare(`UPDATE token_usage SET tokens = 2000000 WHERE message_id = 'c1'`).run();
    const after = getCostSummary(temp.db, 10, probe);
    expect(scans()).toBe(2);
    expect(after.totals.costUsd).toBeCloseTo(45, 9);
  });

  it('invalidates on a model_pricing edit made by ANOTHER connection (sqlite3 CLI seeding)', () => {
    // total_changes() is blind to other connections, so this test proves the
    // pricing fingerprint carries the invalidation alone: the server
    // connection's own change counter must NOT move.
    const { probe, scans } = makeProbe();
    expect(getCostSummary(temp.db, 10, probe).totals.costUsd).toBeCloseTo(35, 9);
    const changesBefore = (temp.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

    const operator = openDatabase(temp.path);
    operator
      .prepare(
        `UPDATE model_pricing SET usd_per_mtok = 20 WHERE model = 'claude-fable-5' AND bucket = 'input'`,
      )
      .run();
    operator.close();

    const changesAfter = (temp.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    expect(changesAfter).toBe(changesBefore);

    // c1 reprices 1M input fable at $20 -> totals $45; served fresh, never stale.
    const after = getCostSummary(temp.db, 10, probe);
    expect(scans()).toBe(2);
    expect(after.totals.costUsd).toBeCloseTo(45, 9);
  });

  it('recomputes when topN differs, then caches the new shape', () => {
    const { probe, scans } = makeProbe();
    expect(getCostSummary(temp.db, 10, probe).topSessions).toHaveLength(2);
    expect(scans()).toBe(1);

    const narrowed = getCostSummary(temp.db, 1, probe);
    expect(scans()).toBe(2);
    expect(narrowed.topSessions).toHaveLength(1);

    getCostSummary(temp.db, 1, probe);
    expect(scans()).toBe(2);
  });
});

describe('getSessionProjectSlug (M-18 hint helper)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('returns the persisted slug for a known session', () => {
    insertSession(temp.db, 'known-session');
    expect(getSessionProjectSlug(temp.db, 'known-session')).toBe('test-slug');
  });

  it('returns null for an unknown session', () => {
    expect(getSessionProjectSlug(temp.db, 'never-ingested')).toBeNull();
  });

  it('returns null for a session ingested without a slug', () => {
    temp.db
      .prepare(
        `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
         VALUES ('slugless', NULL, '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z', 'active')`,
      )
      .run();
    expect(getSessionProjectSlug(temp.db, 'slugless')).toBeNull();
  });
});
