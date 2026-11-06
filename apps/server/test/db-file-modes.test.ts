/**
 * R4 / SEC-2: the database, its sidecars, the backups and the retention journal
 * are private from the moment they exist, and a boot tightens what an older
 * install left open.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupDatabase, restoreDatabase } from '../src/db/backup';
import { openDatabase } from '../src/db/connection';
import {
  assertPrivateModes,
  ensurePrivateDatabaseFiles,
  ensurePrivateDir,
  ensurePrivateFile,
  secureDataFiles,
} from '../src/db/file-modes';
import { start } from '../src/index';
import { appendJournalEntry, RETENTION_JOURNAL_SUFFIX } from '../src/retention/journal';

const TEST_TOKEN = 'test-token-long-enough-for-the-policy';

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('private file modes', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-modes-'));
    dirs.push(dir);
    return dir;
  }

  function openFile(path: string, content = 'x'): string {
    writeFileSync(path, content);
    chmodSync(path, 0o644);
    return path;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('helpers', () => {
    it('creates missing directories as 0700, parents included', () => {
      const root = tempDir();
      ensurePrivateDir(join(root, 'a', 'b'));
      expect(modeOf(join(root, 'a'))).toBe(0o700);
      expect(modeOf(join(root, 'a', 'b'))).toBe(0o700);
    });

    it('leaves the mode of an existing directory alone', () => {
      const shared = join(tempDir(), 'shared');
      mkdirSync(shared);
      chmodSync(shared, 0o755);
      ensurePrivateDir(shared);
      expect(modeOf(shared)).toBe(0o755);
    });

    it('creates a file as 0600 and tightens an existing one without touching its content', () => {
      const root = tempDir();
      ensurePrivateFile(join(root, 'new'));
      expect(modeOf(join(root, 'new'))).toBe(0o600);

      const existing = openFile(join(root, 'old'), 'kept');
      ensurePrivateFile(existing);
      expect(modeOf(existing)).toBe(0o600);
      expect(readFileSync(existing, 'utf8')).toBe('kept');
    });

    it('tightens the sidecars an unclean shutdown left, and tolerates their absence', () => {
      const root = tempDir();
      const dbPath = join(root, 'agent.db');
      ensurePrivateDatabaseFiles(dbPath);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);

      openFile(`${dbPath}-wal`);
      openFile(`${dbPath}-shm`);
      ensurePrivateDatabaseFiles(dbPath);
      expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
      expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    });
  });

  describe('openDatabase', () => {
    it('makes the directory, the database and both sidecars private', () => {
      const dbPath = join(tempDir(), 'nested', 'agent.db');
      const db = openDatabase(dbPath);
      try {
        db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
        expect(modeOf(join(dbPath, '..'))).toBe(0o700);
        expect(modeOf(dbPath)).toBe(0o600);
        expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
        expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
      } finally {
        db.close();
      }
    });

    it('tightens a database created by an older install', () => {
      const dbPath = join(tempDir(), 'agent.db');
      openDatabase(dbPath).close();
      chmodSync(dbPath, 0o644);
      const db = openDatabase(dbPath);
      db.close();
      expect(modeOf(dbPath)).toBe(0o600);
    });

    it.each(['', ':memory:'])('creates no file for the fileless database %j', (path) => {
      // openDatabase refuses both: neither can be in WAL mode.
      expect(() => openDatabase(path)).toThrow(/not in WAL mode/);
      expect(existsSync(':memory:')).toBe(false);
    });
  });

  describe('backupDatabase', () => {
    it('writes a 0600 backup into a 0700 directory', async () => {
      const root = tempDir();
      const db = openDatabase(join(root, 'agent.db'));
      const dest = join(root, 'backups', 'one.db');
      try {
        await backupDatabase(db, dest);
      } finally {
        db.close();
      }
      expect(modeOf(dest)).toBe(0o600);
      expect(modeOf(join(root, 'backups'))).toBe(0o700);
    });

    it('tightens a destination that already exists', async () => {
      const root = tempDir();
      const dest = openFile(join(root, 'one.db'), '');
      const db = openDatabase(join(root, 'agent.db'));
      try {
        await backupDatabase(db, dest);
      } finally {
        db.close();
      }
      expect(modeOf(dest)).toBe(0o600);
    });

    it('removes the file it created when the backup fails', async () => {
      const root = tempDir();
      const dest = join(root, 'one.db');
      const db = openDatabase(join(root, 'agent.db'));
      db.close();
      await expect(backupDatabase(db, dest)).rejects.toThrow(/not open/);
      expect(existsSync(dest)).toBe(false);
    });

    it('keeps a file that was there before a failed backup', async () => {
      const root = tempDir();
      const dest = openFile(join(root, 'one.db'), 'an earlier backup');
      const db = openDatabase(join(root, 'agent.db'));
      db.close();
      await expect(backupDatabase(db, dest)).rejects.toThrow(/not open/);
      expect(readFileSync(dest, 'utf8')).toBe('an earlier backup');
    });
  });

  it('restoreDatabase produces a private database from a world-readable backup', async () => {
    const root = tempDir();
    const backup = join(root, 'one.db');
    const db = openDatabase(join(root, 'agent.db'));
    await backupDatabase(db, backup);
    db.close();
    chmodSync(backup, 0o644);

    const dest = join(root, 'restored', 'agent.db');
    const restored = restoreDatabase(backup, dest);
    restored.close();
    expect(modeOf(dest)).toBe(0o600);
    expect(modeOf(join(root, 'restored'))).toBe(0o700);
  });

  it('appendJournalEntry creates a 0600 journal in a 0700 directory', () => {
    const root = tempDir();
    const path = join(root, 'data', `agent.db${RETENTION_JOURNAL_SUFFIX}`);
    appendJournalEntry(path, { ranAt: '2026-11-06T00:00:00.000Z', costUsd: 0 });
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(join(root, 'data'))).toBe(0o700);
  });

  describe('assertPrivateModes', () => {
    it('passes private paths and skips missing ones', () => {
      const root = tempDir();
      const file = join(root, 'private');
      ensurePrivateFile(file);
      expect(() => assertPrivateModes([file, join(root, 'missing')])).not.toThrow();
    });

    it('names every exposed path with its mode', () => {
      const root = tempDir();
      const exposed = openFile(join(root, 'exposed'));
      expect(() => assertPrivateModes([exposed])).toThrow(
        new RegExp(`${exposed} \\(mode 644\\).*refusing to continue`, 's'),
      );
    });
  });

  describe('secureDataFiles', () => {
    function layout(root: string): {
      dbPath: string;
      backupsDir: string;
      journalPath: string;
    } {
      const dbPath = join(root, 'agent.db');
      return {
        dbPath,
        backupsDir: join(root, 'backups'),
        journalPath: `${dbPath}${RETENTION_JOURNAL_SUFFIX}`,
      };
    }

    it('tightens every data file and the backups directory of an older install', () => {
      const root = tempDir();
      const paths = layout(root);
      for (const file of [
        paths.dbPath,
        `${paths.dbPath}-wal`,
        `${paths.dbPath}-shm`,
        paths.journalPath,
      ]) {
        openFile(file);
      }
      mkdirSync(paths.backupsDir);
      chmodSync(paths.backupsDir, 0o755);
      const backup = openFile(join(paths.backupsDir, 'one.db'));
      const warn = vi.fn();

      secureDataFiles(paths, warn);

      for (const file of [
        paths.dbPath,
        `${paths.dbPath}-wal`,
        `${paths.dbPath}-shm`,
        paths.journalPath,
        backup,
      ]) {
        expect(modeOf(file)).toBe(0o600);
      }
      expect(modeOf(paths.backupsDir)).toBe(0o700);
      expect(warn).not.toHaveBeenCalled();
    });

    it('accepts a fresh install with no backups and no journal', () => {
      const paths = layout(tempDir());
      ensurePrivateFile(paths.dbPath);
      const warn = vi.fn();
      secureDataFiles(paths, warn);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not follow a symlink or descend into a subdirectory of the backups directory', () => {
      const root = tempDir();
      const paths = layout(root);
      ensurePrivateFile(paths.dbPath);
      mkdirSync(paths.backupsDir);
      const elsewhere = openFile(join(root, 'not-ours'));
      symlinkSync(elsewhere, join(paths.backupsDir, 'link.db'));
      mkdirSync(join(paths.backupsDir, 'sub'));
      chmodSync(join(paths.backupsDir, 'sub'), 0o755);

      secureDataFiles(paths, vi.fn());

      expect(modeOf(elsewhere)).toBe(0o644);
      expect(modeOf(join(paths.backupsDir, 'sub'))).toBe(0o755);
    });

    it('warns about an open database directory, with the fix, and never changes it', () => {
      const root = tempDir();
      chmodSync(root, 0o755);
      const paths = layout(root);
      ensurePrivateFile(paths.dbPath);
      const warn = vi.fn();

      secureDataFiles(paths, warn);

      expect(modeOf(root)).toBe(0o755);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`chmod 700 ${root}`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mode 755'));
    });
  });

  it('start() tightens an older install before it serves anything', async () => {
    const root = tempDir();
    const dbPath = join(root, 'agent.db');
    openDatabase(dbPath).close();
    chmodSync(dbPath, 0o644);
    const journalPath = openFile(`${dbPath}${RETENTION_JOURNAL_SUFFIX}`);
    mkdirSync(join(root, 'backups'));
    const backup = openFile(join(root, 'backups', 'one.db'));

    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      DASHBOARD_INGEST: '0',
    });
    try {
      expect(modeOf(dbPath)).toBe(0o600);
      expect(modeOf(journalPath)).toBe(0o600);
      expect(modeOf(backup)).toBe(0o600);
      expect(modeOf(join(root, 'backups'))).toBe(0o700);
    } finally {
      await server.close();
    }
  });
});
