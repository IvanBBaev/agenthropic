/**
 * SEC-8: both confined reads open with `O_NONBLOCK`, so a FIFO swapped in
 * after the walk's `lstat` cannot block `open` waiting for a writer (it opens
 * at once and the fstat guard rejects it as ENOTREG).
 *
 * A real FIFO cannot be made from a test: Node has no `mkfifo`, and spawning
 * the `mkfifo` binary would trip `gate:spawner`. So this file pins the flags
 * every open passes instead. Verified by hand on 2026-11-19 against a real
 * FIFO: before the change `readFileConfined` hung; after it both reads throw
 * ENOTREG within a millisecond.
 */
import { constants, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openCalls = vi.hoisted(() => [] as Array<{ path: string; flags: unknown }>);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (path: string, flags: number) => {
      openCalls.push({ path, flags });
      return actual.openSync(path, flags);
    },
  };
});

const { CONFINED_OPEN_FLAGS, nodeCorpusFs } = await import('../../src/corpus/node-corpus-fs');

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agenthropic-corpus-flags-')));
  writeFileSync(join(root, 'a.jsonl'), '{"x":1}\n');
  openCalls.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('confined open flags (SEC-8)', () => {
  it('are read-only, no-follow and non-blocking', () => {
    expect(CONFINED_OPEN_FLAGS & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(CONFINED_OPEN_FLAGS & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    // O_RDONLY is 0, so read-only means no write-access bit is set.
    expect(CONFINED_OPEN_FLAGS & (constants.O_WRONLY | constants.O_RDWR)).toBe(0);
    expect(CONFINED_OPEN_FLAGS & (constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)).toBe(
      0,
    );
  });

  it('are what both confined reads pass to open', () => {
    const fs = nodeCorpusFs();
    const path = join(root, 'a.jsonl');

    expect(fs.readFileConfined(path, 1024)).toBe('{"x":1}\n');
    expect(fs.readFileTailConfined(path, 0, 1024).sizeBytes).toBe(8);

    expect(openCalls).toEqual([
      { path, flags: CONFINED_OPEN_FLAGS },
      { path, flags: CONFINED_OPEN_FLAGS },
    ]);
  });
});
