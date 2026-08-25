import { afterEach, describe, expect, it } from 'vitest';
import {
  currentSchemaVersion,
  migrationChecksum,
  migrations,
  runMigrations,
  type Migration,
} from '../src/db/migrations';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';
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

function pricingRows(db: SqliteDatabase): unknown[] {
  return db
    .prepare(
      `SELECT model, bucket, usd_per_mtok, effective_from FROM model_pricing
       ORDER BY model, bucket, effective_from`,
    )
    .all();
}

const OLD_SEED_EFFECTIVE_FROM = '2026-07-11';
const OLD_PRICING_SEED = [
  { model: 'opus-4-8', inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
  { model: 'sonnet-5', inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
  { model: 'fable-5', inputUsdPerMtok: 10, outputUsdPerMtok: 50 },
  { model: 'haiku-4-5', inputUsdPerMtok: 1, outputUsdPerMtok: 5 },
  { model: '<synthetic>', inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
];

/**
 * Recreate the operator database as the ORIGINAL migration 7 (commit eded0b3)
 * left it: pre-checksum three-column `schema_version` with ids 1..7 recorded,
 * and `model_pricing` holding the original seed - bare model keys and a
 * '2026-07-11' floor. Migrations 1..6 use the real up() functions; only 7's
 * seed was later edited in place, which is the divergence under test
 * (review H-1).
 */
function openOldSeedDb(path: string): SqliteDatabase {
  const db = openDatabase(path);
  db.exec(`
    CREATE TABLE schema_version (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const record = db.prepare('INSERT INTO schema_version (id, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of migrations.filter((m) => m.id <= 7)) {
    if (migration.id === 7) {
      db.exec(`
        CREATE TABLE model_pricing (
          model          TEXT NOT NULL,
          bucket         TEXT NOT NULL CHECK (bucket IN ('input','output','cache_read','cache_write_5m','cache_write_1h')),
          usd_per_mtok   REAL NOT NULL,
          effective_from TEXT NOT NULL,
          PRIMARY KEY (model, bucket, effective_from)
        );
      `);
      const insert = db.prepare(
        'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
      );
      for (const { model, inputUsdPerMtok, outputUsdPerMtok } of OLD_PRICING_SEED) {
        insert.run(model, 'input', inputUsdPerMtok, OLD_SEED_EFFECTIVE_FROM);
        insert.run(model, 'output', outputUsdPerMtok, OLD_SEED_EFFECTIVE_FROM);
        insert.run(model, 'cache_read', inputUsdPerMtok * 0.1, OLD_SEED_EFFECTIVE_FROM);
        insert.run(model, 'cache_write_5m', inputUsdPerMtok * 1.25, OLD_SEED_EFFECTIVE_FROM);
        insert.run(model, 'cache_write_1h', inputUsdPerMtok * 2.0, OLD_SEED_EFFECTIVE_FROM);
      }
    } else {
      migration.up(db);
    }
    record.run(migration.id, migration.name, '2026-07-11T00:00:00Z');
  }
  return db;
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

  it('indexes orchestration_edges on both edge endpoints (migration 12)', () => {
    // Review M-5 (index half): the global-DAG edge query filters on
    // parent_agent_id AND child_agent_id, but migration 5 indexed only
    // session_id - so that read was a full scan of the edge table. Like the
    // retention indexes, dropping these changes no result, only its cost.
    temp = createMigratedTempDb();
    const indexes = temp.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orchestration_edges'`,
      )
      .pluck()
      .all();
    expect(indexes).toContain('idx_orchestration_edges_parent_agent_id');
    expect(indexes).toContain('idx_orchestration_edges_child_agent_id');
  });

  it('widens the edge-source CHECK to legacy_explore without losing a row (migration 13)', () => {
    // Parser gate #7 emits `legacy_explore` edges; migration 5's CHECK knows
    // only the four structural sources, so SQLite forces a table rebuild.
    // The failure this test defends against: a rebuild that drops persisted
    // edges, loosens the dedup key, or forgets to recreate the indexes.
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig13-'));
    const db = openDatabase(join(dir, 'edges.db'));
    try {
      runMigrations(
        db,
        migrations.filter((m) => m.id < 13),
      );
      const insert = db.prepare(
        `INSERT OR IGNORE INTO orchestration_edges
           (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('s1', 'parent', 'child-a', 'tool_use', 'default', 'host', '2026-08-01T00:00:00Z');
      // Proof the widening is real: the OLD schema rejects the new source.
      // Plain INSERT here - OR IGNORE would swallow the CHECK violation too.
      expect(() =>
        db
          .prepare(
            `INSERT INTO orchestration_edges
               (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at)
             VALUES ('s1', 'parent', 'child-b', 'legacy_explore', 'default', 'host', NULL)`,
          )
          .run(),
      ).toThrow(/CHECK/);

      runMigrations(db);

      // The pre-existing row survived the rebuild verbatim...
      expect(
        db.prepare(`SELECT * FROM orchestration_edges WHERE child_agent_id = 'child-a'`).get(),
      ).toMatchObject({ session_id: 's1', source: 'tool_use', created_at: '2026-08-01T00:00:00Z' });
      // ...the new provenance now persists...
      insert.run('s1', 'parent', 'child-b', 'legacy_explore', 'default', 'host', null);
      expect(
        db
          .prepare(`SELECT source FROM orchestration_edges WHERE child_agent_id = 'child-b'`)
          .pluck()
          .get(),
      ).toBe('legacy_explore');
      // ...the UNIQUE dedup key still holds...
      const replay = insert.run(
        's1',
        'parent',
        'child-b',
        'legacy_explore',
        'default',
        'host',
        null,
      );
      expect(replay.changes).toBe(0);
      // ...and DROP TABLE did not eat the three read-path indexes.
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orchestration_edges'`,
        )
        .pluck()
        .all();
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_orchestration_edges_session_id',
          'idx_orchestration_edges_parent_agent_id',
          'idx_orchestration_edges_child_agent_id',
        ]),
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

  /**
   * Review H-1: migration 7's seed was edited in place after the operator
   * database applied it. Migration 11 must converge BOTH histories - a
   * database that ran the original 7 and a fresh database that ran the
   * current 7 - onto row-identical pricing.
   */
  describe('model_pricing seed convergence (migration 11)', () => {
    it('converges a database that applied the ORIGINAL migration 7 to match a fresh database', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig-oldseed-'));
      const db = openOldSeedDb(join(dir, 'operator.db'));
      try {
        // An operator-authored row shares the old floor but not the old keys;
        // convergence must never touch it.
        db.prepare(
          'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
        ).run('my-local-model', 'input', 7, OLD_SEED_EFFECTIVE_FROM);

        const result = runMigrations(db);
        expect(result.appliedIds).toEqual(migrations.filter((m) => m.id > 7).map((m) => m.id));

        temp = createMigratedTempDb();
        const rows = pricingRows(db) as Array<{ model: string; effective_from: string }>;
        expect(rows.filter((r) => r.model === 'my-local-model')).toHaveLength(1);
        expect(rows.filter((r) => r.model !== 'my-local-model')).toEqual(pricingRows(temp.db));

        // Not one row of the original seed's shape survives: bare keys are
        // gone entirely, and '<synthetic>' no longer carries the old floor.
        const staleKeys = rows.filter((r) =>
          ['opus-4-8', 'sonnet-5', 'fable-5', 'haiku-4-5'].includes(r.model),
        );
        expect(staleKeys).toEqual([]);
        const staleSynthetic = rows.filter(
          (r) => r.model === '<synthetic>' && r.effective_from === OLD_SEED_EFFECTIVE_FROM,
        );
        expect(staleSynthetic).toEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('replaying migration 11 on a fresh database changes nothing', () => {
      // The fixture stops at migration 13 deliberately. Migration 11's upsert
      // targets (model, bucket, effective_from) using the PRE-canonical seed
      // spelling; once migration 14 canonicalizes that column at write time,
      // the conflict target no longer matches the stored row, so the upsert
      // would insert a duplicate and then collide on the primary key when the
      // trigger rewrote it. That is the exact trap db/pricing.ts's write path
      // sidesteps by canonicalizing BEFORE the statement runs, and it cannot
      // arise in production: the runner never replays an applied migration,
      // and any database on which 11 can still run predates the triggers.
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig11-replay-'));
      const db = openDatabase(join(dir, 'replay.db'));
      try {
        runMigrations(
          db,
          migrations.filter((m) => m.id < 14),
        );
        const before = pricingRows(db);
        const convergence = migrations.find((m) => m.name === 'model-pricing-seed-convergence');
        if (convergence === undefined) {
          throw new Error('migration model-pricing-seed-convergence is missing');
        }
        convergence.up(db);
        expect(pricingRows(db)).toEqual(before);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  /**
   * Review M-21: dated-price resolution exists twice - core compares instants
   * in epoch milliseconds, the API's priced CTE compares `effective_from <=
   * occurred_at` as BINARY-collated TEXT. They agree only while the stored
   * text sorts chronologically, which mixed spellings of one instant break.
   * Migration 14 makes the column hold ONE canonical spelling,
   * `YYYY-MM-DDTHH:mm:ss.sssZ`, on both histories: the rows already stored and
   * every row written afterwards, including by the sqlite3 CLI.
   */
  describe('canonical effective_from (migration 14)', () => {
    const TRIGGERS = [
      'model_pricing_effective_from_canonical_insert',
      'model_pricing_effective_from_canonical_update',
      'model_pricing_effective_from_guard_insert',
      'model_pricing_effective_from_guard_update',
    ];

    /** A database migrated to the state right BEFORE migration 14 ran. */
    function openPreCanonicalDb(dir: string): SqliteDatabase {
      const db = openDatabase(join(dir, 'pre-canonical.db'));
      runMigrations(
        db,
        migrations.filter((m) => m.id < 14),
      );
      return db;
    }

    function insertRate(
      db: SqliteDatabase,
      model: string,
      usd: number,
      effectiveFrom: string,
    ): void {
      db.prepare(
        'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
      ).run(model, 'input', usd, effectiveFrom);
    }

    function effectiveFromValues(db: SqliteDatabase, model: string): unknown[] {
      return db
        .prepare('SELECT effective_from FROM model_pricing WHERE model = ? ORDER BY effective_from')
        .pluck()
        .all(model);
    }

    it('rewrites the seeded bare dates and installs the write-time triggers on a fresh database', () => {
      temp = createMigratedTempDb();
      const stored = temp.db
        .prepare('SELECT DISTINCT effective_from FROM model_pricing')
        .pluck()
        .all();
      // Migration 7 seeds '2026-01-01'; PRICING_SEED_EFFECTIVE_FROM itself is
      // frozen (it is hashed into every migration's checksum, so editing it
      // would brick an operator database), and migration 14 is what makes the
      // END STATE canonical on both the fresh and the upgraded path.
      expect(stored).toEqual(['2026-01-01T00:00:00.000Z']);

      // Scoped to migration 14's own trigger family by name, not to the whole
      // `model_pricing` table: migration 16 hangs the rollup's pricing-recompute
      // triggers off the same table, and they are asserted exhaustively in their
      // own block below. The list stays an exact `toEqual` so a trigger going
      // missing still fails here.
      const triggers = temp.db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND tbl_name = 'model_pricing'
              AND name LIKE 'model_pricing_effective_from_%'
            ORDER BY name`,
        )
        .pluck()
        .all();
      expect(triggers).toEqual(TRIGGERS);
    });

    it('canonicalizes an operator database written under the ORIGINAL seed and its hand-typed rows', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig14-operator-'));
      const db = openOldSeedDb(join(dir, 'operator.db'));
      try {
        // Exactly what the documented cross-connection write path produces: an
        // operator typing rates into the sqlite3 CLI, in the spellings a human
        // types. Both denote instants the old text comparison ordered wrongly.
        insertRate(db, 'my-local-model', 7, '2026-09-01');
        insertRate(db, 'my-local-model', 9, '2026-10-01T02:00:00+02:00');

        runMigrations(db);

        expect(effectiveFromValues(db, 'my-local-model')).toEqual([
          '2026-09-01T00:00:00.000Z',
          '2026-10-01T00:00:00.000Z', // the offset was converted, not stripped
        ]);
        // The pre-existing seed rows converged onto the same canonical form a
        // fresh database gets - the two histories are row-identical.
        temp = createMigratedTempDb();
        const rows = pricingRows(db) as Array<{ model: string }>;
        expect(rows.filter((r) => r.model !== 'my-local-model')).toEqual(pricingRows(temp.db));
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('collapses two spellings of one instant that carry the SAME rate', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig14-collapse-'));
      const db = openPreCanonicalDb(dir);
      try {
        insertRate(db, 'dup-model', 12, '2026-05-01');
        insertRate(db, 'dup-model', 12, '2026-05-01T00:00:00Z');

        runMigrations(db);

        // No dollar changes, and the composite primary key could not hold both
        // rows once they spell the instant the same way.
        expect(
          db
            .prepare(
              `SELECT usd_per_mtok, effective_from FROM model_pricing WHERE model = 'dup-model'`,
            )
            .all(),
        ).toEqual([{ usd_per_mtok: 12, effective_from: '2026-05-01T00:00:00.000Z' }]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('halts, without touching a row, when two spellings of one instant carry DIFFERENT rates', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig14-conflict-'));
      const db = openPreCanonicalDb(dir);
      try {
        insertRate(db, 'conflict-model', 12, '2026-05-01');
        insertRate(db, 'conflict-model', 20, '2026-05-01T00:00:00Z');

        // Which rate was ever in force is unknowable from here; picking either
        // would invent dollars, so the migration refuses.
        expect(() => runMigrations(db)).toThrow(/conflicting rates/);
        expect(currentSchemaVersion(db)).toBe(13);
        expect(effectiveFromValues(db, 'conflict-model')).toEqual([
          '2026-05-01',
          '2026-05-01T00:00:00Z',
        ]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('halts on a stored value that is not an unambiguous instant', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig14-unparseable-'));
      const db = openPreCanonicalDb(dir);
      try {
        // SQLite would read this as a Julian day number and date the rate to
        // 4707 BC. Guessing is the failure this project refuses: name the row
        // and stop.
        insertRate(db, 'bad-model', 4, '2026');

        expect(() => runMigrations(db)).toThrow(
          /model=bad-model, bucket=input.*not an\s+unambiguous instant/s,
        );
        expect(currentSchemaVersion(db)).toBe(13);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('halts on a stored date the calendar does not have', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig14-nonexistent-day-'));
      const db = openPreCanonicalDb(dir);
      try {
        // Both date parsers roll '2026-02-30' into March 2 rather than
        // failing, so a typo would silently move the day a rate takes effect.
        insertRate(db, 'feb30-model', 4, '2026-02-30');

        expect(() => runMigrations(db)).toThrow(/not an\s+unambiguous instant/s);
        expect(currentSchemaVersion(db)).toBe(13);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('canonicalizes and guards writes made afterwards through raw SQL', () => {
      // The operator's sqlite3 CLI knows nothing about the canonical form -
      // that is precisely why the invariant lives in the database rather than
      // in the server's write path.
      temp = createMigratedTempDb();
      insertRate(temp.db, 'cli-model', 7, '2026-09-01');
      insertRate(temp.db, 'cli-model', 8, '2026-10-01T02:00:00+02:00');
      expect(effectiveFromValues(temp.db, 'cli-model')).toEqual([
        '2026-09-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z',
      ]);

      // An UPDATE is guarded and canonicalized the same way as an INSERT...
      temp.db
        .prepare(
          `UPDATE model_pricing SET effective_from = '2026-11-01'
             WHERE model = 'cli-model' AND effective_from = '2026-09-01T00:00:00.000Z'`,
        )
        .run();
      expect(effectiveFromValues(temp.db, 'cli-model')).toEqual([
        '2026-10-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z',
      ]);
      // ...and a rate correction that does not touch effective_from still works.
      const corrected = temp.db
        .prepare(`UPDATE model_pricing SET usd_per_mtok = 9 WHERE model = 'cli-model'`)
        .run();
      expect(corrected.changes).toBe(2);

      // A spelling that does not denote one instant is rejected outright.
      expect(() => insertRate(temp!.db, 'cli-model', 7, '2026-09-01T00:00:00')).toThrow(
        /must be a bare UTC date or a zoned ISO-8601 instant/,
      );
      expect(() =>
        temp!.db
          .prepare(`UPDATE model_pricing SET effective_from = 'now' WHERE model = 'cli-model'`)
          .run(),
      ).toThrow(/must be a bare UTC date or a zoned ISO-8601 instant/);
      expect(effectiveFromValues(temp.db, 'cli-model')).toEqual([
        '2026-10-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z',
      ]);

      // Two spellings of ONE instant are a duplicate rate, and the primary key
      // says so loudly instead of storing the instant twice.
      expect(() => insertRate(temp!.db, 'cli-model', 7, '2026-11-01T00:00:00Z')).toThrow(
        /UNIQUE|PRIMARY/,
      );
    });
  });

  /**
   * Migration 15 is the OTHER operand of the same comparison migration 14
   * fixed. `mp.effective_from <= tu.occurred_at` has two sides, and
   * canonicalizing one of them fixes only the spellings the operator types;
   * `token_usage.occurred_at` arrived verbatim from the JSONL. The parity
   * suite pinned the consequence as `offset-form-occurred-at` - core priced a
   * row at the rate the halt gate approved while the API reported the same
   * tokens as unpriced - and this migration is what graduated that pin.
   */
  describe('canonical occurred_at (migration 15)', () => {
    /** A database migrated to the state right BEFORE migration 15 ran. */
    function openPreCanonicalUsageDb(dir: string): SqliteDatabase {
      const db = openDatabase(join(dir, 'pre-canonical-usage.db'));
      runMigrations(
        db,
        migrations.filter((m) => m.id < 15),
      );
      db.exec(
        `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
         VALUES ('sess-oa', 'p', '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z', 'active')`,
      );
      return db;
    }

    /**
     * Raw SQL on purpose, and on a pre-15 database on purpose: the point of
     * the migration is that rows written by a writer that knows nothing about
     * the canonical form get repaired, so seeding through the canonicalizing
     * JS path would test nothing.
     */
    function insertUsage(db: SqliteDatabase, messageId: string, occurredAt: string): void {
      db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
         VALUES ('sess-oa', NULL, ?, 'claude-fable-5', 'input', 100, 0, ?)`,
      ).run(messageId, occurredAt);
    }

    function occurredAtValues(db: SqliteDatabase): unknown[] {
      return db.prepare('SELECT occurred_at FROM token_usage ORDER BY message_id').pluck().all();
    }

    function withPreCanonicalDb(slug: string, body: (db: SqliteDatabase) => void): void {
      const dir = mkdtempSync(join(tmpdir(), `agenthropic-mig15-${slug}-`));
      const db = openPreCanonicalUsageDb(dir);
      try {
        body(db);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('rewrites every stored spelling to the one whose text order is its clock order', () => {
      withPreCanonicalDb('backfill', (db) => {
        // The pinned defect itself: as an instant this is an hour AFTER
        // 2026-03-01T00:00:00Z, but its '2026-02-…' prefix sorts BELOW it, so
        // the priced CTE found no applicable rate at all.
        insertUsage(db, 'a-offset', '2026-02-28T20:00:00-05:00');
        // Second-precision, the form the fixtures write.
        insertUsage(db, 'b-plain', '2026-03-01T09:30:00Z');
        // A bare UTC date - what a hand-written or legacy row can carry.
        insertUsage(db, 'c-bare', '2026-03-02');
        // Already canonical: the loop must leave it exactly alone rather than
        // rewriting it to an equal value, which is what makes a replay a no-op.
        insertUsage(db, 'd-canonical', '2026-03-03T00:00:00.000Z');

        runMigrations(db);

        expect(occurredAtValues(db)).toEqual([
          '2026-03-01T01:00:00.000Z',
          '2026-03-01T09:30:00.000Z',
          '2026-03-02T00:00:00.000Z',
          '2026-03-03T00:00:00.000Z',
        ]);
      });
    });

    it('leaves a NULL occurred_at alone instead of inventing an instant for it', () => {
      withPreCanonicalDb('null', (db) => {
        db.prepare(
          `INSERT INTO token_usage
             (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
           VALUES ('sess-oa', NULL, 'no-time', 'claude-fable-5', 'input', 100, 0, NULL)`,
        ).run();

        runMigrations(db);

        expect(occurredAtValues(db)).toEqual([null]);
      });
    });

    it('halts on a stored value that is not an unambiguous instant', () => {
      withPreCanonicalDb('unparseable', (db) => {
        // SQLite would read a bare '2026' as a Julian day number. A usage
        // timestamp is never guessed: name the row and stop.
        insertUsage(db, 'bad', '2026');

        expect(() => runMigrations(db)).toThrow(/id=\d+.*not an unambiguous instant/s);
        // Nothing was rewritten and the version did not advance - a halted
        // migration must leave a database exactly where it found it.
        expect(currentSchemaVersion(db)).toBe(14);
        expect(occurredAtValues(db)).toEqual(['2026']);
      });
    });

    it('halts on a stored date the calendar does not have', () => {
      withPreCanonicalDb('nonexistent-day', (db) => {
        // Both date parsers roll '2026-02-30' forward into March rather than
        // failing, which would file the spend under a day nothing happened on
        // and expire it from retention on the wrong date.
        insertUsage(db, 'feb30', '2026-02-30T00:00:00Z');

        expect(() => runMigrations(db)).toThrow(/not an unambiguous instant/s);
        expect(currentSchemaVersion(db)).toBe(14);
      });
    });

    it('makes a non-canonical value unstorable from here on, whatever writes it', () => {
      temp = createMigratedTempDb();
      insertSession(temp.db, 'sess-oa');
      const db = temp.db;

      // The AFTER-INSERT trigger rewrites what raw SQL spells non-canonically,
      // so the storage invariant does not depend on one module remembering.
      insertUsage(db, 'raw-offset', '2026-02-28T20:00:00-05:00');
      expect(occurredAtValues(db)).toEqual(['2026-03-01T01:00:00.000Z']);

      // ...and on UPDATE too, which is the path an operator at the sqlite3 CLI
      // actually takes.
      db.prepare(
        `UPDATE token_usage SET occurred_at = '2026-04-01T06:00:00+02:00' WHERE message_id = 'raw-offset'`,
      ).run();
      expect(occurredAtValues(db)).toEqual(['2026-04-01T04:00:00.000Z']);

      // A value that denotes no instant is refused rather than coerced.
      expect(() => insertUsage(db, 'raw-bad', 'now')).toThrow(
        /occurred_at must be NULL, a bare UTC date, or a zoned ISO-8601 instant/,
      );
      expect(() =>
        db
          .prepare(`UPDATE token_usage SET occurred_at = '2026-13-01' WHERE message_id = ?`)
          .run('raw-offset'),
      ).toThrow(/occurred_at must be NULL/);
      expect(occurredAtValues(db)).toEqual(['2026-04-01T04:00:00.000Z']);
    });
  });

  /**
   * Review H-1 (checksum half): `runMigrations` skips by recorded id alone, so
   * nothing used to notice when an already-applied migration's content was
   * edited in place. Every applied migration now records a content checksum
   * that is re-verified on every run.
   */
  describe('migration content integrity (checksums)', () => {
    it('records a content checksum for every migration it applies', () => {
      temp = createMigratedTempDb();
      const rows = temp.db
        .prepare('SELECT id, checksum FROM schema_version ORDER BY id')
        .all() as Array<{ id: number; checksum: string | null }>;
      expect(rows).toHaveLength(migrations.length);
      for (const row of rows) {
        const migration = migrations.find((m) => m.id === row.id);
        if (migration === undefined) {
          throw new Error(`unexpected schema_version row ${String(row.id)}`);
        }
        expect(row.checksum).toBe(migrationChecksum(migration));
      }
    });

    it('backfills trust-on-first-verify checksums onto a pre-checksum database', () => {
      // The operator database predates checksum recording (three-column
      // schema_version, NULL-less to the extent it has no checksum column at
      // all). What content actually ran there is unrecoverable, so the
      // CURRENT content is recorded once - only future edits are detectable.
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig-backfill-'));
      const db = openOldSeedDb(join(dir, 'operator.db'));
      try {
        runMigrations(db);
        const rows = db
          .prepare('SELECT id, checksum FROM schema_version ORDER BY id')
          .all() as Array<{ id: number; checksum: string | null }>;
        expect(rows).toHaveLength(migrations.length);
        for (const row of rows) {
          const migration = migrations.find((m) => m.id === row.id);
          if (migration === undefined) {
            throw new Error(`unexpected schema_version row ${String(row.id)}`);
          }
          expect(row.checksum).toBe(migrationChecksum(migration));
        }
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws loudly, before applying anything, when an applied migration was edited in place', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig-edited-'));
      const db = openDatabase(join(dir, 'edited.db'));
      try {
        runMigrations(db, [
          {
            id: 1,
            name: 'first',
            up(d) {
              d.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
            },
          },
        ]);
        const edited: Migration[] = [
          {
            id: 1,
            name: 'first',
            up(d) {
              d.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY, sneaky TEXT DEFAULT 'x');");
            },
          },
          {
            id: 2,
            name: 'second',
            up(d) {
              d.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY);');
            },
          },
        ];
        expect(() => runMigrations(db, edited)).toThrow(
          /Migration 1 \(first\) was edited after being applied/,
        );
        // Fail-fast: the pending migration 2 was never applied.
        const t2 = db.prepare("SELECT name FROM sqlite_master WHERE name = 't2'").all();
        expect(t2).toEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('tolerates formatting-only differences in an applied migration', () => {
      // The checksum strips whitespace before hashing, so a formatter or
      // TS-transform change never bricks a healthy database.
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig-reformat-'));
      const db = openDatabase(join(dir, 'reformat.db'));
      try {
        runMigrations(db, [
          {
            id: 1,
            name: 'first',
            up(d) {
              const sql = 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);';
              d.exec(sql);
            },
          },
        ]);
        const reformatted: Migration[] = [
          {
            id: 1,
            name: 'first',
            up(d) {
              const sql = 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);';

              d.exec(sql);
            },
          },
        ];
        expect(runMigrations(db, reformatted).appliedIds).toEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('skips verification for applied ids the current list does not know', () => {
      // A database touched by a NEWER build must still open under this one:
      // content this build never shipped cannot be verified against anything.
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig-unknown-'));
      const db = openDatabase(join(dir, 'unknown.db'));
      try {
        const first: Migration = {
          id: 1,
          name: 'a',
          up(d) {
            d.exec('CREATE TABLE ta (id INTEGER PRIMARY KEY);');
          },
        };
        const second: Migration = {
          id: 2,
          name: 'b',
          up(d) {
            d.exec('CREATE TABLE tb (id INTEGER PRIMARY KEY);');
          },
        };
        runMigrations(db, [first, second]);
        expect(runMigrations(db, [first]).appliedIds).toEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
