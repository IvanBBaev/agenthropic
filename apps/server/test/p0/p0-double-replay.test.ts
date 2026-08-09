/**
 * P0 proof 2 (WP-X3 + WP-IN13): double replay => byte-identical database.
 *
 * Replaying the same corpus twice must yield ZERO new rows AND a
 * byte-identical database. Pass 1 and pass 2 are the replay-on-startup ticks
 * of two SEPARATE watcher instances over the SAME database — a fresh watcher
 * starts with an empty fingerprint map, so its first tick re-admits every
 * session exactly like a process restart does (WP-IN10). All non-deterministic
 * inputs are pinned: a fixed `now()` (edge created_at stamps), a fixed
 * `nowMs()` and a huge watchdog threshold (no status transitions), and
 * migrations + pricing seeds run ONCE before pass 1.
 *
 * Equality is asserted twice, independently:
 *  1. byte-for-byte — `VACUUM INTO` snapshots after each pass compared as raw
 *     buffers (VACUUM INTO writes a canonical, freshly-packed image of the
 *     committed state, so surviving page-layout noise would still be a diff);
 *  2. logically — a full ordered dump of every user table, deep-equal.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCorpusWatcher,
  loadPricing,
  tickSummary,
  type CorpusIngestSummary,
  type SqliteDatabase,
} from '../../src/index';
import {
  FIXED_NOW,
  FIXED_NOW_MS,
  HUGE_WATCHDOG_MS,
  allFixtures,
  corpusEnv,
  dumpAllTables,
  makeTempDir,
  materializeCorpus,
  openSeededDb,
} from './harness';

describe('P0 proof 2 - double replay yields zero new rows and a byte-identical database', () => {
  const dirs: string[] = [];
  let db: SqliteDatabase;
  let snapshotPass1: string;
  let snapshotPass2: string;
  let summaryPass1: CorpusIngestSummary | null;
  let summaryPass2: CorpusIngestSummary | null;
  let dumpPass1: Record<string, unknown[]>;
  let dumpPass2: Record<string, unknown[]>;

  beforeAll(() => {
    const dir = makeTempDir('agenthropic-p0-replay-');
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    materializeCorpus(corpusRoot, allFixtures());

    // Migrations + pricing seed run ONCE, before pass 1 — from here on the
    // database may change only through the two replay passes under test.
    db = openSeededDb(join(dir, 'agent.db'));
    const watcherDeps = {
      db,
      pricing: loadPricing(db),
      env: corpusEnv(corpusRoot, 'p0-proof-2'),
      intervalMs: 600_000, // ticks are driven manually; the poll loop never starts
      watchdogThresholdMs: HUGE_WATCHDOG_MS,
      now: (): string => FIXED_NOW,
      nowMs: (): number => FIXED_NOW_MS,
    };

    // Pass 1: a fresh watcher's first tick IS the WP-IN10 replay.
    const watcherPass1 = createCorpusWatcher(watcherDeps);
    summaryPass1 = tickSummary(watcherPass1.tick());
    watcherPass1.stop();
    snapshotPass1 = join(dir, 'snapshot-pass1.db');
    db.prepare('VACUUM INTO ?').run(snapshotPass1);
    dumpPass1 = dumpAllTables(db);

    // Pass 2: a NEW watcher over the SAME database — its fingerprint map is
    // empty again, exactly the simulated-restart replay the proof demands.
    const watcherPass2 = createCorpusWatcher(watcherDeps);
    summaryPass2 = tickSummary(watcherPass2.tick());
    watcherPass2.stop();
    snapshotPass2 = join(dir, 'snapshot-pass2.db');
    db.prepare('VACUUM INTO ?').run(snapshotPass2);
    dumpPass2 = dumpAllTables(db);
  });

  afterAll(() => {
    db.close();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P0: pass 1 really ingested the whole corpus (proof precondition)', () => {
    expect(summaryPass1).not.toBeNull();
    expect(summaryPass1?.sessionsOk).toBe(allFixtures().length);
    expect(summaryPass1?.sessionsFailed).toBe(0);
    expect(summaryPass1?.agentsUpserted).toBeGreaterThan(0);
    expect(summaryPass1?.edgesInserted).toBeGreaterThan(0);
    expect(summaryPass1?.usageRowsInserted).toBeGreaterThan(0);
  });

  it('P0: pass 2 re-admits every session yet inserts ZERO new rows', () => {
    // The second watcher rediscovered and re-ingested everything (its
    // fingerprints were empty) — the replay was real, not skipped...
    expect(summaryPass2).not.toBeNull();
    expect(summaryPass2?.sessionsDiscovered).toBe(allFixtures().length);
    expect(summaryPass2?.sessionsOk).toBe(allFixtures().length);
    expect(summaryPass2?.sessionsFailed).toBe(0);
    // ...and the storage engine absorbed it idempotently: zero new rows.
    expect(summaryPass2?.edgesInserted).toBe(0);
    expect(summaryPass2?.usageRowsInserted).toBe(0);
  });

  it('P0: the database is BYTE-IDENTICAL after the second replay', () => {
    const bytesPass1 = readFileSync(snapshotPass1);
    const bytesPass2 = readFileSync(snapshotPass2);
    expect(bytesPass1.length).toBeGreaterThan(0);
    expect(bytesPass1.equals(bytesPass2)).toBe(true);
  });

  it('P0: the full ordered logical dump of every table is identical (independent check)', () => {
    // Non-empty on the tables the ingest writes — an empty-vs-empty comparison
    // would prove nothing.
    expect(dumpPass1['sessions']?.length).toBe(allFixtures().length);
    expect(dumpPass1['agents']?.length).toBeGreaterThan(0);
    expect(dumpPass1['orchestration_edges']?.length).toBeGreaterThan(0);
    expect(dumpPass1['token_usage']?.length).toBeGreaterThan(0);
    expect(dumpPass2).toEqual(dumpPass1);
  });
});
