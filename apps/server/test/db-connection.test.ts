import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertConnectionPragmas, openDatabase, type SqliteDatabase } from '../src/db/connection';

describe('openDatabase (WP-D2)', () => {
  let dir: string;
  let db: SqliteDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the parent directory and opens in WAL mode with foreign keys ON', () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-conn-'));
    const nested = join(dir, 'deep', 'nested', 'agent.db');
    expect(existsSync(join(dir, 'deep'))).toBe(false);

    db = openDatabase(nested);

    expect(existsSync(nested)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('assertConnectionPragmas', () => {
  it('accepts wal + enforced foreign keys', () => {
    expect(() => assertConnectionPragmas('wal', 1)).not.toThrow();
  });

  it('rejects a non-WAL journal mode', () => {
    expect(() => assertConnectionPragmas('delete', 1)).toThrow(/not in WAL mode/);
  });

  it('rejects disabled foreign keys', () => {
    expect(() => assertConnectionPragmas('wal', 0)).toThrow(/foreign_keys/);
  });
});
