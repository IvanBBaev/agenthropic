/**
 * A journal append writes every byte of the line, or it throws.
 *
 * `writeSync` returns how many bytes it wrote, and that can be fewer than
 * asked for. The append used to ignore the count, so after a short write it
 * `fsync`ed a truncated receipt and returned normally, and the prune committed
 * its deletion as if the receipt were complete. The append now loops until
 * every byte is written. A write that makes no progress throws, which rolls
 * the deletion back.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `cap` limits how many bytes each writeSync call may write: -1 means
// unlimited, 0 means no progress. Every other call goes to the real fs.
const short = vi.hoisted(() => ({ cap: -1, calls: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number): number => {
      short.calls += 1;
      const n = short.cap < 0 ? length : Math.min(length, short.cap);
      return n === 0 ? 0 : actual.writeSync(fd, buffer, offset, n);
    },
  };
});

const { appendJournalEntry, readJournalEntries } = await import('../src/retention/journal');

describe('retention journal: a short write is never a durable receipt', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-journal-short-'));
    short.cap = -1;
    short.calls = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps writing after a short write until the whole line is on disk', () => {
    const path = join(dir, 'journal.jsonl');
    short.cap = 7;

    appendJournalEntry(path, { ranAt: '2026-09-24T00:00:00.000Z', costUsd: 1.5 });

    expect(short.calls).toBeGreaterThan(1);
    expect(readJournalEntries(path)).toEqual([
      expect.objectContaining({ ranAt: '2026-09-24T00:00:00.000Z', costUsd: 1.5 }),
    ]);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('throws when a write makes no progress', () => {
    short.cap = 0;

    expect(() => appendJournalEntry(join(dir, 'journal.jsonl'), { ranAt: 'a' })).toThrow(
      /retention journal write made no progress/,
    );
  });

  it('writes a multi-byte line in full', () => {
    const path = join(dir, 'journal.jsonl');
    short.cap = 3;

    appendJournalEntry(path, { note: 'ünïcødé ✓' });

    expect(readJournalEntries(path)).toEqual([expect.objectContaining({ note: 'ünïcødé ✓' })]);
  });
});
