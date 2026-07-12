import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTempDb, type TempDb } from './helpers';

describe('events_raw append-only enforcement (WP-D4)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    temp.db
      .prepare(
        `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
         VALUES ('key-1', 'hook', 'PreToolUse', '{"tool":"Read"}', '2026-07-11T00:00:00Z')`,
      )
      .run();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function readRow(): unknown {
    return temp.db.prepare('SELECT * FROM events_raw WHERE idempotency_key = ?').get('key-1');
  }

  it('UPDATE raises and leaves the row byte-identical', () => {
    const before = readRow();
    expect(() =>
      temp.db.prepare("UPDATE events_raw SET payload = '{}' WHERE idempotency_key = 'key-1'").run(),
    ).toThrow(/events_raw is append-only/);
    expect(readRow()).toEqual(before);
  });

  it('DELETE raises and leaves the row byte-identical', () => {
    const before = readRow();
    expect(() =>
      temp.db.prepare("DELETE FROM events_raw WHERE idempotency_key = 'key-1'").run(),
    ).toThrow(/events_raw is append-only/);
    expect(readRow()).toEqual(before);
  });

  it('rejects an unknown source (CHECK constraint)', () => {
    expect(() =>
      temp.db
        .prepare(
          `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
           VALUES ('key-2', 'carrier-pigeon', 'X', '{}', '2026-07-11T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('enforces idempotency_key uniqueness', () => {
    expect(() =>
      temp.db
        .prepare(
          `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
           VALUES ('key-1', 'jsonl', 'Y', '{}', '2026-07-11T00:00:01Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });
});
