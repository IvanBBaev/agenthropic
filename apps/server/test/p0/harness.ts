/**
 * Shared harness for the three P0 release-blocker proofs (WP-X3 + WP-IN13,
 * docs/site/contributing/testing.md section 4).
 *
 * Everything here materializes the synthetic fixture corpus onto REAL disk
 * inside a mkdtemp directory and drives the production ingest through its
 * public exports. Tests never read or write the real `~/.claude/projects`:
 * every ingest call receives an explicit `CLAUDE_PROJECTS_DIR` env map.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getFixture, listFixtures, type Fixture } from '@agenthropic/test-fixtures';
import { openDatabase, runMigrations, type SqliteDatabase } from '../../src/index';

/** One synthetic project slug hosts every fixture session (ids are disjoint). */
export const SLUG = '-Users-synthetic-p0-project';

/**
 * Fixed injectable clock. Both ISO and epoch forms are derived from the same
 * instant so `now` (edge created_at stamps) and `nowMs` (watchdog) agree.
 */
export const FIXED_NOW = '2026-03-01T12:00:00.000Z';
export const FIXED_NOW_MS = Date.parse(FIXED_NOW);

/** Park the watchdog far away: these proofs are about persistence, not liveness. */
export const HUGE_WATCHDOG_MS = 1_000_000_000_000;

/** The five priced buckets under their `token_usage.bucket` snake_case names. */
export const DB_BUCKETS = [
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
] as const;
export type DbBucket = (typeof DB_BUCKETS)[number];

/** Models used by the synthetic fixture corpus (seeded at 1 USD/Mtok flat). */
const SYNTHETIC_MODELS = ['synthetic-model-a', 'synthetic-model-b'] as const;

/** Every registered fixture, in the registry's stable order. */
export function allFixtures(): readonly Fixture[] {
  return listFixtures().map((name) => getFixture(name));
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Session id of a fixture: the bare no-slash `<uuid>.jsonl` main stem — the
 * only file enumeration keys on. For a fixture that ships NO main transcript
 * (`usage-dedup`), the id is read from the `sessionId` field of the first
 * agent-transcript record, which is where the parser derives it from too.
 */
export function sessionIdOf(fixture: Fixture): string {
  const main = fixture.files.find((f) => !f.relativePath.includes('/'));
  if (main !== undefined) {
    return main.relativePath.slice(0, -'.jsonl'.length);
  }
  const transcript = fixture.files.find((f) => f.relativePath.endsWith('.jsonl'));
  if (transcript === undefined || transcript.lines.length === 0) {
    throw new Error(`fixture ${fixture.name} has no transcript to derive a session id from`);
  }
  const record = JSON.parse(transcript.lines[0] as string) as { sessionId?: unknown };
  if (typeof record.sessionId !== 'string') {
    throw new Error(`fixture ${fixture.name}: first transcript record carries no sessionId`);
  }
  return record.sessionId;
}

/**
 * Lay one fixture out on REAL disk the way Claude Code does: the main
 * transcript as `<slug>/<uuid>.jsonl`, nested artifacts under
 * `<slug>/<uuid>/...`. Every `.jsonl`/sidecar file gets its trailing newline
 * (the line splitter drops the final unterminated segment of a jsonl file).
 *
 * Resolved spec ambiguity, asserted in the proof-1 test: `usage-dedup` ships
 * no main transcript, but corpus enumeration keys sessions exclusively on the
 * bare `<uuid>.jsonl`. A ZERO-BYTE main is materialized for it — exactly the
 * "just-created session, first record not flushed yet" shape the disk reader
 * tolerates as an 'empty-main' skip while still ingesting the live subagent
 * transcripts. Returns the fixture's session id.
 */
export function materializeFixture(corpusRoot: string, fixture: Fixture): string {
  const sessionId = sessionIdOf(fixture);
  const hasMain = fixture.files.some((f) => !f.relativePath.includes('/'));
  if (!hasMain) {
    const mainAbs = join(corpusRoot, SLUG, `${sessionId}.jsonl`);
    mkdirSync(dirname(mainAbs), { recursive: true });
    writeFileSync(mainAbs, '');
  }
  for (const f of fixture.files) {
    const rel = f.relativePath.includes('/')
      ? join(sessionId, ...f.relativePath.split('/'))
      : f.relativePath;
    const abs = join(corpusRoot, SLUG, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.lines.join('\n') + '\n');
  }
  return sessionId;
}

/** Materialize a set of fixtures into one corpus; session id -> fixture. */
export function materializeCorpus(
  corpusRoot: string,
  fixtures: readonly Fixture[],
): Map<string, Fixture> {
  const bySessionId = new Map<string, Fixture>();
  for (const fixture of fixtures) {
    bySessionId.set(materializeFixture(corpusRoot, fixture), fixture);
  }
  return bySessionId;
}

/** Seed flat 1 USD/Mtok prices for the synthetic fixture models. */
export function seedSyntheticPricing(db: SqliteDatabase): void {
  const insert = db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, 1, ?)',
  );
  for (const model of SYNTHETIC_MODELS) {
    for (const bucket of DB_BUCKETS) {
      insert.run(model, bucket, '2020-01-01');
    }
  }
}

/** Open + migrate + price-seed a database at `dbPath`. */
export function openSeededDb(dbPath: string): SqliteDatabase {
  const db = openDatabase(dbPath);
  runMigrations(db);
  seedSyntheticPricing(db);
  return db;
}

/**
 * The env map handed to every ingest/watcher call. `CLAUDE_PROJECTS_DIR` pins
 * the corpus root to the temp dir (the real `~/.claude/projects` is never
 * touched); `DASHBOARD_INSTANCE` pins the identity stamped onto edges so two
 * databases built by different calls remain row-comparable.
 */
export function corpusEnv(corpusRoot: string, instance: string): Record<string, string> {
  return { CLAUDE_PROJECTS_DIR: corpusRoot, DASHBOARD_INSTANCE: instance };
}

/**
 * Deterministic logical dump of EVERY user table: rows of `SELECT *` ordered
 * by all columns, keyed by table name. Independent of page layout, rowids and
 * insertion order — the second, physical-layout-agnostic equality check next
 * to the byte-for-byte snapshot comparison.
 */
export function dumpAllTables(db: SqliteDatabase): Record<string, unknown[]> {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
      (col) => col.name,
    );
    const orderBy = columns.map((col) => `"${col}"`).join(', ');
    dump[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all();
  }
  return dump;
}

/** The persisted DAG: full `agents` rows + logical `orchestration_edges` rows. */
export interface DagDump {
  readonly agents: unknown[];
  readonly edges: unknown[];
}

/**
 * Dump the persisted DAG for row-level comparison across databases. Edges are
 * compared on their LOGICAL columns; the surrogate `id` primary key encodes
 * physical insert order, not DAG structure, and is excluded.
 */
export function dumpDag(db: SqliteDatabase): DagDump {
  return {
    agents: db.prepare('SELECT * FROM agents ORDER BY id').all(),
    edges: db
      .prepare(
        `SELECT session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at
           FROM orchestration_edges
          ORDER BY session_id, parent_agent_id, child_agent_id`,
      )
      .all(),
  };
}

/** COUNT(*) for one table. */
export function countRows(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}
