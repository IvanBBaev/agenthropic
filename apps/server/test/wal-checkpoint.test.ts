/**
 * R19 - the daily cycle ends with `wal_checkpoint(TRUNCATE)`, whatever the
 * backup did. Autocheckpoint folds the WAL back into the database but never
 * shrinks the -wal file; the end-of-cycle checkpoint does. It is quiet when it
 * succeeds, says so when a reader kept it from finishing, and never throws
 * into the timer.
 */
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointWal, scheduleDailyBackups } from '../src/index';
import { NO_RETENTION } from '../src/retention/policy';
import { createRetentionRunner } from '../src/retention/runner';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function tempDb(): TempDb {
  const temp = createMigratedTempDb();
  cleanups.push(() => {
    temp.cleanup();
  });
  return temp;
}

function walBytes(temp: TempDb): number {
  return statSync(`${temp.path}-wal`).size;
}

describe('checkpointWal', () => {
  it('folds the WAL in and truncates the -wal file to zero bytes', () => {
    const temp = tempDb();
    insertSession(temp.db, 's1');
    expect(walBytes(temp)).toBeGreaterThan(0);

    expect(checkpointWal(temp.db)).toEqual({ busy: false });
    expect(walBytes(temp)).toBe(0);
  });

  it('reports busy when another connection holds a read snapshot', () => {
    const temp = tempDb();
    // No waiting on the busy handler: the reader below never lets go in time.
    temp.db.pragma('busy_timeout = 0');
    const reader = new Database(temp.path, { readonly: true });
    cleanups.unshift(() => {
      reader.close();
    });
    insertSession(temp.db, 's1');
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM sessions').get();
    insertSession(temp.db, 's2');

    expect(checkpointWal(temp.db)).toEqual({ busy: true });
    reader.exec('COMMIT');
    expect(checkpointWal(temp.db)).toEqual({ busy: false });
  });
});

describe('scheduleDailyBackups end-of-cycle checkpoint (R19)', () => {
  function schedule(
    temp: TempDb,
    options: Parameters<typeof scheduleDailyBackups>[3],
  ): ReturnType<typeof scheduleDailyBackups> {
    const scheduler = scheduleDailyBackups(
      temp.db,
      join(temp.dir, 'backups'),
      createRetentionRunner(temp.db, NO_RETENTION),
      { intervalMs: 60_000, ...options },
    );
    cleanups.unshift(() => {
      scheduler.stop();
    });
    return scheduler;
  }

  it('a successful cycle truncates the WAL and logs nothing extra', async () => {
    const temp = tempDb();
    insertSession(temp.db, 's1');
    const lines: string[] = [];
    const errors: string[] = [];
    const scheduler = schedule(temp, {
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
    });

    await scheduler.runOnce();

    expect(walBytes(temp)).toBe(0);
    expect(lines).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('runs even when the backup failed', async () => {
    const temp = tempDb();
    let checkpoints = 0;
    const errors: string[] = [];
    const scheduler = schedule(temp, {
      backup: () => Promise.reject(new Error('disk full')),
      checkpoint: () => {
        checkpoints += 1;
        return { busy: false };
      },
      log: () => undefined,
      logError: (line) => errors.push(line),
    });

    await scheduler.runOnce();

    expect(checkpoints).toBe(1);
    expect(errors).toEqual(['database backup failed: disk full']);
  });

  it('a busy checkpoint is logged and retried next cycle', async () => {
    const temp = tempDb();
    const lines: string[] = [];
    const scheduler = schedule(temp, {
      checkpoint: () => ({ busy: true }),
      log: (line) => lines.push(line),
    });

    await scheduler.runOnce();

    expect(lines.at(-1)).toBe('wal checkpoint: busy (a reader held the WAL); retrying next cycle.');
  });

  it('a throwing checkpoint is logged, never thrown into the timer', async () => {
    const temp = tempDb();
    const errors: string[] = [];
    let thrown: unknown = new Error('database is locked');
    const scheduler = schedule(temp, {
      checkpoint: () => {
        throw thrown;
      },
      log: () => undefined,
      logError: (line) => errors.push(line),
    });

    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    thrown = 'io error';
    await expect(scheduler.runOnce()).resolves.toBeUndefined();

    expect(errors).toEqual([
      'wal checkpoint failed: database is locked',
      'wal checkpoint failed: io error',
    ]);
  });
});
