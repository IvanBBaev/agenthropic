import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawEventEnvelope } from '@agenthropic/shared';
import { SqliteEventStore } from '../src/db/event-store';
import { createMigratedTempDb, type TempDb } from './helpers';

describe('SqliteEventStore (WP-D4 / EventStorePort)', () => {
  let temp: TempDb;
  let store: SqliteEventStore;

  const envelope: RawEventEnvelope = {
    idempotencyKey: 'hook:sess-1:PreToolUse:001',
    source: 'hook',
    eventType: 'PreToolUse',
    payload: { tool: 'Read', sessionId: 'sess-1' },
    receivedAt: '2026-07-11T10:00:00Z',
  };

  beforeEach(() => {
    temp = createMigratedTempDb();
    store = new SqliteEventStore(temp.db);
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('appends an envelope and reports inserted=true', () => {
    expect(store.append(envelope)).toEqual({ inserted: true });
    const count = temp.db.prepare('SELECT COUNT(*) AS n FROM events_raw').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('appending the same envelope twice yields exactly one row (idempotent)', () => {
    expect(store.append(envelope)).toEqual({ inserted: true });
    expect(store.append(envelope)).toEqual({ inserted: false });
    const count = temp.db.prepare('SELECT COUNT(*) AS n FROM events_raw').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('readAll returns envelopes in append order with parsed payloads', () => {
    const second: RawEventEnvelope = {
      ...envelope,
      idempotencyKey: 'jsonl:sess-1:line:42',
      source: 'jsonl',
      eventType: 'Stop',
      payload: ['a', 1, null],
      receivedAt: '2026-07-11T10:00:01Z',
    };
    store.append(envelope);
    store.append(second);
    store.append(envelope); // idempotent no-op

    expect(store.readAll()).toEqual([envelope, second]);
  });
});
