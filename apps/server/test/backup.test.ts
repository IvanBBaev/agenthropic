import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
