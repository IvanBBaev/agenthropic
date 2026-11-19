/**
 * OPS-17 - an optional second copy of every daily backup
 * (`DASHBOARD_BACKUP_MIRROR_DIR`). The copy step itself, then the scheduler:
 * a successful backup is mirrored before retention runs, a failed mirror is
 * logged and reported but stops nothing, and a mirror that is the backup
 * directory itself is refused up front.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDistinctMirror, mirrorBackupFile } from '../src/db/backup-mirror';
import { PRIVATE_FILE_MODE } from '../src/db/file-modes';
import { scheduleDailyBackups } from '../src/index';
import { NO_RETENTION } from '../src/retention/policy';
import type { RetentionPort } from '../src/retention/port';
import { createMigratedTempDb } from './helpers';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthropic-ops17-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('mirrorBackupFile()', () => {
  it('copies the backup under its own name, 0600, and leaves no partial file', () => {
    const dir = tempDir();
    const source = join(dir, 'agenthropic-2026-11-19T03-00-00-000Z.db');
    writeFileSync(source, 'backup bytes', { mode: 0o644 });
    const mirror = join(dir, 'mirror');
    mkdirSync(mirror);

    const written = mirrorBackupFile(source, mirror);

    expect(written).toBe(join(mirror, 'agenthropic-2026-11-19T03-00-00-000Z.db'));
    expect(readFileSync(written, 'utf8')).toBe('backup bytes');
    expect(statSync(written).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    expect(readdirSync(mirror)).toEqual(['agenthropic-2026-11-19T03-00-00-000Z.db']);
  });

  it('never creates a missing mirror directory - an unmounted volume must fail, not fill the local disk', () => {
    const dir = tempDir();
    const source = join(dir, 'agenthropic-x.db');
    writeFileSync(source, 'x');
    const mirror = join(dir, 'not-mounted');

    expect(() => mirrorBackupFile(source, mirror)).toThrow(/ENOENT/);
    expect(readdirSync(dir)).toEqual(['agenthropic-x.db']);
  });

  it('removes the partial copy when the copy fails part-way', () => {
    const dir = tempDir();
    const mirror = join(dir, 'mirror');
    mkdirSync(mirror);

    // The source is missing, so copyFile throws before any byte lands.
    expect(() => mirrorBackupFile(join(dir, 'agenthropic-gone.db'), mirror)).toThrow(/ENOENT/);
    expect(readdirSync(mirror)).toEqual([]);
  });
});

describe('assertDistinctMirror()', () => {
  it('refuses the backup directory itself, however it is spelled', () => {
    expect(() => assertDistinctMirror('/data/backups', '/data/backups')).toThrow(
      /is the backup directory itself/,
    );
    expect(() => assertDistinctMirror('/data/backups', '/data/x/../backups/')).toThrow(RangeError);
  });

  it('accepts any other directory', () => {
    expect(() => assertDistinctMirror('/data/backups', '/Volumes/nas/backups')).not.toThrow();
  });
});

describe('scheduleDailyBackups() with a mirror', () => {
  const AT = new Date('2026-11-19T03:00:00.000Z');

  function recordingRetention(calls: string[]): RetentionPort {
    return {
      policy: NO_RETENTION,
      run: (options) => {
        calls.push('retention');
        return {
          ranAt: (options?.now ?? AT).toISOString(),
          dryRun: false,
          configured: false,
          database: null,
          backups: null,
        };
      },
    };
  }

  function setup() {
    const temp = createMigratedTempDb();
    const backups = join(temp.dir, 'backups');
    const mirror = join(temp.dir, 'mirror');
    mkdirSync(backups);
    mkdirSync(mirror);
    const calls: string[] = [];
    const lines: string[] = [];
    const errors: string[] = [];
    return { temp, backups, mirror, calls, lines, errors };
  }

  it('mirrors a successful backup before retention runs, and reports it', async () => {
    const { temp, backups, mirror, calls, lines, errors } = setup();
    const scheduler = scheduleDailyBackups(temp.db, backups, recordingRetention(calls), {
      now: () => AT,
      backup: (_db, destPath) => {
        writeFileSync(destPath, 'copy');
        calls.push('backup');
        return Promise.resolve();
      },
      mirror: (source, directory) => {
        calls.push('mirror');
        return mirrorBackupFile(source, directory);
      },
      mirrorDirectory: mirror,
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
    });
    try {
      expect(scheduler.state().mirror).toEqual({ lastMirrorAt: null, lastError: null });
      await scheduler.runOnce();
      expect(calls).toEqual(['backup', 'mirror', 'retention']);
      expect(readdirSync(mirror)).toEqual(['agenthropic-2026-11-19T03-00-00-000Z.db']);
      expect(scheduler.state().mirror).toEqual({ lastMirrorAt: AT, lastError: null });
      expect(lines).toContain(
        `database backup mirror: wrote ${join(mirror, 'agenthropic-2026-11-19T03-00-00-000Z.db')}.`,
      );
      expect(errors).toEqual([]);
    } finally {
      scheduler.stop();
      temp.cleanup();
    }
  });

  it('a failed mirror is logged and reported, retention still runs, and the next success clears it', async () => {
    const { temp, backups, mirror, calls, errors } = setup();
    const seed = new Date('2026-11-18T03:00:00.000Z');
    let fail: unknown = new Error('EIO: volume went away');
    const scheduler = scheduleDailyBackups(temp.db, backups, recordingRetention(calls), {
      now: () => AT,
      backup: () => Promise.resolve(),
      mirror: (source, directory) => {
        if (fail !== null) throw fail;
        return join(directory, source);
      },
      mirrorDirectory: mirror,
      lastMirrorAt: seed,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });
    try {
      await scheduler.runOnce();
      expect(calls).toEqual(['retention']);
      expect(errors).toEqual(['database backup mirror failed: EIO: volume went away']);
      expect(scheduler.state()).toEqual({
        lastBackupAt: AT,
        lastError: null,
        mirror: { lastMirrorAt: seed, lastError: 'EIO: volume went away' },
      });

      fail = 'not an Error';
      await scheduler.runOnce();
      expect(scheduler.state().mirror?.lastError).toBe('not an Error');

      fail = null;
      await scheduler.runOnce();
      expect(scheduler.state().mirror).toEqual({ lastMirrorAt: AT, lastError: null });
    } finally {
      scheduler.stop();
      temp.cleanup();
    }
  });

  it('a failed backup mirrors nothing', async () => {
    const { temp, backups, mirror, calls } = setup();
    const scheduler = scheduleDailyBackups(temp.db, backups, recordingRetention(calls), {
      now: () => AT,
      backup: () => Promise.reject(new Error('disk full')),
      mirror: () => {
        calls.push('mirror');
        return '';
      },
      mirrorDirectory: mirror,
      log: () => undefined,
      logError: () => undefined,
    });
    try {
      await scheduler.runOnce();
      expect(calls).toEqual([]);
      expect(scheduler.state().mirror).toEqual({ lastMirrorAt: null, lastError: null });
    } finally {
      scheduler.stop();
      temp.cleanup();
    }
  });

  it('refuses a mirror that is the backup directory itself', () => {
    const { temp, backups, calls } = setup();
    try {
      expect(() =>
        scheduleDailyBackups(temp.db, backups, recordingRetention(calls), {
          mirrorDirectory: backups,
        }),
      ).toThrow(/is the backup directory itself/);
    } finally {
      temp.cleanup();
    }
  });

  it('without a mirror the state carries no mirror field', () => {
    const { temp, backups, calls } = setup();
    const scheduler = scheduleDailyBackups(temp.db, backups, recordingRetention(calls), {
      mirrorDirectory: null,
    });
    try {
      expect(scheduler.state()).toEqual({ lastBackupAt: null, lastError: null });
      expect(scheduler.state()).not.toHaveProperty('mirror');
    } finally {
      scheduler.stop();
      temp.cleanup();
    }
  });
});
