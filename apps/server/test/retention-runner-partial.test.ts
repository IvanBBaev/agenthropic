/**
 * A retention pass whose backup-file step fails part-way must not lose the
 * record of what it already deleted: the rows the row prune removed in the
 * same pass, and the backup files unlinked before the failing one. The runner
 * wraps the failure in a RetentionRunError that carries that partial report.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fail the unlink of one chosen file; every other call goes to the real fs.
const failing = vi.hoisted(() => ({ name: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync: (path: realFs.PathLike): void => {
      if (failing.name !== '' && String(path).endsWith(failing.name)) {
        throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(path)}'`), {
          code: 'EACCES',
        });
      }
      actual.unlinkSync(path);
    },
  };
});

const { BackupPruneError } = await import('../src/retention/backup-files');
const { NO_RETENTION } = await import('../src/retention/policy');
const { createRetentionRunner, RetentionRunError } = await import('../src/retention/runner');
const { createMigratedTempDb, insertSession } = await import('./helpers');
type TempDb = import('./helpers').TempDb;
type RetentionPolicy = import('../src/retention/policy').RetentionPolicy;

const NOW = new Date('2026-08-07T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';

describe('retention runner: a backup-file failure keeps the partial record', () => {
  let temp: TempDb;
  let backupDir: string;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, 's1');
    backupDir = mkdtempSync(join(tmpdir(), 'agenthropic-runner-partial-'));
    failing.name = '';
  });

  afterEach(() => {
    temp.cleanup();
    rmSync(backupDir, { recursive: true, force: true });
  });

  function writeBackup(name: string, ageDays: number): void {
    const path = join(backupDir, name);
    writeFileSync(path, 'backup-bytes', 'utf8');
    const when = new Date(NOW.getTime() - ageDays * 86_400_000);
    utimesSync(path, when, when);
  }

  function insertEvent(key: string): void {
    const raw = temp.db
      .prepare(
        `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
         VALUES (?, 'hook', 'PreToolUse', '{}', ?)`,
      )
      .run(key, OLD);
    temp.db
      .prepare(
        `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
         VALUES (?, 's1', NULL, 'PreToolUse', ?)`,
      )
      .run(raw.lastInsertRowid, OLD);
  }

  function policy(directory: string): RetentionPolicy {
    return {
      ...NO_RETENTION,
      events: { maxAgeDays: 30 },
      backupFiles: { directory, maxAgeDays: 14, keepMinimum: 1 },
    };
  }

  function runAndCatch(directory: string): unknown {
    try {
      createRetentionRunner(temp.db, policy(directory)).run({ now: NOW });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('carries the applied row prune and the files already unlinked', () => {
    insertEvent('k-old');
    writeBackup('agenthropic-keep.db', 1);
    writeBackup('agenthropic-old-a.db', 100);
    writeBackup('agenthropic-old-b.db', 200);
    failing.name = 'agenthropic-old-b.db';

    const caught = runAndCatch(backupDir);

    expect(caught).toBeInstanceOf(RetentionRunError);
    const error = caught as InstanceType<typeof RetentionRunError>;
    // The message is the underlying one, so the existing log line keeps its wording.
    expect(error.message).toContain('backup prune stopped at agenthropic-old-b.db');
    expect(error.cause).toBeInstanceOf(BackupPruneError);
    expect(error.report.configured).toBe(true);
    expect(error.report.dryRun).toBe(false);
    expect(error.report.ranAt).toBe(NOW.toISOString());
    expect(error.report.database?.applied).toBe(true);
    expect(error.report.database?.tables[0]?.rowsDeleted).toBe(1);
    expect(error.report.backups?.deleted.map((c) => c.name)).toEqual(['agenthropic-old-a.db']);
  });

  it('a backup step that fails before deleting anything still keeps the row prune', () => {
    insertEvent('k-old');
    // A FILE where the directory should be: existsSync passes, readdirSync throws.
    const notADirectory = join(backupDir, 'not-a-directory');
    writeFileSync(notADirectory, 'x', 'utf8');

    const caught = runAndCatch(notADirectory);

    expect(caught).toBeInstanceOf(RetentionRunError);
    const error = caught as InstanceType<typeof RetentionRunError>;
    expect(error.message).toContain('ENOTDIR');
    expect(error.report.database?.tables[0]?.rowsDeleted).toBe(1);
    // No backup report was produced, so none is claimed.
    expect(error.report.backups).toBeNull();
  });

  it('stringifies a non-Error failure without losing it', () => {
    const error = new RetentionRunError(
      { ranAt: NOW.toISOString(), dryRun: false, configured: true, database: null, backups: null },
      'raw-failure',
    );
    expect(error.message).toBe('raw-failure');
    expect(error.name).toBe('RetentionRunError');
    expect(error.cause).toBe('raw-failure');
  });
});
