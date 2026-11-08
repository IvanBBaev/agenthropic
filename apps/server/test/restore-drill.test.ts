/**
 * RELEASE.md §5 drill as code (src/db/restore-drill.ts): it runs the shipped
 * backup and restore against a real database, keeps the backup outside the
 * retention pattern, never writes the live file, and fails loudly on a
 * missing database or a restored copy that differs from the backup.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreDatabase } from '../src/db/backup';
import { openDatabase } from '../src/db/connection';
import { SqliteEventStore } from '../src/db/event-store';
import { migrations, runMigrations } from '../src/db/migrations';
import {
  compareCounts,
  formatDrillReport,
  runRestoreDrill,
  type RestoreDrillReport,
} from '../src/db/restore-drill';
import { BACKUP_FILE_PATTERN } from '../src/retention/backup-files';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const LATEST = migrations.reduce((max, m) => Math.max(max, m.id), 0);

describe('runRestoreDrill', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function liveDatabase(): string {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-drill-'));
    const dbPath = join(dir, 'data', 'agenthropic.db');
    const db = openDatabase(dbPath);
    runMigrations(db);
    const store = new SqliteEventStore(db);
    for (const key of ['k1', 'k2', 'k3']) {
      store.append({
        idempotencyKey: key,
        source: 'hook',
        eventType: 'SessionStart',
        payload: { key },
        receivedAt: '2026-11-08T00:00:00Z',
      });
    }
    db.close();
    return dbPath;
  }

  it('backs up, restores, compares and keeps a private backup retention ignores', async () => {
    const dbPath = liveDatabase();
    const before = readFileSync(dbPath);
    const backupsDir = join(dir, 'data', 'backups');

    const report = await runRestoreDrill({ dbPath, backupsDir, now: NOW });

    expect(report.backupPath).toBe(join(backupsDir, 'drill-2026-11-08T12-00-00-000Z.db'));
    expect(report.schemaVersion).toBe(LATEST);
    expect(report.buildSchemaVersion).toBe(LATEST);
    expect(report.tables.find((t) => t.name === 'events_raw')?.rows).toBe(3);
    expect(report.backupMs).toBeGreaterThanOrEqual(0);
    expect(report.restoreMs).toBeGreaterThanOrEqual(0);
    // Kept, 0600, and outside the pattern backup-file retention prunes.
    expect(statSync(report.backupPath).mode & 0o777).toBe(0o600);
    expect(BACKUP_FILE_PATTERN.test('drill-2026-11-08T12-00-00-000Z.db')).toBe(false);
    // The scratch restore is gone; only the kept backup remains.
    expect(readdirSync(backupsDir)).toEqual(['drill-2026-11-08T12-00-00-000Z.db']);
    // The live database was opened read-only.
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('defaults the timestamp to now', async () => {
    const dbPath = liveDatabase();
    const report = await runRestoreDrill({ dbPath, backupsDir: join(dir, 'b') });
    expect(report.backupPath).toMatch(/drill-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/);
  });

  it('refuses a missing database instead of creating one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-drill-'));
    const dbPath = join(dir, 'nope.db');
    await expect(runRestoreDrill({ dbPath, backupsDir: join(dir, 'b') })).rejects.toThrow(
      `No database at ${dbPath}`,
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  it('fails when the restored copy differs, and still removes the scratch restore', async () => {
    const dbPath = liveDatabase();
    const backupsDir = join(dir, 'data', 'backups');
    await expect(
      runRestoreDrill({
        dbPath,
        backupsDir,
        now: NOW,
        restore: (backupPath, destPath) => {
          const db = restoreDatabase(backupPath, destPath);
          new SqliteEventStore(db).append({
            idempotencyKey: 'k4',
            source: 'hook',
            eventType: 'SessionStart',
            payload: {},
            receivedAt: '2026-11-08T00:00:00Z',
          });
          return db;
        },
      }),
    ).rejects.toThrow('events_raw 3 -> 4 rows');
    expect(readdirSync(backupsDir)).toEqual(['drill-2026-11-08T12-00-00-000Z.db']);
  });
});

describe('compareCounts', () => {
  it('reports missing, changed and unexpected tables, and nothing when equal', () => {
    const a = [
      { name: 'a', rows: 1 },
      { name: 'b', rows: 2 },
    ];
    expect(compareCounts(a, a)).toEqual([]);
    expect(
      compareCounts(a, [
        { name: 'b', rows: 5 },
        { name: 'c', rows: 0 },
      ]),
    ).toEqual(['a missing', 'b 2 -> 5 rows', 'c unexpected']);
  });
});

describe('formatDrillReport', () => {
  const report: RestoreDrillReport = {
    backupPath: '/x/backups/drill-1.db',
    schemaVersion: 7,
    buildSchemaVersion: 27,
    tables: [{ name: 'events_raw', rows: 3 }],
    backupMs: 12.4,
    restoreMs: 30.6,
  };

  it('ends with the OK line and warns about a database behind the build', () => {
    expect(formatDrillReport('/x/agenthropic.db', report)).toEqual([
      'database: /x/agenthropic.db',
      'schema: v7 (this build: v27)',
      'WARNING: the database is behind this build. Is this the database the server runs on? ' +
        'If it is, the next boot migrates it (after its own pre-migration backup).',
      'backup: 12 ms, restore + verify: 31 ms',
      '  events_raw: 3 rows',
      'restore drill OK: /x/backups/drill-1.db',
    ]);
  });

  it('has no warning for a current database', () => {
    const lines = formatDrillReport('/x/a.db', { ...report, schemaVersion: 27 });
    expect(lines.some((l) => l.startsWith('WARNING'))).toBe(false);
  });
});
