import { afterEach, describe, expect, it } from 'vitest';
import {
  currentSchemaVersion,
  migrations,
  runMigrations,
  type Migration,
} from '../src/db/migrations';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, type TempDb } from './helpers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function dumpSchema(db: SqliteDatabase): unknown[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();
}

describe('migration runner (WP-D3)', () => {
  let temp: TempDb | undefined;

  afterEach(() => {
    temp?.cleanup();
    temp = undefined;
  });

  it('applies all migrations on a virgin database and records their ids', () => {
    temp = createMigratedTempDb();
    const recorded = temp.db
      .prepare('SELECT id, name FROM schema_version ORDER BY id')
      .all() as Array<{ id: number; name: string }>;
    expect(recorded.map((r) => r.id)).toEqual(migrations.map((m) => m.id));
    expect(recorded.map((r) => r.name)).toEqual(migrations.map((m) => m.name));
  });

  it('indexes the two unbounded tables on the retention scan key', () => {
    // WP-D10. Pruning selects by (occurred_at, id) in bounded batches against
    // `events` and `token_usage` - the only two tables that grow without
    // bound. Missing indexes would not change a single row of any result, so
    // nothing else in the suite would notice; the maintenance job would just
    // degrade to a full scan of the largest tables in the database, and do it
    // more slowly the more there is to prune.
    temp = createMigratedTempDb();
    const indexes = temp.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .pluck();

    expect(indexes.all('events')).toContain('idx_events_occurred_at_id');
    expect(indexes.all('token_usage')).toContain('idx_token_usage_occurred_at_id');
  });

  it('is idempotent: a second run applies nothing and the schema is identical', () => {
    temp = createMigratedTempDb();
    const firstDump = dumpSchema(temp.db);

    const secondRun = runMigrations(temp.db);

    expect(secondRun.appliedIds).toEqual([]);
    expect(dumpSchema(temp.db)).toEqual(firstDump);
  });

  it('creates all Phase-1 tables', () => {
    temp = createMigratedTempDb();
    const tables = (
      temp.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'events_raw',
        'events',
        'sessions',
        'agents',
        'orchestration_edges',
        'token_usage',
        'model_pricing',
        'schema_version',
      ]),
    );
  });

  it('applies only pending migrations on an upgraded database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig-'));
    const db = openDatabase(join(dir, 'partial.db'));
    try {
      const first = runMigrations(db, migrations.slice(0, 2));
      expect(first.appliedIds).toEqual([1, 2]);

      const rest = runMigrations(db);
      expect(rest.appliedIds).toEqual(migrations.slice(2).map((m) => m.id));
      expect(currentSchemaVersion(db)).toBe(migrations[migrations.length - 1]?.id);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Migration 8 repairs databases written before main-transcript usage was
   * attributed at insert time. It is a pure hard join - session_id onto the
   * main agent node that already exists - and never invents a token count.
   */
  it('backfills main-agent attribution onto legacy NULL usage rows (migration 8)', () => {
    temp = createMigratedTempDb();
    const db = temp.db;
    db.exec(`
      INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
        ('sess-legacy', 'p', '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z', 'active'),
        ('sess-nomain', 'p', '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z', 'active');
      INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at) VALUES
        ('sess-legacy', 'sess-legacy', 'main', NULL, 'working', NULL, '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z'),
        ('deadbeef', 'sess-nomain', 'subagent', NULL, 'completed', NULL, '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z');
      INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
        ('sess-legacy', NULL, 'legacy-1', 'claude-fable-5', 'output', 100, 0, '2026-07-10T01:00:00Z'),
        ('sess-legacy', 'deadbeef', 'legacy-2', 'claude-fable-5', 'output', 50, 0, '2026-07-10T01:00:00Z'),
        ('sess-nomain', NULL, 'orphan-1', 'claude-fable-5', 'output', 25, 0, '2026-07-10T01:00:00Z');
    `);

    const backfill = migrations.find((m) => m.name === 'token-usage-main-agent-attribution');
    if (backfill === undefined) {
      throw new Error('migration token-usage-main-agent-attribution is missing');
    }
    backfill.up(db);

    const attribution = db
      .prepare('SELECT message_id, agent_id FROM token_usage ORDER BY message_id')
      .all() as Array<{ message_id: string; agent_id: string | null }>;
    expect(attribution).toEqual([
      { message_id: 'legacy-1', agent_id: 'sess-legacy' }, // main turn, now attributed
      { message_id: 'legacy-2', agent_id: 'deadbeef' }, // already attributed, untouched
      { message_id: 'orphan-1', agent_id: null }, // no main node to join - stays honest
    ]);

    // Re-running it is a no-op (the runner records it, but data migrations must
    // be safe to replay regardless).
    backfill.up(db);
    expect(
      db.prepare('SELECT message_id, agent_id FROM token_usage ORDER BY message_id').all(),
    ).toEqual(attribution);
  });

  it('rejects a migration list whose ids are not strictly increasing', () => {
    temp = createMigratedTempDb();
    const bad: Migration[] = [
      { id: 2, name: 'b', up: () => undefined },
      { id: 1, name: 'a', up: () => undefined },
    ];
    expect(() => runMigrations(temp!.db, bad)).toThrow(/strictly increasing/);
  });

  it('rolls back a failing migration atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig-fail-'));
    const db = openDatabase(join(dir, 'fail.db'));
    try {
      const failing: Migration[] = [
        {
          id: 1,
          name: 'boom',
          up(target) {
            target.exec('CREATE TABLE half_done (id INTEGER PRIMARY KEY);');
            throw new Error('boom');
          },
        },
      ];
      expect(() => runMigrations(db, failing)).toThrow('boom');
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_done'")
        .all();
      expect(tables).toEqual([]);
      expect(currentSchemaVersion(db)).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('currentSchemaVersion is 0 before any migration ran', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig-virgin-'));
    const db = openDatabase(join(dir, 'virgin.db'));
    try {
      expect(currentSchemaVersion(db)).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
