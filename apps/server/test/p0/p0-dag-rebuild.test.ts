/**
 * P0 proof 3 (WP-X3 + WP-IN13): the DAG is rebuilt from JSONL alone.
 *
 * The persisted DAG — rows of `agents` plus the logical columns of
 * `orchestration_edges` — must be derivable from the JSONL corpus with no help
 * from hook events. Two databases are compared row-by-row:
 *
 *  - REFERENCE: full pipeline — corpus ingest PLUS hook events appended into
 *    `events_raw` via the production `SqliteEventStore` (hooks contribute
 *    liveness only, never structure — asserted directly: the DAG rows are
 *    bit-identical before and after the hook appends);
 *  - REBUILD: a fresh, empty database that ingests ONLY the JSONL corpus.
 *
 * Then the simulated outage: a third database ingests a PARTIAL corpus (a
 * mid-flight crash shape: some sessions missing entirely, one session's main
 * transcript present but its subagent artifacts not yet flushed), the process
 * "dies" (db.close()), the database is reopened and replayed over the FULL
 * corpus — and the final DAG must equal the from-scratch DAG exactly.
 *
 * Determinism pins: same fixed `now()` (edge created_at), same
 * `DASHBOARD_INSTANCE`, same process (hostId). Edge comparison excludes only
 * the surrogate autoincrement `id` (physical insert order, not structure).
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFixture, type Fixture } from '@agenthropic/test-fixtures';
import {
  SqliteEventStore,
  loadPricing,
  openDatabase,
  runCorpusIngest,
  runMigrations,
  type CorpusIngestSummary,
  type SqliteDatabase,
} from '../../src/index';
import {
  FIXED_NOW,
  allFixtures,
  corpusEnv,
  countRows,
  dumpDag,
  makeTempDir,
  materializeCorpus,
  openSeededDb,
  type DagDump,
} from './harness';

const INSTANCE = 'p0-proof-3';

function ingestCorpus(db: SqliteDatabase, corpusRoot: string): CorpusIngestSummary {
  return runCorpusIngest({
    db,
    pricing: loadPricing(db),
    env: corpusEnv(corpusRoot, INSTANCE),
    now: () => FIXED_NOW,
  });
}

/** Append synthetic hook liveness events (Stop / SubagentStop) for every session. */
function appendHookEvents(db: SqliteDatabase, sessionIds: readonly string[]): number {
  const store = new SqliteEventStore(db);
  let appended = 0;
  for (const sessionId of sessionIds) {
    for (const eventName of ['Stop', 'SubagentStop']) {
      const { inserted } = store.append({
        idempotencyKey: `hook:${eventName}:${sessionId}:${FIXED_NOW}`,
        source: 'hook',
        eventType: eventName,
        payload: { hook_event_name: eventName, session_id: sessionId },
        receivedAt: FIXED_NOW,
      });
      expect(inserted).toBe(true);
      appended += 1;
    }
  }
  return appended;
}

describe('P0 proof 3 - the persisted DAG is rebuilt from JSONL alone', () => {
  const dirs: string[] = [];
  const openDbs: SqliteDatabase[] = [];
  let sessionIds: string[];
  let referenceDb: SqliteDatabase;
  let referenceDagBeforeHooks: DagDump;
  let referenceDag: DagDump;
  let hookEventsAppended: number;
  let rebuildDb: SqliteDatabase;
  let rebuildSummary: CorpusIngestSummary;
  let rebuildDag: DagDump;

  beforeAll(() => {
    const dir = makeTempDir('agenthropic-p0-dag-');
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    sessionIds = [...materializeCorpus(corpusRoot, allFixtures()).keys()];

    // REFERENCE: full pipeline — JSONL ingest + hook events in events_raw.
    referenceDb = openSeededDb(join(dir, 'reference.db'));
    openDbs.push(referenceDb);
    const referenceSummary = ingestCorpus(referenceDb, corpusRoot);
    expect(referenceSummary.sessionsOk).toBe(allFixtures().length);
    referenceDagBeforeHooks = dumpDag(referenceDb);
    hookEventsAppended = appendHookEvents(referenceDb, sessionIds);
    referenceDag = dumpDag(referenceDb);

    // REBUILD: a fresh empty database fed NOTHING but the JSONL corpus.
    rebuildDb = openSeededDb(join(dir, 'rebuild.db'));
    openDbs.push(rebuildDb);
    rebuildSummary = ingestCorpus(rebuildDb, corpusRoot);
    rebuildDag = dumpDag(rebuildDb);
  });

  afterAll(() => {
    for (const db of openDbs.splice(0)) {
      db.close();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P0: the corpus produced a real DAG to compare (proof precondition)', () => {
    expect(rebuildSummary.sessionsOk).toBe(allFixtures().length);
    expect(rebuildSummary.sessionsFailed).toBe(0);
    expect(rebuildDag.agents.length).toBeGreaterThan(0);
    expect(rebuildDag.edges.length).toBeGreaterThan(0);
  });

  it('P0: hook events contribute liveness only — they never change the DAG', () => {
    expect(hookEventsAppended).toBe(sessionIds.length * 2);
    expect(countRows(referenceDb, 'events_raw')).toBeGreaterThanOrEqual(hookEventsAppended);
    // The DAG rows are identical before and after the hook appends.
    expect(referenceDag).toEqual(referenceDagBeforeHooks);
  });

  it('P0: a fresh DB ingesting ONLY JSONL equals the full-pipeline DAG, row by row', () => {
    // The rebuild database really is hook-free...
    expect(countRows(rebuildDb, 'events_raw')).toBe(0);
    // ...yet its agents rows (all columns) and its logical edge rows equal the
    // reference built with the full pipeline.
    expect(rebuildDag.agents).toEqual(referenceDag.agents);
    expect(rebuildDag.edges).toEqual(referenceDag.edges);
  });

  it('P0: after a simulated outage, replaying the full corpus converges to the same DAG', () => {
    const dir = makeTempDir('agenthropic-p0-outage-');
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    const dbPath = join(dir, 'outage.db');

    // BEFORE the outage the machine saw only a partial corpus: two sessions
    // complete, one caught mid-flight — its main transcript flushed, its
    // subagent artifacts not yet on disk.
    const nested = getFixture('nested-workflow');
    const nestedMainOnly: Fixture = {
      ...nested,
      files: nested.files.filter((f) => !f.relativePath.includes('/')),
    };
    materializeCorpus(corpusRoot, [
      getFixture('flat-tool-use'),
      getFixture('depth-2-sync'),
      nestedMainOnly,
    ]);

    const preOutageDb = openSeededDb(dbPath);
    const partialSummary = ingestCorpus(preOutageDb, corpusRoot);
    expect(partialSummary.sessionsOk).toBe(3);
    const partialDag = dumpDag(preOutageDb);
    expect(partialDag.agents.length).toBeGreaterThan(0);
    expect(partialDag.agents.length).toBeLessThan(rebuildDag.agents.length);
    expect(partialDag.edges.length).toBeLessThan(rebuildDag.edges.length);

    // The outage: the process dies mid-corpus.
    preOutageDb.close();

    // Recovery: reopen the SAME database file (migrations no-op — the schema
    // is already current), the full corpus is now on disk, replay everything.
    const recoveredDb = openDatabase(dbPath);
    openDbs.push(recoveredDb);
    runMigrations(recoveredDb);
    materializeCorpus(corpusRoot, allFixtures());
    const replaySummary = ingestCorpus(recoveredDb, corpusRoot);
    expect(replaySummary.sessionsOk).toBe(allFixtures().length);
    expect(replaySummary.sessionsFailed).toBe(0);

    // The recovered DAG equals the from-scratch JSONL-only DAG exactly.
    const recoveredDag = dumpDag(recoveredDb);
    expect(recoveredDag.agents).toEqual(rebuildDag.agents);
    expect(recoveredDag.edges).toEqual(rebuildDag.edges);
  });
});
