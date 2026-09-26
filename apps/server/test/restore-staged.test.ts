/**
 * A restore validates the backup before it touches the destination.
 *
 * `restoreDatabase` used to delete the destination's `-wal` / `-shm` pair,
 * copy the backup over it, and only then run `integrity_check`. A missing or
 * unreadable backup therefore failed after the live WAL was already gone, and
 * a corrupt backup failed after the live file was already overwritten. The
 * restore now copies into a staged file next to the destination, checks it
 * there, and replaces the destination only once the check has passed. When it
 * fails, the destination and its sidecars are exactly as they were, and the
 * staged copy stays behind so it can be inspected.
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDatabase, restoreDatabase, RESTORE_STAGING_SUFFIX } from '../src/db/backup';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { SqliteEventStore } from '../src/db/event-store';
import { runMigrations } from '../src/db/migrations';

describe('restore validates before it replaces', () => {
  let dir: string;
  let livePath: string;
  const openHandles: SqliteDatabase[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-restore-staged-'));
    livePath = join(dir, 'live', 'agent.db');
  });

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

  function open(path: string): SqliteDatabase {
    const db = openDatabase(path);
    openHandles.push(db);
    return db;
  }

  function append(db: SqliteDatabase, key: string): void {
    new SqliteEventStore(db).append({
      idempotencyKey: key,
      source: 'hook',
      eventType: 'Stop',
      payload: key,
      receivedAt: '2026-07-11T00:00:00Z',
    });
  }

  function keys(db: SqliteDatabase): string[] {
    return new SqliteEventStore(db).readAll().map((r) => r.idempotencyKey);
  }

  /** A live database whose last row exists only in its `-wal`, as after a crash. */
  function liveWithHotWal(): void {
    const live = open(livePath);
    runMigrations(live);
    append(live, 'checkpointed');
    live.pragma('wal_checkpoint(TRUNCATE)');
    live.pragma('wal_autocheckpoint = 0');
    append(live, 'wal-only');
    copyFileSync(`${livePath}-wal`, join(dir, 'hot.wal'));
    copyFileSync(`${livePath}-shm`, join(dir, 'hot.shm'));
    live.close();
    copyFileSync(join(dir, 'hot.wal'), `${livePath}-wal`);
    copyFileSync(join(dir, 'hot.shm'), `${livePath}-shm`);
  }

  async function corruptBackup(): Promise<string> {
    const backupPath = join(dir, 'backups', 'bad.db');
    const src = open(join(dir, 'src', 'agent.db'));
    runMigrations(src);
    for (let i = 0; i < 400; i += 1) {
      append(src, `k${String(i)}`);
    }
    await backupDatabase(src, backupPath);
    const image = readFileSync(backupPath);
    image.fill(0, image.length - image.readUInt16BE(16));
    writeFileSync(backupPath, image);
    return backupPath;
  }

  it('keeps the live WAL when the backup does not exist', () => {
    liveWithHotWal();
    const walBefore = readFileSync(`${livePath}-wal`);

    expect(() => restoreDatabase(join(dir, 'missing.db'), livePath)).toThrow();

    expect(readFileSync(`${livePath}-wal`)).toEqual(walBefore);
    expect(keys(open(livePath))).toEqual(['checkpointed', 'wal-only']);
  });

  it('leaves the live file and its WAL untouched when the backup is corrupt', async () => {
    liveWithHotWal();
    const backupPath = await corruptBackup();
    const fileBefore = readFileSync(livePath);
    const walBefore = readFileSync(`${livePath}-wal`);

    expect(() => restoreDatabase(backupPath, livePath)).toThrow(
      /Restored database failed integrity_check/,
    );

    expect(readFileSync(livePath)).toEqual(fileBefore);
    expect(readFileSync(`${livePath}-wal`)).toEqual(walBefore);
    expect(existsSync(`${livePath}${RESTORE_STAGING_SUFFIX}`)).toBe(true);
    expect(keys(open(livePath))).toEqual(['checkpointed', 'wal-only']);
    // Two migrated databases, 400 appends, a backup and an integrity_check take
    // about 3 s on their own and brushed the 5 s default under coverage load
    // (observed 2026-09-25); the case does real work, it does not hang.
  }, 20_000);

  it('replaces the destination and removes the staged file on success', async () => {
    const good = open(join(dir, 'good', 'agent.db'));
    runMigrations(good);
    append(good, 'good-row');
    const backupPath = join(dir, 'backups', 'good.db');
    await backupDatabase(good, backupPath);
    liveWithHotWal();

    const restored = restoreDatabase(backupPath, livePath);
    openHandles.push(restored);

    expect(keys(restored)).toEqual(['good-row']);
    expect(existsSync(`${livePath}${RESTORE_STAGING_SUFFIX}`)).toBe(false);
  });

  it('overwrites a staged file left by an earlier failed restore', async () => {
    const good = open(join(dir, 'good', 'agent.db'));
    runMigrations(good);
    append(good, 'good-row');
    const backupPath = join(dir, 'backups', 'good.db');
    await backupDatabase(good, backupPath);
    const staged = `${livePath}${RESTORE_STAGING_SUFFIX}`;
    open(livePath).close();
    writeFileSync(staged, 'leftover garbage from a failed restore');

    const restored = restoreDatabase(backupPath, livePath);
    openHandles.push(restored);

    expect(keys(restored)).toEqual(['good-row']);
    expect(existsSync(staged)).toBe(false);
  });
});
