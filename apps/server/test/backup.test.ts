import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, restoreDatabase } from '../src/db/backup';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { SqliteEventStore } from '../src/db/event-store';

describe('backup + tested restore (WP-F8)', () => {
  let dir: string;
  const openHandles: SqliteDatabase[] = [];

  afterEach(() => {
    for (const db of openHandles.splice(0)) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives the full cycle: write -> backup -> delete original -> restore', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-backup-'));
    const originalPath = join(dir, 'live', 'agent.db');
    const backupPath = join(dir, 'backups', 'agent.backup.db');
    const restorePath = join(dir, 'restored', 'agent.db');

    const db = openDatabase(originalPath);
    openHandles.push(db);
    runMigrations(db);
    const store = new SqliteEventStore(db);
    store.append({
      idempotencyKey: 'k1',
      source: 'hook',
      eventType: 'SessionStart',
      payload: { hello: 'world' },
      receivedAt: '2026-07-11T00:00:00Z',
    });
    store.append({
      idempotencyKey: 'k2',
      source: 'jsonl',
      eventType: 'Stop',
      payload: 42,
      receivedAt: '2026-07-11T00:00:01Z',
    });

    await backupDatabase(db, backupPath);
    expect(existsSync(backupPath)).toBe(true);

    // Destroy the original completely (db file + WAL sidecars).
    db.close();
    rmSync(join(dir, 'live'), { recursive: true, force: true });
    expect(existsSync(originalPath)).toBe(false);

    const restored = restoreDatabase(backupPath, restorePath);
    openHandles.push(restored);

    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(restored.pragma('journal_mode', { simple: true })).toBe('wal');
    const restoredStore = new SqliteEventStore(restored);
    const rows = restoredStore.readAll();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotencyKey)).toEqual(['k1', 'k2']);
    expect(rows[0]?.payload).toEqual({ hello: 'world' });
  });

  it('refuses to restore a corrupt backup', () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-backup-corrupt-'));
    const corruptPath = join(dir, 'corrupt.backup.db');
    // Not a SQLite file at all - opening it must fail loudly.
    writeFileSync(corruptPath, 'this is not a sqlite database, not even close');
    expect(() => restoreDatabase(corruptPath, join(dir, 'restored.db'))).toThrow();
  });

  it('refuses a restore whose file opens cleanly but fails integrity_check', async () => {
    // The harder case than "not a SQLite file at all": the image still has a
    // valid header, so `openDatabase` succeeds and both pragma assertions pass
    // - only `PRAGMA integrity_check` can tell that the b-tree is damaged.
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-backup-integrity-'));
    const backupPath = join(dir, 'backups', 'agent.backup.db');
    const restorePath = join(dir, 'restored', 'agent.db');

    const db = openDatabase(join(dir, 'live', 'agent.db'));
    openHandles.push(db);
    runMigrations(db);
    const store = new SqliteEventStore(db);
    for (let i = 0; i < 400; i += 1) {
      store.append({
        idempotencyKey: `k${String(i)}`,
        source: 'hook',
        eventType: 'Stop',
        payload: { i },
        receivedAt: '2026-07-11T00:00:00Z',
      });
    }
    await backupDatabase(db, backupPath);
    db.close();

    // Wipe the final b-tree page of the backup image. Page 1 (header +
    // sqlite_schema) is untouched, so the file is still openable.
    const image = readFileSync(backupPath);
    const pageSize = image.readUInt16BE(16); // header offset 16: page size
    expect(image.length).toBeGreaterThan(pageSize * 2);
    image.fill(0, image.length - pageSize);
    writeFileSync(backupPath, image);

    expect(() => restoreDatabase(backupPath, restorePath)).toThrow(
      /Restored database failed integrity_check/,
    );

    // The copy DID land - the guard rejects after the file is in place, so the
    // damaged image is still there to inspect...
    expect(existsSync(restorePath)).toBe(true);
    // ...and the rejected handle was closed: SQLite keeps the `-shm` sidecar
    // only for as long as a WAL connection is open.
    expect(existsSync(`${restorePath}-shm`)).toBe(false);

    // Independently confirm both halves of that: opening it ourselves creates
    // the sidecar again, and integrity_check really does not say 'ok'.
    const forensic = openDatabase(restorePath);
    openHandles.push(forensic);
    expect(existsSync(`${restorePath}-shm`)).toBe(true);
    expect(forensic.pragma('integrity_check', { simple: true })).not.toBe('ok');
  });

  it('does not let a stale WAL of the replaced database leak into the restored one', async () => {
    // Review M-4. An in-place restore lands on a path that may still carry the
    // OLD database's `-wal`/`-shm` pair (unclean shutdown). SQLite recovery on
    // the next open would replay those frames INTO the restored image - rows
    // of the database the operator is trying to get rid of.
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-backup-stalewal-'));
    const goodPath = join(dir, 'good', 'agent.db');
    const backupPath = join(dir, 'backups', 'agent.backup.db');
    const livePath = join(dir, 'live', 'agent.db');

    const good = openDatabase(goodPath);
    openHandles.push(good);
    runMigrations(good);
    new SqliteEventStore(good).append({
      idempotencyKey: 'good-row',
      source: 'hook',
      eventType: 'SessionStart',
      payload: 1,
      receivedAt: '2026-07-11T00:00:00Z',
    });
    await backupDatabase(good, backupPath);
    good.close();

    // The live database that the restore will overwrite, with a row the
    // restore must NOT resurrect.
    const live = openDatabase(livePath);
    openHandles.push(live);
    runMigrations(live);
    new SqliteEventStore(live).append({
      idempotencyKey: 'old-only',
      source: 'hook',
      eventType: 'Stop',
      payload: 2,
      receivedAt: '2026-07-11T00:00:01Z',
    });
    // Simulate the unclean shutdown: snapshot the hot sidecars while the
    // connection is open (close() would checkpoint and delete them), then put
    // them back after closing.
    copyFileSync(`${livePath}-wal`, join(dir, 'stale.wal'));
    copyFileSync(`${livePath}-shm`, join(dir, 'stale.shm'));
    live.close();
    copyFileSync(join(dir, 'stale.wal'), `${livePath}-wal`);
    copyFileSync(join(dir, 'stale.shm'), `${livePath}-shm`);
    expect(statSync(`${livePath}-wal`).size).toBeGreaterThan(0);

    const restored = restoreDatabase(backupPath, livePath);
    openHandles.push(restored);
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    const rows = new SqliteEventStore(restored).readAll();
    expect(rows.map((r) => r.idempotencyKey)).toEqual(['good-row']);
  });
});
