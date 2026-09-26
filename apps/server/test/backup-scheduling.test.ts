/**
 * Review M-20 - backups must RUN, not merely exist as a tested capability -
 * and L9 - the signed retention policy (D3, 2026-09-08) runs on the same
 * timer, strictly after a successful backup. scheduleDailyBackups is the
 * schedule the composition root wires: a daily online backup into
 * `<db dir>/backups/`, the retention pass right after each successful write
 * (rows by age, backup files by age behind a keep-minimum floor), one log
 * line per step, and a timer that never keeps a closed server's process
 * alive. The unit half drives the scheduler directly; the integration half
 * proves start() actually schedules it, reports the policy at boot without
 * pruning, and that close() actually stops it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_INTERVAL_MS,
  DEFAULT_RETENTION_BACKUP_DAYS,
  DEFAULT_RETENTION_BACKUP_KEEP_MIN,
  DEFAULT_RETENTION_EVENTS_DAYS,
  reportRetentionAtBoot,
  scheduleDailyBackups,
  start,
} from '../src/index';
import { defaultJournalPath, readJournalEntries } from '../src/retention/journal';
import { NO_RETENTION, signedRetentionPolicy } from '../src/retention/policy';
import type { RetentionPort } from '../src/retention/port';
import { createRetentionRunner, RetentionRunError } from '../src/retention/runner';
import {
  countRows,
  createMigratedTempDb,
  insertAgent,
  insertProjectionEvent,
  insertSession,
  insertTokenUsage,
  TEST_TOKEN,
  type TempDb,
} from './helpers';

const DATED_BACKUP = /^agenthropic-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;
const NOW = new Date('2026-09-10T12:00:00.000Z');
/** Comfortably outside the signed 90-day events window. */
const OLD = '2026-01-15T00:00:00.000Z';
/** Comfortably inside it. */
const RECENT = '2026-09-01T00:00:00.000Z';

/** The signed D3 numbers as `start()` would read them, over `directory`. */
function signedPort(temp: TempDb, directory: string): RetentionPort {
  return createRetentionRunner(
    temp.db,
    signedRetentionPolicy(
      {
        eventsDays: DEFAULT_RETENTION_EVENTS_DAYS,
        backupDays: DEFAULT_RETENTION_BACKUP_DAYS,
        backupKeepMinimum: DEFAULT_RETENTION_BACKUP_KEEP_MIN,
      },
      directory,
    ),
  );
}

function seedOldAndRecentRows(temp: TempDb): void {
  insertSession(temp.db, 's1');
  insertAgent(temp.db, 'a1', 's1');
  insertProjectionEvent(temp.db, 'old-1', OLD);
  insertProjectionEvent(temp.db, 'old-2', OLD);
  insertProjectionEvent(temp.db, 'recent-1', RECENT);
  insertTokenUsage(temp.db, 'usage-old', OLD);
  insertTokenUsage(temp.db, 'usage-recent', RECENT);
}

describe('scheduleDailyBackups (review M-20 + L9 retention wiring)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  function noRetention(temp: TempDb): RetentionPort {
    return createRetentionRunner(temp.db, NO_RETENTION);
  }

  it('runOnce writes a dated backup file the retention pattern recognizes', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const lines: string[] = [];
    const scheduler = scheduleDailyBackups(temp.db, directory, noRetention(temp), {
      intervalMs: 60_000,
      log: (line) => lines.push(line),
    });
    try {
      await scheduler.runOnce();
    } finally {
      scheduler.stop();
    }

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    // The dated stem is colon/dot-free, so the name is portable and matches
    // BACKUP_FILE_PATTERN - the expiry pass must recognize its own output.
    expect(files[0]).toMatch(DATED_BACKUP);
    expect(statSync(join(directory, files[0]!)).size).toBeGreaterThan(0);
    // One line for the backup, one for the retention pass - even a no-op one.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^database backup: wrote .*\.db\.$/);
    expect(lines[1]).toBe('retention: no rule configured, nothing to prune.');
  });

  it('the interval fires runs and stop() halts the schedule', async () => {
    // clearInterval must be faked alongside setInterval: the real one cannot
    // clear a fake timer, and stop()'s whole contract is that it clears.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const written: string[] = [];
    const scheduler = scheduleDailyBackups(temp.db, directory, noRetention(temp), {
      intervalMs: 1000,
      backup: (_db, destPath) => {
        written.push(destPath);
        return Promise.resolve();
      },
      log: () => undefined,
    });

    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => {
      expect(written).toHaveLength(1);
    });
    expect(written[0]).toContain(directory);

    scheduler.stop();
    vi.advanceTimersByTime(3000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(written).toHaveLength(1);
  });

  it('overlapping runs are refused: never two writers into the directory', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const scheduler = scheduleDailyBackups(temp.db, directory, noRetention(temp), {
      intervalMs: 60_000,
      backup: () => {
        calls += 1;
        return gate;
      },
      log: () => undefined,
    });
    try {
      const first = scheduler.runOnce();
      const second = scheduler.runOnce(); // in-flight: must be a no-op
      release();
      await first;
      await second;
      expect(calls).toBe(1);

      // The guard resets once the run settles - the schedule is not poisoned.
      await scheduler.runOnce();
      expect(calls).toBe(2);
    } finally {
      scheduler.stop();
    }
  });

  it('a failed backup logs, runs NO retention that cycle, and the next run still happens', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const lines: string[] = [];
    const errors: string[] = [];
    const retentionRuns: Date[] = [];
    const port: RetentionPort = {
      policy: NO_RETENTION,
      run: (options) => {
        retentionRuns.push(options?.now ?? new Date(0));
        return { ranAt: '', dryRun: false, configured: false, database: null, backups: null };
      },
    };
    let fail = true;
    const cycle = new Date('2026-09-10T03:00:00.000Z');
    const scheduler = scheduleDailyBackups(temp.db, directory, port, {
      intervalMs: 60_000,
      now: () => cycle,
      backup: () => (fail ? Promise.reject(new Error('disk full')) : Promise.resolve()),
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
    });
    try {
      await scheduler.runOnce();
      expect(errors).toEqual(['database backup failed: disk full']);
      expect(lines).toHaveLength(0);
      // The contract: a cycle whose backup failed deletes nothing at all.
      expect(retentionRuns).toHaveLength(0);

      fail = false;
      await scheduler.runOnce();
      expect(lines).toHaveLength(2);
      // The retention pass runs at the cycle's own clock, after the backup.
      expect(retentionRuns).toEqual([cycle]);
    } finally {
      scheduler.stop();
    }
  });

  it('a non-Error rejection is stringified, never rethrown', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const errors: string[] = [];
    const scheduler = scheduleDailyBackups(temp.db, directory, noRetention(temp), {
      intervalMs: 60_000,
      backup: () => Promise.reject('unplugged'),
      log: () => undefined,
      logError: (line) => errors.push(line),
    });
    try {
      await expect(scheduler.runOnce()).resolves.toBeUndefined();
      expect(errors).toEqual(['database backup failed: unplugged']);
    } finally {
      scheduler.stop();
    }
  });

  it('a throwing retention runner is logged and never crashes the timer', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const lines: string[] = [];
    const errors: string[] = [];
    let failure: unknown = new Error('journal unwritable');
    const port: RetentionPort = {
      policy: NO_RETENTION,
      run: () => {
        throw failure;
      },
    };
    const scheduler = scheduleDailyBackups(temp.db, directory, port, {
      intervalMs: 60_000,
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
    });
    try {
      await expect(scheduler.runOnce()).resolves.toBeUndefined();
      // The backup of that cycle still happened and was reported.
      expect(readdirSync(directory)).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('database backup: wrote');
      expect(errors).toEqual(['retention failed: journal unwritable']);

      // A non-Error throw is stringified too, and the schedule is not poisoned.
      failure = 'boom';
      await expect(scheduler.runOnce()).resolves.toBeUndefined();
      expect(errors).toEqual(['retention failed: journal unwritable', 'retention failed: boom']);
      expect(readdirSync(directory)).toHaveLength(2);
    } finally {
      scheduler.stop();
    }
  });

  it('a part-way retention failure logs the partial record, not only the error', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const lines: string[] = [];
    const errors: string[] = [];
    const port: RetentionPort = {
      policy: NO_RETENTION,
      run: ({ now } = {}) => {
        throw new RetentionRunError(
          {
            ranAt: (now ?? NOW).toISOString(),
            dryRun: false,
            configured: true,
            database: null,
            backups: {
              directory,
              directoryPresent: true,
              dryRun: false,
              cutoff: '2026-08-11T12:00:00.000Z',
              found: [],
              deleted: [
                {
                  name: 'agenthropic-old-a.db',
                  path: join(directory, 'agenthropic-old-a.db'),
                  modifiedAt: '2026-01-01T00:00:00.000Z',
                  sizeBytes: 12,
                },
              ],
              keptByMinimum: [],
              bytesReclaimed: 12,
            },
          },
          new Error('backup prune stopped at agenthropic-old-b.db (EACCES)'),
        );
      },
    };
    const scheduler = scheduleDailyBackups(temp.db, directory, port, {
      intervalMs: 60_000,
      now: () => NOW,
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
    });
    try {
      await scheduler.runOnce();
      expect(errors).toEqual([
        'retention failed: backup prune stopped at agenthropic-old-b.db (EACCES)',
        'retention failed part-way; completed before the failure - retention: backup files: ' +
          'expired 1 older than 2026-08-11T12:00:00.000Z (0 kept by the floor).',
      ]);
    } finally {
      scheduler.stop();
    }
  });

  it('expiry keeps the newest keepMinimum backups no matter how old', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    mkdirSync(directory, { recursive: true });
    // Six stale backups, 30 days old, with distinct mtimes so "newest" is
    // well-defined: old-5 is the newest of the stale set.
    const staleBase = Date.now() - 30 * 86_400_000;
    for (let i = 0; i < 6; i += 1) {
      const path = join(directory, `agenthropic-old-${String(i)}.db`);
      writeFileSync(path, 'stale');
      const at = new Date(staleBase + i * 60_000);
      utimesSync(path, at, at);
    }

    const lines: string[] = [];
    const port = createRetentionRunner(
      temp.db,
      signedRetentionPolicy({ eventsDays: 0, backupDays: 14, backupKeepMinimum: 3 }, directory),
    );
    const scheduler = scheduleDailyBackups(temp.db, directory, port, {
      intervalMs: 60_000,
      now: () => new Date(),
      log: (line) => lines.push(line),
    });
    try {
      await scheduler.runOnce();
    } finally {
      scheduler.stop();
    }

    // Newest-first: the fresh backup (kept by age), then old-5 and old-4
    // (expired but inside the floor). The remaining four are deleted.
    const files = readdirSync(directory).sort();
    expect(files).toHaveLength(3);
    expect(files).toContain('agenthropic-old-4.db');
    expect(files).toContain('agenthropic-old-5.db');
    expect(files.some((name) => DATED_BACKUP.test(name))).toBe(true);
    expect(lines[1]).toContain('backup files: expired 4 older than');
    expect(lines[1]).toContain('(2 kept by the floor)');
  });

  it('the signed policy prunes expired events rows, journals them, and never touches token_usage', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    seedOldAndRecentRows(temp);
    const lines: string[] = [];
    const scheduler = scheduleDailyBackups(temp.db, directory, signedPort(temp, directory), {
      intervalMs: 60_000,
      now: () => NOW,
      log: (line) => lines.push(line),
    });
    try {
      await scheduler.runOnce();
    } finally {
      scheduler.stop();
    }

    // The two old events rows are gone, the recent one stays.
    expect(countRows(temp.db, 'events')).toBe(1);
    // token_usage is never in a window: both rows survive, old and recent.
    expect(countRows(temp.db, 'token_usage')).toBe(2);
    // The substrate is untouched.
    expect(countRows(temp.db, 'events_raw')).toBe(3);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(
      'retention: events: pruned 2 row(s) older than 2026-06-12T12:00:00.000Z',
    );
    // The receipt is written beside the database, through the existing journal.
    const journal = defaultJournalPath(temp.path);
    expect(lines[1]).toContain(`receipt ${journal}`);
    expect(existsSync(journal)).toBe(true);
    const entries = readJournalEntries(journal);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ranAt: NOW.toISOString(),
      policy: { events: { maxAgeDays: DEFAULT_RETENTION_EVENTS_DAYS }, tokenUsage: null },
    });

    // A second cycle finds nothing to prune and writes no second receipt.
    await scheduler.runOnce();
    expect(lines[3]).toContain('retention: events: pruned 0 row(s)');
    expect(lines[3]).not.toContain('receipt');
    expect(readJournalEntries(journal)).toHaveLength(1);
  });
});

describe('reportRetentionAtBoot (L9)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('logs the policy and what it WOULD prune, and prunes nothing', () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    seedOldAndRecentRows(temp);
    const lines: string[] = [];
    const errors: string[] = [];
    reportRetentionAtBoot(signedPort(temp, directory), {
      now: () => NOW,
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
    });

    expect(errors).toEqual([]);
    expect(lines).toEqual([
      'retention policy: events: prune after 90 day(s); token_usage: never pruned; ' +
        'backup files: expire after 30 day(s), always keeping the newest 7. ' +
        'retention dry run (nothing deleted): ' +
        'events: would prune 2 row(s) older than 2026-06-12T12:00:00.000Z; ' +
        `backup files: directory ${directory} absent, nothing to expire.`,
    ]);
    // Boot never prunes: every row is still there and no receipt was written.
    expect(countRows(temp.db, 'events')).toBe(3);
    expect(countRows(temp.db, 'token_usage')).toBe(2);
    expect(existsSync(defaultJournalPath(temp.path))).toBe(false);
  });

  it('defaults to the console and the wall clock', () => {
    const temp = tempDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reportRetentionAtBoot(createRetentionRunner(temp.db, NO_RETENTION));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'retention policy: events: keep forever; token_usage: never pruned; backup files: keep forever. ' +
        'retention dry run (nothing deleted): no rule configured, nothing to prune.',
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('a failing assessment is logged as an error and never thrown', () => {
    const errors: string[] = [];
    let failure: unknown = new Error('database is locked');
    const port: RetentionPort = {
      policy: NO_RETENTION,
      run: () => {
        throw failure;
      },
    };
    expect(() => {
      reportRetentionAtBoot(port, { log: () => undefined, logError: (line) => errors.push(line) });
    }).not.toThrow();
    failure = 'unplugged';
    reportRetentionAtBoot(port, { log: () => undefined, logError: (line) => errors.push(line) });
    expect(errors).toEqual([
      'retention dry run failed: database is locked',
      'retention dry run failed: unplugged',
    ]);
  });
});

describe('backup scheduling through start() (review M-20 + L9)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start() reports retention at boot without pruning, prunes after the first backup, and close() stops it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-backup-sched-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Interval timers are faked (creation AND clearing - the real
    // clearInterval cannot clear a fake timer, and close() must clear);
    // start() still listens over the real event loop, and the daily timer is
    // then driven by hand.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const dbPath = join(dir, 'data', 'agent.db');
      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: dbPath,
        DASHBOARD_INGEST: '0',
      });
      const backupsDir = join(dir, 'data', 'backups');
      try {
        // The boot line: the signed defaults, as a dry run over an empty database.
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(
            'retention policy: events: prune after 90 day(s); token_usage: never pruned; ' +
              'backup files: expire after 30 day(s), always keeping the newest 7. ' +
              'retention dry run (nothing deleted): events: would prune 0 row(s)',
          ),
        );
        expect(existsSync(defaultJournalPath(dbPath))).toBe(false);

        // Rows older than the window, written after boot: nothing has pruned
        // them yet - the first real pass is the first daily cycle.
        insertSession(server.db, 's1');
        insertAgent(server.db, 'a1', 's1');
        insertProjectionEvent(server.db, 'old-1', OLD);
        insertProjectionEvent(server.db, 'recent-1', RECENT);
        insertTokenUsage(server.db, 'usage-old', OLD);

        vi.advanceTimersByTime(BACKUP_INTERVAL_MS);
        // The online backup pages over the REAL event loop; the retention line
        // is the run's final step, so waiting on it means the run is complete.
        await vi.waitFor(() => {
          expect(log).toHaveBeenCalledWith(expect.stringContaining('database backup: wrote'));
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining('retention: events: pruned 1 row(s) older than'),
          );
        });
        const files = readdirSync(backupsDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(DATED_BACKUP);
        expect(countRows(server.db, 'events')).toBe(1);
        expect(countRows(server.db, 'token_usage')).toBe(1);
        expect(readJournalEntries(defaultJournalPath(dbPath))).toHaveLength(1);
        expect(error).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }

      // close() cleared the timer: another day passes, no second backup.
      vi.advanceTimersByTime(BACKUP_INTERVAL_MS);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(readdirSync(backupsDir)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('DASHBOARD_RETENTION_*_DAYS=0 switches the pass off end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-backup-sched-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: join(dir, 'data', 'agent.db'),
        DASHBOARD_INGEST: '0',
        DASHBOARD_RETENTION_EVENTS_DAYS: '0',
        DASHBOARD_RETENTION_BACKUP_DAYS: '0',
      });
      try {
        expect(log).toHaveBeenCalledWith(
          'retention policy: events: keep forever; token_usage: never pruned; backup files: keep forever. ' +
            'retention dry run (nothing deleted): no rule configured, nothing to prune.',
        );
        vi.advanceTimersByTime(BACKUP_INTERVAL_MS);
        await vi.waitFor(() => {
          expect(log).toHaveBeenCalledWith('retention: no rule configured, nothing to prune.');
        });
      } finally {
        await server.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
