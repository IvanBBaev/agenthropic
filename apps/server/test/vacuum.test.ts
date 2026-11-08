/**
 * R19 vacuum policy as an operator command (src/db/vacuum.ts): it refuses a
 * missing database and a running server, keeps a verified pre-vacuum backup
 * outside the retention pattern, gives the free pages back to the disk and
 * truncates the WAL.
 */
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import {
  formatVacuumReport,
  isServerAnswering,
  runVacuum,
  type VacuumReport,
} from '../src/db/vacuum';
import { BACKUP_FILE_PATTERN } from '../src/retention/backup-files';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const notRunning = (): Promise<boolean> => Promise.resolve(false);

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A migrated database that grew, then had most of its rows deleted. */
function bloatedDatabase(): string {
  dir = mkdtempSync(join(tmpdir(), 'agenthropic-vacuum-'));
  const dbPath = join(dir, 'data', 'agenthropic.db');
  const db = openDatabase(dbPath);
  runMigrations(db);
  db.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO filler (body) VALUES (?)');
  db.transaction(() => {
    for (let i = 0; i < 2000; i += 1) {
      insert.run('x'.repeat(1000));
    }
  })();
  db.exec('DELETE FROM filler WHERE id > 10');
  db.close();
  return dbPath;
}

describe('runVacuum', () => {
  it('backs up, vacuums and truncates the WAL, reporting the space it gave back', async () => {
    const dbPath = bloatedDatabase();
    const backupsDir = join(dir, 'data', 'backups');

    const report = await runVacuum({ dbPath, backupsDir, isServerRunning: notRunning, now: NOW });

    expect(report.before.freePages).toBeGreaterThan(0);
    expect(report.after.freePages).toBe(0);
    expect(report.after.fileBytes).toBeLessThan(report.before.fileBytes);
    expect(report.after.pageSize).toBe(report.before.pageSize);
    expect(report.vacuumMs).toBeGreaterThanOrEqual(0);
    // Checkpointed and closed: the last connection out removes the -wal file.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);

    // The kept backup: named for the vacuum, outside the retention pattern,
    // private, and holding the pre-vacuum rows.
    expect(report.backupPath).toBe(join(backupsDir, 'pre-vacuum-2026-11-08T12-00-00-000Z.db'));
    expect(readdirSync(backupsDir)).toEqual(['pre-vacuum-2026-11-08T12-00-00-000Z.db']);
    expect(BACKUP_FILE_PATTERN.test('pre-vacuum-2026-11-08T12-00-00-000Z.db')).toBe(false);
    expect(statSync(report.backupPath).mode & 0o777).toBe(0o600);
    const live = openDatabase(dbPath);
    try {
      expect(live.prepare('SELECT count(*) AS n FROM filler').get()).toEqual({ n: 10 });
    } finally {
      live.close();
    }
  });

  it('defaults the backup timestamp to the wall clock', async () => {
    const dbPath = bloatedDatabase();
    const report = await runVacuum({
      dbPath,
      backupsDir: join(dir, 'backups'),
      isServerRunning: notRunning,
    });
    expect(report.backupPath).toMatch(/pre-vacuum-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/);
  });

  it('refuses a missing database and never creates one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-vacuum-'));
    const dbPath = join(dir, 'nope.db');
    await expect(
      runVacuum({ dbPath, backupsDir: join(dir, 'backups'), isServerRunning: notRunning }),
    ).rejects.toThrow(/No database at .*nope\.db/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('refuses while a server answers, and touches nothing', async () => {
    const dbPath = bloatedDatabase();
    const backupsDir = join(dir, 'backups');
    const before = statSync(dbPath).size;
    await expect(
      runVacuum({ dbPath, backupsDir, isServerRunning: () => Promise.resolve(true) }),
    ).rejects.toThrow(/server is answering on the configured port\. Stop it first/);
    expect(existsSync(backupsDir)).toBe(false);
    expect(statSync(dbPath).size).toBe(before);
  });
});

describe('formatVacuumReport', () => {
  it('prints the sizes in MiB and ends with the kept backup', () => {
    const report: VacuumReport = {
      backupPath: '/b/pre-vacuum.db',
      before: { fileBytes: 10 * 1024 * 1024, freePages: 1024, pageSize: 4096 },
      after: { fileBytes: 6 * 1024 * 1024, freePages: 0, pageSize: 4096 },
      vacuumMs: 1234.4,
    };
    expect(formatVacuumReport('/d/agenthropic.db', report)).toEqual([
      'database: /d/agenthropic.db',
      'before: 10.0 MiB (4.0 MiB free pages)',
      'after:  6.0 MiB (0.0 MiB free pages)',
      'vacuum + checkpoint: 1234 ms',
      'vacuum OK: /b/pre-vacuum.db',
    ]);
  });
});

describe('isServerAnswering', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
      } else {
        server.close(() => {
          resolve();
        });
      }
    });
    server = undefined;
  });

  it('is true for any HTTP answer, a 401 included', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-vacuum-'));
    const paths: string[] = [];
    server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(401).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    expect(await isServerAnswering(port)).toBe(true);
    expect(paths).toEqual(['/api/health']);
  });

  it('is false when the connection fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-vacuum-'));
    const refused: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await isServerAnswering(7341, refused)).toBe(false);
  });
});
