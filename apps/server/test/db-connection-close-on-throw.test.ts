/**
 * `openDatabase` closes the handle when its own setup throws.
 *
 * The constructor succeeds on any path it can create or open, and the file is
 * only read when the first pragma runs. A file that is not a database, or a
 * connection that fails the WAL / foreign-key assertion, used to throw out of
 * `openDatabase` with the handle still open and unreachable: a leaked file
 * descriptor, and on a WAL database a lock held until the process exits.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Records every handle the adapter constructs, so the test can see whether
// the one behind a failed open was closed.
const created = vi.hoisted(() => ({ handles: [] as Array<{ open: boolean }> }));
vi.mock('better-sqlite3', async (importOriginal) => {
  const actual = (await importOriginal<{ default: new (path: string) => { open: boolean } }>())
    .default;
  class Recording extends actual {
    constructor(path: string) {
      super(path);
      created.handles.push(this);
    }
  }
  return { default: Recording };
});

const { openDatabase } = await import('../src/db/connection');

describe('openDatabase: a failed setup closes the handle', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-open-close-'));
    created.handles.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('closes the handle when the file is not a database', () => {
    const path = join(dir, 'not-a.db');
    writeFileSync(path, 'this is not an SQLite file, just some text '.repeat(20));

    expect(() => openDatabase(path)).toThrow();

    expect(created.handles).toHaveLength(1);
    expect(created.handles[0]?.open).toBe(false);
  });

  it('closes the handle when a pragma assertion fails', () => {
    // An in-memory database cannot enter WAL mode, so the assertion throws.
    expect(() => openDatabase(':memory:')).toThrow(/not in WAL mode/);

    expect(created.handles).toHaveLength(1);
    expect(created.handles[0]?.open).toBe(false);
  });

  it('returns an open handle on success', () => {
    const db = openDatabase(join(dir, 'ok.db'));

    expect(db.open).toBe(true);
    db.close();
  });
});
