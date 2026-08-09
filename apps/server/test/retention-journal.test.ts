import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendJournalEntry,
  defaultJournalPath,
  readJournalEntries,
  RETENTION_JOURNAL_SCHEMA,
  RETENTION_JOURNAL_SUFFIX,
} from '../src/retention/journal';
import { RetentionPolicyError } from '../src/retention/policy';

describe('retention journal (WP-D10) - the receipt that keeps a prune honest', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-journal-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives its path from the database it describes', () => {
    expect(defaultJournalPath('/data/agenthropic.db')).toBe(
      `/data/agenthropic.db${RETENTION_JOURNAL_SUFFIX}`,
    );
  });

  it('refuses to derive a path for a database with no file', () => {
    expect(() => defaultJournalPath(':memory:')).toThrow(RetentionPolicyError);
    expect(() => defaultJournalPath('')).toThrow(/durable receipt/);
  });

  it('is empty (not an error) before anything has ever been pruned', () => {
    expect(readJournalEntries(join(dir, 'nothing.jsonl'))).toEqual([]);
  });

  it('appends one tagged JSON line per entry and never rewrites earlier ones', () => {
    const path = join(dir, 'nested', 'journal.jsonl');
    appendJournalEntry(path, { ranAt: '2026-08-01T00:00:00.000Z', costUsd: 1.5 });
    const afterFirst = readFileSync(path, 'utf8');
    appendJournalEntry(path, { ranAt: '2026-08-02T00:00:00.000Z', costUsd: 2.5 });

    const raw = readFileSync(path, 'utf8');
    expect(raw.startsWith(afterFirst)).toBe(true);
    expect(raw.split('\n').filter((line) => line !== '')).toHaveLength(2);

    const entries = readJournalEntries(path);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      schema: RETENTION_JOURNAL_SCHEMA,
      ranAt: '2026-08-01T00:00:00.000Z',
      costUsd: 1.5,
    });
    expect(entries[1]?.['costUsd']).toBe(2.5);
  });

  it('skips blank lines but refuses to silently drop a malformed one', () => {
    const path = join(dir, 'journal.jsonl');
    appendJournalEntry(path, { ranAt: 'a' });
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`, 'utf8');
    expect(readJournalEntries(path)).toHaveLength(1);

    writeFileSync(path, `${readFileSync(path, 'utf8')}{not json}\n`, 'utf8');
    expect(() => readJournalEntries(path)).toThrow();
  });

  it('propagates an I/O failure instead of pretending the receipt was written', () => {
    // A path whose parent is a FILE cannot be created; the prune treats this
    // as "the prune did not happen".
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    expect(() => appendJournalEntry(join(blocker, 'journal.jsonl'), { ranAt: 'a' })).toThrow();
  });
});
