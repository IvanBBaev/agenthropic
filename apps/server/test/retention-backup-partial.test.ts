import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fail the unlink of one chosen file; every other call goes to the real fs.
const failing = vi.hoisted(() => ({ name: '', raw: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync: (path: realFs.PathLike): void => {
      if (failing.name !== '' && String(path).endsWith(failing.name)) {
        if (failing.raw) {
          throw 'raw-failure';
        }
        throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(path)}'`), {
          code: 'EACCES',
        });
      }
      actual.unlinkSync(path);
    },
  };
});

const { BackupPruneError, pruneBackupFiles } = await import('../src/retention/backup-files');

const NOW = new Date('2026-08-07T00:00:00.000Z');

describe('backup-file retention: a failure part-way does not lose what was already deleted', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-backups-partial-'));
    failing.name = '';
    failing.raw = false;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBackup(name: string, ageDays: number): void {
    const path = join(dir, name);
    writeFileSync(path, 'backup-bytes', 'utf8');
    const when = new Date(NOW.getTime() - ageDays * 86_400_000);
    utimesSync(path, when, when);
  }

  it('throws an error that carries the partial report and names the deleted files', () => {
    writeBackup('agenthropic-keep.db', 1);
    writeBackup('agenthropic-old-a.db', 100); // newer of the two expired: deleted first
    writeBackup('agenthropic-old-b.db', 200); // unlink fails
    failing.name = 'agenthropic-old-b.db';

    let caught: unknown;
    try {
      pruneBackupFiles({ directory: dir, maxAgeDays: 14, keepMinimum: 1 }, { now: NOW });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupPruneError);
    const error = caught as InstanceType<typeof BackupPruneError>;
    // The file that really went is reported, the one that failed is not.
    expect(error.report.deleted.map((c) => c.name)).toEqual(['agenthropic-old-a.db']);
    expect(error.report.bytesReclaimed).toBe('backup-bytes'.length);
    expect(error.failed.name).toBe('agenthropic-old-b.db');
    expect(error.message).toContain('agenthropic-old-b.db');
    expect(error.message).toContain('EACCES');
    // The only surface the daily timer logs is the message: it must name the loss.
    expect(error.message).toContain('1 already deleted: agenthropic-old-a.db');
    expect(realFs.existsSync(join(dir, 'agenthropic-old-a.db'))).toBe(false);
    expect(realFs.existsSync(join(dir, 'agenthropic-old-b.db'))).toBe(true);
  });

  it('names an empty deletion honestly when the very first unlink fails', () => {
    writeBackup('agenthropic-keep.db', 1);
    writeBackup('agenthropic-old-a.db', 100);
    failing.name = 'agenthropic-old-a.db';

    expect(() =>
      pruneBackupFiles({ directory: dir, maxAgeDays: 14, keepMinimum: 1 }, { now: NOW }),
    ).toThrow(/0 already deleted$/);
  });

  it('wraps a non-Error throw without losing it', () => {
    writeBackup('agenthropic-keep.db', 1);
    writeBackup('agenthropic-old-a.db', 100);
    failing.name = 'agenthropic-old-a.db';
    failing.raw = true;
    expect(() =>
      pruneBackupFiles({ directory: dir, maxAgeDays: 14, keepMinimum: 1 }, { now: NOW }),
    ).toThrow('backup prune stopped at agenthropic-old-a.db (raw-failure); 0 already deleted');
  });

  it('still returns the ordinary report when nothing fails', () => {
    writeBackup('agenthropic-keep.db', 1);
    writeBackup('agenthropic-old-a.db', 100);
    const report = pruneBackupFiles(
      { directory: dir, maxAgeDays: 14, keepMinimum: 1 },
      { now: NOW },
    );
    expect(report.deleted.map((c) => c.name)).toEqual(['agenthropic-old-a.db']);
  });
});
