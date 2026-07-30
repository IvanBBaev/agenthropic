/**
 * Integration tests for the production {@link nodeCorpusFs} adapter — the SOLE
 * module bound to `node:fs`. Unlike every other corpus test (which is driven by
 * the in-memory fake), these exercise REAL syscalls, so they run against a
 * throwaway `mkdtemp` root under `os.tmpdir()` and never read, write or even
 * resolve the user's actual `~/.claude/projects`.
 *
 * The security-critical assertions here are the ones the fake cannot prove:
 * `lstat` does NOT follow a symlink, and `readFileConfined` fails with ELOOP on
 * one (O_NOFOLLOW) even when it points at a perfectly readable regular file —
 * i.e. a symlink swapped in after the walk's `lstat` cannot be followed out of
 * the corpus root.
 *
 * The `ENOTREG` arm is deliberately NOT tested here: a real fifo/socket blocks
 * or errors on `open` itself, so `fstat` never sees it (hence the source's
 * `/* v8 ignore next *\/`). The fake covers it.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errnoCodeOf, OversizeError } from '../../src/corpus/fs-port';
import { nodeCorpusFs } from '../../src/corpus/node-corpus-fs';
import { dir, file, materializeTree, symlink } from './fake-corpus-fs';

const CAP = 1024;
/** Content whose UTF-8 byte length is exactly `CAP` — the `>` vs `>=` boundary. */
const EXACTLY_AT_CAP = 'a'.repeat(CAP);
/** Twice the cap — must be rejected, unread. */
const OVER_CAP = 'b'.repeat(2 * CAP);

const fs = nodeCorpusFs();

/** The temp root, canonicalized: on macOS `os.tmpdir()` is itself a symlink into `/private`. */
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agenthropic-corpus-fs-')));
  materializeTree(root, {
    'session.jsonl': file('{"type":"user"}\n'),
    'at-cap.jsonl': file(EXACTLY_AT_CAP),
    'over-cap.jsonl': file(OVER_CAP),
    'real-dir': dir({ 'nested.jsonl': file('{"nested":true}\n') }),
    // A symlink to a REAL, readable, in-root regular file: proves the ELOOP
    // rejection is about the link itself, not about an unreachable target.
    'link-to-file.jsonl': symlink('session.jsonl'),
    'link-to-dir': symlink('real-dir'),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run `fn`, returning whatever it threw; fails the test if it does not throw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

describe('nodeCorpusFs.readDirNames', () => {
  it('returns the entry names of a real directory', () => {
    expect([...fs.readDirNames(root)].sort()).toEqual([
      'at-cap.jsonl',
      'link-to-dir',
      'link-to-file.jsonl',
      'over-cap.jsonl',
      'real-dir',
      'session.jsonl',
    ]);
  });

  it('lists a nested directory', () => {
    expect(fs.readDirNames(join(root, 'real-dir'))).toEqual(['nested.jsonl']);
  });

  it('throws ENOENT for a directory that does not exist', () => {
    const err = thrownBy(() => fs.readDirNames(join(root, 'no-such-dir')));
    expect(errnoCodeOf(err)).toBe('ENOENT');
  });
});

describe('nodeCorpusFs.lstat', () => {
  it('reports a regular file as isFile only, with its exact byte size', () => {
    // '{"type":"user"}\n' is 16 UTF-8 bytes; mtime is platform clock territory.
    expect(fs.lstat(join(root, 'session.jsonl'))).toEqual({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      sizeBytes: 16,
      mtimeMs: expect.any(Number) as number,
    });
  });

  it('reports the at-cap file size exactly (the fingerprint feeds off this)', () => {
    expect(fs.lstat(join(root, 'at-cap.jsonl')).sizeBytes).toBe(CAP);
  });

  it('reports a recent, positive mtimeMs for a freshly written file', () => {
    const { mtimeMs } = fs.lstat(join(root, 'session.jsonl'));
    expect(mtimeMs).toBeGreaterThan(0);
    expect(Math.abs(Date.now() - mtimeMs)).toBeLessThan(60_000);
  });

  it('reports a directory as isDirectory only', () => {
    expect(fs.lstat(join(root, 'real-dir'))).toEqual({
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      sizeBytes: expect.any(Number) as number,
      mtimeMs: expect.any(Number) as number,
    });
  });

  it('reports a symlink to a regular file as isSymbolicLink and NOT isFile (no follow)', () => {
    // Security-relevant: `stat` would report isFile here and hide the link.
    expect(fs.lstat(join(root, 'link-to-file.jsonl'))).toEqual({
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
      sizeBytes: expect.any(Number) as number,
      mtimeMs: expect.any(Number) as number,
    });
  });

  it('reports a symlink to a directory as isSymbolicLink and NOT isDirectory (no follow)', () => {
    expect(fs.lstat(join(root, 'link-to-dir'))).toEqual({
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
      sizeBytes: expect.any(Number) as number,
      mtimeMs: expect.any(Number) as number,
    });
  });

  it('throws ENOENT for a path that does not exist', () => {
    const err = thrownBy(() => fs.lstat(join(root, 'ghost.jsonl')));
    expect(errnoCodeOf(err)).toBe('ENOENT');
  });
});

describe('nodeCorpusFs.readFileConfined', () => {
  it('returns the UTF-8 content of a regular file within the cap', () => {
    expect(fs.readFileConfined(join(root, 'session.jsonl'), CAP)).toBe('{"type":"user"}\n');
  });

  it('throws ELOOP on a symlink even when its target is a readable real file (O_NOFOLLOW)', () => {
    // THE security-critical assertion: a symlink swapped in after the walk's
    // lstat must not be followed out of the corpus root. The target here is
    // readable via the direct path, so only O_NOFOLLOW can explain the failure.
    const linkPath = join(root, 'link-to-file.jsonl');
    expect(fs.readFileConfined(join(root, 'session.jsonl'), CAP)).toBe('{"type":"user"}\n');

    const err = thrownBy(() => fs.readFileConfined(linkPath, CAP));
    expect(errnoCodeOf(err)).toBe('ELOOP');
  });

  it('throws ELOOP on a symlink pointing at a directory', () => {
    const err = thrownBy(() => fs.readFileConfined(join(root, 'link-to-dir'), CAP));
    expect(errnoCodeOf(err)).toBe('ELOOP');
  });

  it('throws EISDIR for a directory path (fstat-on-descriptor non-regular-file guard)', () => {
    const err = thrownBy(() => fs.readFileConfined(join(root, 'real-dir'), CAP));
    expect(errnoCodeOf(err)).toBe('EISDIR');
  });

  it('throws ENOENT for a path that does not exist', () => {
    const err = thrownBy(() => fs.readFileConfined(join(root, 'ghost.jsonl'), CAP));
    expect(errnoCodeOf(err)).toBe('ENOENT');
  });

  it('throws OversizeError carrying the real size, the cap and the path', () => {
    const absPath = join(root, 'over-cap.jsonl');
    const err = thrownBy(() => fs.readFileConfined(absPath, CAP));

    expect(err).toBeInstanceOf(OversizeError);
    const oversize = err as OversizeError;
    expect(oversize.name).toBe('OversizeError');
    expect(oversize.sizeBytes).toBe(2 * CAP);
    expect(oversize.maxBytes).toBe(CAP);
    expect(oversize.path).toBe(absPath);
  });

  it('reads a file whose size is EXACTLY the cap (the guard is > not >=)', () => {
    // Boundary: size === maxBytes is allowed through, only size > maxBytes is not.
    expect(fs.readFileConfined(join(root, 'at-cap.jsonl'), CAP)).toBe(EXACTLY_AT_CAP);
  });

  it('rejects a file one byte over the cap', () => {
    expect(() => fs.readFileConfined(join(root, 'at-cap.jsonl'), CAP - 1)).toThrow(OversizeError);
  });

  it('always closes the descriptor, over both the success and the throwing arms', () => {
    // The `finally` leaks nothing: hundreds of opens (mixing reads that return
    // and reads that throw past the fd) never exhaust the process fd table.
    const readable = join(root, 'session.jsonl');
    const oversized = join(root, 'over-cap.jsonl');
    const isDir = join(root, 'real-dir');

    expect(() => {
      for (let i = 0; i < 400; i += 1) {
        fs.readFileConfined(readable, CAP);
        expect(() => fs.readFileConfined(oversized, CAP)).toThrow(OversizeError);
        expect(() => fs.readFileConfined(isDir, CAP)).toThrow();
      }
    }).not.toThrow();

    // Still readable afterwards — no EMFILE, no exhausted fd table.
    expect(fs.readFileConfined(readable, CAP)).toBe('{"type":"user"}\n');
  });
});

describe('nodeCorpusFs.realpath', () => {
  it('canonicalizes a symlinked directory to its real target', () => {
    // Compare against realpathSync of the real path: on macOS the temp root is
    // itself reached through a symlink, so raw-path comparison would be flaky.
    expect(fs.realpath(join(root, 'link-to-dir'))).toBe(realpathSync(join(root, 'real-dir')));
  });

  it('canonicalizes a symlink to a regular file', () => {
    expect(fs.realpath(join(root, 'link-to-file.jsonl'))).toBe(
      realpathSync(join(root, 'session.jsonl')),
    );
  });

  it('returns an already-canonical path unchanged', () => {
    expect(fs.realpath(join(root, 'real-dir'))).toBe(join(root, 'real-dir'));
  });

  it('throws ENOENT for a path that does not exist', () => {
    const err = thrownBy(() => fs.realpath(join(root, 'ghost')));
    expect(errnoCodeOf(err)).toBe('ENOENT');
  });
});
