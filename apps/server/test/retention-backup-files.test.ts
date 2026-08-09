import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_FILE_PATTERN, pruneBackupFiles } from '../src/retention/backup-files';
import type { BackupFileRule } from '../src/retention/policy';

const NOW = new Date('2026-08-07T00:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

describe('backup-file retention (WP-D10 mechanism; day counts await OPEN-1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-backups-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBackup(name: string, ageDays: number, contents = 'backup-bytes'): string {
    const path = join(dir, name);
    writeFileSync(path, contents, 'utf8');
    const when = daysAgo(ageDays);
    utimesSync(path, when, when);
    return path;
  }

  function rule(overrides: Partial<BackupFileRule> = {}): BackupFileRule {
    return { directory: dir, maxAgeDays: 14, keepMinimum: 1, ...overrides };
  }

  it('reports a missing directory instead of throwing or creating it', () => {
    const missing = join(dir, 'not-there');
    const report = pruneBackupFiles(rule({ directory: missing }), { now: NOW });

    expect(report.directoryPresent).toBe(false);
    expect(report.deleted).toEqual([]);
    expect(report.found).toEqual([]);
    expect(report.bytesReclaimed).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });

  it('deletes only expired backups', () => {
    writeBackup('agenthropic-2026-01-01.db', 200);
    writeBackup('agenthropic-2026-08-06.db', 1);

    const report = pruneBackupFiles(rule({ keepMinimum: 1 }), { now: NOW });

    expect(report.deleted.map((f) => f.name)).toEqual(['agenthropic-2026-01-01.db']);
    expect(readdirSync(dir)).toEqual(['agenthropic-2026-08-06.db']);
    expect(report.bytesReclaimed).toBe('backup-bytes'.length);
  });

  it('never leaves zero backups: the newest keepMinimum always survive', () => {
    writeBackup('agenthropic-2026-01-01.db', 300);
    writeBackup('agenthropic-2026-02-01.db', 200);
    writeBackup('agenthropic-2026-03-01.db', 100);

    const report = pruneBackupFiles(rule({ maxAgeDays: 1, keepMinimum: 2 }), { now: NOW });

    expect(report.keptByMinimum.map((f) => f.name)).toEqual([
      'agenthropic-2026-03-01.db',
      'agenthropic-2026-02-01.db',
    ]);
    expect(report.deleted.map((f) => f.name)).toEqual(['agenthropic-2026-01-01.db']);
    expect(readdirSync(dir).sort()).toEqual([
      'agenthropic-2026-02-01.db',
      'agenthropic-2026-03-01.db',
    ]);
  });

  it('ignores everything that is not a backup file, directories included', () => {
    writeBackup('agenthropic-2026-01-01.db', 300);
    writeBackup('agenthropic-2026-01-02.db', 299);
    writeFileSync(join(dir, 'notes.txt'), 'x', 'utf8');
    writeFileSync(join(dir, 'agenthropic.db'), 'x', 'utf8');
    writeFileSync(join(dir, 'agenthropic-2026-01-01.db-wal'), 'x', 'utf8');
    mkdirSync(join(dir, 'agenthropic-nested.db'));
    const old = daysAgo(300);
    for (const name of ['notes.txt', 'agenthropic.db', 'agenthropic-2026-01-01.db-wal']) {
      utimesSync(join(dir, name), old, old);
    }

    const report = pruneBackupFiles(rule({ maxAgeDays: 1, keepMinimum: 1 }), { now: NOW });

    expect(report.found.map((f) => f.name)).toEqual([
      'agenthropic-2026-01-02.db',
      'agenthropic-2026-01-01.db',
    ]);
    expect(report.deleted.map((f) => f.name)).toEqual(['agenthropic-2026-01-01.db']);
    expect(readdirSync(dir).sort()).toEqual([
      'agenthropic-2026-01-01.db-wal',
      'agenthropic-2026-01-02.db',
      'agenthropic-nested.db',
      'agenthropic.db',
      'notes.txt',
    ]);
  });

  it('a dry run lists what would go and removes nothing', () => {
    writeBackup('agenthropic-2026-01-01.db', 300);
    writeBackup('agenthropic-2026-08-06.db', 1);

    const report = pruneBackupFiles(rule({ maxAgeDays: 1, keepMinimum: 1 }), {
      now: NOW,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.deleted.map((f) => f.name)).toEqual(['agenthropic-2026-01-01.db']);
    expect(report.bytesReclaimed).toBe('backup-bytes'.length);
    expect(readdirSync(dir).sort()).toEqual([
      'agenthropic-2026-01-01.db',
      'agenthropic-2026-08-06.db',
    ]);
  });

  it('orders newest first and reports sizes and the cutoff', () => {
    writeBackup('agenthropic-a.db', 3, 'aaa');
    writeBackup('agenthropic-b.db', 1, 'bbbbb');

    const report = pruneBackupFiles(rule({ maxAgeDays: 30 }), { now: NOW });

    expect(report.found.map((f) => f.name)).toEqual(['agenthropic-b.db', 'agenthropic-a.db']);
    expect(report.found[0]?.sizeBytes).toBe(5);
    expect(report.found[0]?.path).toBe(join(dir, 'agenthropic-b.db'));
    expect(report.cutoff).toBe('2026-07-08T00:00:00.000Z');
    expect(report.deleted).toEqual([]);
  });

  it('breaks mtime ties by name so the order is stable', () => {
    writeBackup('agenthropic-b.db', 5);
    writeBackup('agenthropic-a.db', 5);

    const report = pruneBackupFiles(rule({ maxAgeDays: 30 }), { now: NOW });
    expect(report.found.map((f) => f.name)).toEqual(['agenthropic-a.db', 'agenthropic-b.db']);
  });

  it('defaults `now` to the current clock', () => {
    const report = pruneBackupFiles(rule());
    expect(report.dryRun).toBe(false);
    expect(new Date(report.cutoff).getTime()).toBeLessThan(Date.now());
  });

  it('matches only the documented backup naming convention', () => {
    expect(BACKUP_FILE_PATTERN.test('agenthropic-2026-08-07T00-00-00.db')).toBe(true);
    expect(BACKUP_FILE_PATTERN.test('agenthropic-.db')).toBe(false);
    expect(BACKUP_FILE_PATTERN.test('other-2026.db')).toBe(false);
    expect(BACKUP_FILE_PATTERN.test('agenthropic-2026.db.bak')).toBe(false);
  });
});
