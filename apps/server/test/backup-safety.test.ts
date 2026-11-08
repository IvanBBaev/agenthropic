/**
 * R9 / OPS-3 + OPS-9: a backup is written atomically and verified before it
 * takes its name; a restore refuses a file that is not an agenthropic database
 * or that a newer build wrote; a boot refuses a newer schema and takes a
 * verified backup before it migrates an existing database.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_PARTIAL_SUFFIX, backupDatabase, restoreDatabase } from '../src/db/backup';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import {
  assertSchemaNotNewer,
  currentSchemaVersion,
  migrations,
  pendingMigrationIds,
  runMigrations,
  type Migration,
} from '../src/db/migrations';
import { prepareSchema, start } from '../src/index';
import { BACKUP_FILE_PATTERN } from '../src/retention/backup-files';

const TEST_TOKEN = 'test-token-long-enough-for-the-policy';
const NOW = new Date('2026-11-08T10:20:30.400Z');

/** Mark `db` as written by a build that knows one more migration than this one. */
function stampNewerSchema(db: SqliteDatabase): number {
  const newer = Math.max(...migrations.map((m) => m.id)) + 1;
  db.prepare(
    'INSERT INTO schema_version (id, name, applied_at, checksum) VALUES (?, ?, ?, NULL)',
  ).run(newer, 'from-the-future', NOW.toISOString());
  return newer;
}

describe('backup safety (R9)', () => {
  const dirs: string[] = [];
  const handles: SqliteDatabase[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-r9-'));
    dirs.push(dir);
    return dir;
  }

  function migrated(path: string, list: readonly Migration[] = migrations): SqliteDatabase {
    const db = openDatabase(path);
    handles.push(db);
    runMigrations(db, list);
    return db;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of handles.splice(0)) {
      if (db.open) {
        db.close();
      }
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('backupDatabase', () => {
    it('never names an unverified copy like a backup', () => {
      expect(BACKUP_FILE_PATTERN.test(`agenthropic-x.db${BACKUP_PARTIAL_SUFFIX}`)).toBe(false);
    });

    it('renames a verified copy into place and leaves no partial file', async () => {
      const root = tempDir();
      const db = migrated(join(root, 'agent.db'));
      const dest = join(root, 'backups', 'agenthropic-one.db');
      await backupDatabase(db, dest);
      expect(readdirSync(join(root, 'backups'))).toEqual(['agenthropic-one.db']);
      const copy = openDatabase(dest);
      handles.push(copy);
      expect(currentSchemaVersion(copy)).toBe(currentSchemaVersion(db));
    });

    it('rejects a copy that fails integrity_check and keeps the earlier backup', async () => {
      const root = tempDir();
      const db = migrated(join(root, 'agent.db'));
      const dest = join(root, 'agenthropic-one.db');
      writeFileSync(dest, 'an earlier backup');
      vi.spyOn(db, 'backup').mockImplementation(async (partial: string) => {
        writeFileSync(partial, 'not a database');
        return { totalPages: 1, remainingPages: 0 };
      });
      await expect(backupDatabase(db, dest)).rejects.toThrow();
      expect(readFileSync(dest, 'utf8')).toBe('an earlier backup');
      expect(readdirSync(root).filter((f) => f.includes(BACKUP_PARTIAL_SUFFIX))).toEqual([]);
    });
  });

  describe('restoreDatabase', () => {
    it('refuses a database without schema_version and leaves the destination alone', async () => {
      const root = tempDir();
      const foreign = openDatabase(join(root, 'foreign.db'));
      handles.push(foreign);
      foreign.exec('CREATE TABLE t (x)');
      const backup = join(root, 'foreign-backup.db');
      await backupDatabase(foreign, backup);
      const dest = join(root, 'live', 'agent.db');
      expect(() => restoreDatabase(backup, dest)).toThrow(/not an agenthropic backup/);
      expect(existsSync(dest)).toBe(false);
    });

    it('refuses a backup written by a newer build', async () => {
      const root = tempDir();
      const db = migrated(join(root, 'agent.db'));
      const newer = stampNewerSchema(db);
      const backup = join(root, 'newer.db');
      await backupDatabase(db, backup);
      expect(() => restoreDatabase(backup, join(root, 'live', 'agent.db'))).toThrow(
        new RegExp(`schema version ${String(newer)} is newer`),
      );
    });
  });

  describe('schema helpers', () => {
    it('assertSchemaNotNewer passes a current and a virgin database', () => {
      const root = tempDir();
      expect(() => assertSchemaNotNewer(migrated(join(root, 'a.db')))).not.toThrow();
      const virgin = openDatabase(join(root, 'b.db'));
      handles.push(virgin);
      expect(() => assertSchemaNotNewer(virgin)).not.toThrow();
    });

    it('pendingMigrationIds lists every migration on a virgin database and none after', () => {
      const root = tempDir();
      const virgin = openDatabase(join(root, 'a.db'));
      handles.push(virgin);
      expect(pendingMigrationIds(virgin)).toEqual(migrations.map((m) => m.id));
      runMigrations(virgin);
      expect(pendingMigrationIds(virgin)).toEqual([]);
    });
  });

  describe('prepareSchema', () => {
    it('migrates a fresh database without a backup', async () => {
      const root = tempDir();
      const db = openDatabase(join(root, 'agent.db'));
      handles.push(db);
      const backupsDir = join(root, 'backups');
      const result = await prepareSchema(db, backupsDir, { now: () => NOW });
      expect(result.appliedIds).toEqual(migrations.map((m) => m.id));
      expect(existsSync(backupsDir)).toBe(false);
    });

    it('backs up an existing database before applying pending migrations', async () => {
      const root = tempDir();
      const older = migrations.slice(0, 3);
      const db = migrated(join(root, 'agent.db'), older);
      const backupsDir = join(root, 'backups');
      const from = currentSchemaVersion(db);

      const result = await prepareSchema(db, backupsDir, { now: () => NOW });

      expect(result.appliedIds).toEqual(migrations.slice(3).map((m) => m.id));
      const name = `agenthropic-2026-11-08T10-20-30-400Z-pre-migration-v${String(from)}.db`;
      expect(readdirSync(backupsDir)).toEqual([name]);
      expect(BACKUP_FILE_PATTERN.test(name)).toBe(true);
      const copy = openDatabase(join(backupsDir, name));
      handles.push(copy);
      expect(currentSchemaVersion(copy)).toBe(from);
    });

    it('takes no backup when nothing is pending', async () => {
      const root = tempDir();
      const db = migrated(join(root, 'agent.db'));
      const result = await prepareSchema(db, join(root, 'backups'));
      expect(result.appliedIds).toEqual([]);
      expect(existsSync(join(root, 'backups'))).toBe(false);
    });

    it('refuses to migrate when the pre-migration backup fails', async () => {
      const root = tempDir();
      const db = migrated(join(root, 'agent.db'), migrations.slice(0, 3));
      const from = currentSchemaVersion(db);
      vi.spyOn(db, 'backup').mockRejectedValue(new Error('disk full'));
      await expect(prepareSchema(db, join(root, 'backups'))).rejects.toThrow(/disk full/);
      expect(currentSchemaVersion(db)).toBe(from);
    });
  });

  it('start() refuses a database written by a newer build and closes it', async () => {
    const root = tempDir();
    const dbPath = join(root, 'agent.db');
    const db = migrated(dbPath);
    stampNewerSchema(db);
    db.close();

    await expect(
      start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: dbPath,
        DASHBOARD_INGEST: '0',
      }),
    ).rejects.toThrow(/newer than this build knows/);
    // The handle was closed: the WAL was checkpointed away on close.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });
});
