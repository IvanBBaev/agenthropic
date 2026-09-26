/**
 * A restore closes its check handle even when `integrity_check` throws.
 *
 * `integrity_check` normally returns a report, but it can also throw: a page
 * it cannot read, an I/O error or an allocation failure while it walks the
 * btree. The restore used to close the handle only after the pragma returned,
 * so a throw left the staged copy open, holding its `-wal` / `-shm` pair until
 * the process exited. The next restore then deleted sidecars still in use.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDatabase } from '../src/db/connection';

// Wraps the handle the restore opens on its staged copy, so its
// integrity_check throws and the test can see whether it was closed.
const staged = vi.hoisted(() => ({ handles: [] as SqliteDatabase[] }));
vi.mock('../src/db/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/connection')>();
  return {
    ...actual,
    openDatabase: (path: string): SqliteDatabase => {
      const db = actual.openDatabase(path);
      if (!path.endsWith('.restoring')) {
        return db;
      }
      staged.handles.push(db);
      const pragma = db.pragma.bind(db);
      db.pragma = ((source: string, options?: { simple?: boolean }) => {
        if (source === 'integrity_check') {
          throw new Error('SQLITE_IOERR: disk I/O error');
        }
        return pragma(source, options);
      }) as SqliteDatabase['pragma'];
      return db;
    },
  };
});

const { backupDatabase, restoreDatabase } = await import('../src/db/backup');
const { openDatabase } = await import('../src/db/connection');
const { runMigrations } = await import('../src/db/migrations');

describe('restore closes the check handle when integrity_check throws', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-restore-check-close-'));
    staged.handles.length = 0;
  });

  afterEach(() => {
    for (const db of staged.handles) {
      if (db.open) {
        db.close();
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('rethrows the error with the staged handle closed', async () => {
    const src = openDatabase(join(dir, 'src', 'agent.db'));
    runMigrations(src);
    const backupPath = join(dir, 'backups', 'agent.db');
    await backupDatabase(src, backupPath);
    src.close();

    expect(() => restoreDatabase(backupPath, join(dir, 'live', 'agent.db'))).toThrow(
      /SQLITE_IOERR/,
    );

    expect(staged.handles).toHaveLength(1);
    expect(staged.handles[0]?.open).toBe(false);
  });
});
