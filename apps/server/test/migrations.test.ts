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
