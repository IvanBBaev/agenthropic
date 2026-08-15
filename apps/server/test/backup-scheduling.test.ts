/**
 * Review M-20 - backups must RUN, not merely exist as a tested capability.
 * scheduleDailyBackups is the schedule the composition root wires: a daily
 * online backup into `<db dir>/backups/`, an expiry pass right after each
 * write (keep-minimum floored), one log line per run, and a timer that never
 * keeps a closed server's process alive. The unit half drives the scheduler
 * directly; the integration half proves start() actually schedules it and
 * close() actually stops it.
 */
import {
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
import { BACKUP_INTERVAL_MS, scheduleDailyBackups, start } from '../src/index';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const DATED_BACKUP = /^agenthropic-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

describe('scheduleDailyBackups (review M-20)', () => {
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

  it('runOnce writes a dated backup file the retention pattern recognizes', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const lines: string[] = [];
    const scheduler = scheduleDailyBackups(temp.db, directory, {
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
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('database backup: wrote');
    expect(lines[0]).toContain('expired 0 old backup(s)');
  });

  it('the interval fires runs and stop() halts the schedule', async () => {
    // clearInterval must be faked alongside setInterval: the real one cannot
    // clear a fake timer, and stop()'s whole contract is that it clears.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const written: string[] = [];
    const scheduler = scheduleDailyBackups(temp.db, directory, {
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
    const scheduler = scheduleDailyBackups(temp.db, directory, {
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

  it('a failed run logs the message and the next run still happens', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const lines: string[] = [];
    const errors: string[] = [];
    let fail = true;
    const scheduler = scheduleDailyBackups(temp.db, directory, {
      intervalMs: 60_000,
      backup: () => (fail ? Promise.reject(new Error('disk full')) : Promise.resolve()),
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
    });
    try {
      await scheduler.runOnce();
      expect(errors).toEqual(['database backup failed: disk full']);
      expect(lines).toHaveLength(0);

      fail = false;
      await scheduler.runOnce();
      expect(lines).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });

  it('a non-Error rejection is stringified, never rethrown', async () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    const errors: string[] = [];
    const scheduler = scheduleDailyBackups(temp.db, directory, {
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
    const scheduler = scheduleDailyBackups(temp.db, directory, {
      intervalMs: 60_000,
      maxAgeDays: 14,
      keepMinimum: 3,
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
    expect(lines[0]).toContain('expired 4 old backup(s)');
  });
});

describe('backup scheduling through start() (review M-20)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start() schedules a daily backup next to the database; close() stops it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-backup-sched-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Interval timers are faked (creation AND clearing - the real
    // clearInterval cannot clear a fake timer, and close() must clear);
    // start() still listens over the real event loop, and the daily timer is
    // then driven by hand.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: join(dir, 'data', 'agent.db'),
        DASHBOARD_INGEST: '0',
      });
      const backupsDir = join(dir, 'data', 'backups');
      try {
        vi.advanceTimersByTime(BACKUP_INTERVAL_MS);
        // The online backup pages over the REAL event loop; the log line is
        // the run's final step, so waiting on it means the run is complete.
        await vi.waitFor(() => {
          expect(log).toHaveBeenCalledWith(expect.stringContaining('database backup: wrote'));
        });
        const files = readdirSync(backupsDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(DATED_BACKUP);
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
});
