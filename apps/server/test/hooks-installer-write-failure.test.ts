/**
 * GG7 - the installer's settings write must be all-or-nothing. A write that
 * dies part-way (disk full, quota, I/O error) used to leave the operator's
 * settings file truncated in place; the new content is now written to a temp
 * sibling and renamed over the target, so a failure leaves the original bytes
 * intact, removes the temp file, and names the backup in the error.
 *
 * Runs on a throwaway temp directory - never the real ~/.claude.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fail every settings write made while `failing.dir` is set, after writing a
// truncated prefix - the shape of a real ENOSPC. Other calls go to the real fs.
const failing = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (
      path: realFs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: realFs.WriteFileOptions,
    ): void => {
      if (failing.dir !== '' && String(path).startsWith(failing.dir)) {
        actual.writeFileSync(path, String(data).slice(0, 7), options);
        throw Object.assign(new Error(`ENOSPC: no space left on device, write`), {
          code: 'ENOSPC',
        });
      }
      actual.writeFileSync(path, data, options);
    },
  };
});

const { formatSettings, runInstall } = await import('../../../hooks/install.mjs');

describe('hooks installer: a failed settings write leaves the original intact (GG7)', () => {
  let dir: string;
  let claudeDir: string;
  let out: string;
  const fixedNow = (): Date => new Date('2026-07-18T10:00:00.000Z');

  beforeEach(() => {
    // Resolved: on macOS tmpdir() is under /var, a symlink to /private/var, and the
    // installer writes via the resolved path.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'agenthropic-installer-write-failure-')));
    claudeDir = join(dir, '.claude');
    out = join(claudeDir, 'settings.json');
    mkdirSync(claudeDir);
    failing.dir = '';
  });

  afterEach(() => {
    failing.dir = '';
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the original bytes, removes the temp file and names the backup', () => {
    const original = formatSettings({ theme: 'dark' });
    writeFileSync(out, original, 'utf8');
    failing.dir = claudeDir;

    let caught: unknown;
    try {
      runInstall({ out, now: fixedNow });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('ENOSPC');
    const backups = readdirSync(claudeDir).filter((name) => name.includes('.backup-'));
    expect(backups).toHaveLength(1);
    const backupPath = join(claudeDir, backups[0] as string);
    expect(message).toContain(backupPath);
    expect(readFileSync(backupPath, 'utf8')).toBe(original);
    // The operator's file is untouched: not truncated, not replaced.
    expect(readFileSync(out, 'utf8')).toBe(original);
    // And no half-written temp sibling is left lying around.
    expect(readdirSync(claudeDir).sort()).toEqual(['settings.json', backups[0]].sort());
  });

  it('on a first install (no backup) says nothing was written and leaves no file', () => {
    failing.dir = claudeDir;

    expect(() => runInstall({ out, now: fixedNow })).toThrow(/ENOSPC[\s\S]*nothing was written/i);
    expect(readdirSync(claudeDir)).toEqual([]);
  });

  it('names the directory it created before the write failed (JJ4)', () => {
    const freshDir = join(dir, 'fresh');
    const freshOut = join(freshDir, 'nested', 'settings.json');
    failing.dir = freshDir;

    let caught: unknown;
    try {
      runInstall({ out: freshOut, now: fixedNow });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('ENOSPC');
    expect(message).toContain(`Nothing was written, but the directory ${freshDir} was created.`);
    expect(readdirSync(join(freshDir, 'nested'))).toEqual([]);
  });
});
