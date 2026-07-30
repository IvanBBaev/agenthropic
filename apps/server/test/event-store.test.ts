import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawEventEnvelope } from '@agenthropic/shared';
import { SqliteEventStore, extractLivenessIds } from '../src/db/event-store';
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

  describe('events projection (WP-D5 - liveness only, never structure)', () => {
    interface EventRow {
      readonly id: number;
      readonly raw_event_id: number;
      readonly session_id: string | null;
      readonly agent_id: string | null;
      readonly event_type: string | null;
      readonly occurred_at: string | null;
    }

    const countRows = (table: 'events' | 'events_raw'): number =>
      (temp.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    const allEvents = (): EventRow[] =>
      temp.db
        .prepare(
          'SELECT id, raw_event_id, session_id, agent_id, event_type, occurred_at FROM events ORDER BY id',
        )
        .all() as EventRow[];

    it('a hook append projects exactly one normalized row pointing at its raw row', () => {
      const hook: RawEventEnvelope = {
        ...envelope,
        payload: { hook_event_name: 'PreToolUse', session_id: 'sess-1', agent_id: 'agent-9' },
      };
      expect(store.append(hook)).toEqual({ inserted: true });
      const rawId = (
        temp.db
          .prepare('SELECT id FROM events_raw WHERE idempotency_key = ?')
          .get(hook.idempotencyKey) as { id: number }
      ).id;
      expect(allEvents()).toEqual([
        {
          id: 1,
          raw_event_id: rawId,
          session_id: 'sess-1',
          agent_id: 'agent-9',
          event_type: 'PreToolUse',
          occurred_at: hook.receivedAt,
        },
      ]);
    });

    it('a duplicate envelope produces ZERO new rows in BOTH tables', () => {
      expect(store.append(envelope)).toEqual({ inserted: true });
      expect(store.append(envelope)).toEqual({ inserted: false });
      expect(countRows('events_raw')).toBe(1);
      expect(countRows('events')).toBe(1);
    });

    it('a jsonl-source envelope is stored raw but never projected (hook timeline only)', () => {
      const jsonl: RawEventEnvelope = {
        ...envelope,
        idempotencyKey: 'jsonl:sess-1:line:1',
        source: 'jsonl',
      };
      expect(store.append(jsonl)).toEqual({ inserted: true });
      expect(countRows('events_raw')).toBe(1);
      expect(countRows('events')).toBe(0);
    });

    it('occurred_at is ALWAYS receipt time - a payload "timestamp" field is never read', () => {
      // The observable fallback rule: the envelope contract carries no
      // event-originated time, so even a plausible-looking payload timestamp
      // must not leak into occurred_at.
      const withTimestamp: RawEventEnvelope = {
        ...envelope,
        payload: { session_id: 'sess-1', timestamp: '1999-01-01T00:00:00Z' },
      };
      store.append(withTimestamp);
      expect(allEvents()[0]?.occurred_at).toBe(withTimestamp.receivedAt);
    });

    it('never throws on hostile payload shapes - unrecognized ids project as NULL', () => {
      const shapes: readonly unknown[] = [
        null,
        'just a string',
        42,
        true,
        ['session_id', 'sess-1'],
        { session_id: 42, agent_id: true }, // wrong types: never coerced
        { session_id: '', agentId: '' }, // empty strings do not count
        { nested: { session_id: 'deep' } }, // only top-level keys are read
      ];
      shapes.forEach((payload, index) => {
        expect(
          store.append({
            ...envelope,
            idempotencyKey: `hook:hostile:${index}`,
            payload,
          }),
        ).toEqual({ inserted: true });
      });
      const rows = allEvents();
      expect(rows).toHaveLength(shapes.length);
      for (const row of rows) {
        expect(row.session_id).toBeNull();
        expect(row.agent_id).toBeNull();
      }
    });

    it('snake_case ids win over the camelCase courtesy variants', () => {
      store.append({
        ...envelope,
        idempotencyKey: 'hook:precedence:1',
        payload: {
          session_id: 'snake-session',
          sessionId: 'camel-session',
          agentId: 'camel-agent', // only the courtesy variant present
        },
      });
      expect(allEvents()[0]).toMatchObject({
        session_id: 'snake-session',
        agent_id: 'camel-agent',
      });
    });

    it('raw append and projection are ONE transaction - a projection failure rolls back both', () => {
      temp.db.exec('DROP TABLE events');
      expect(() => store.append(envelope)).toThrow();
      expect(countRows('events_raw')).toBe(0);
    });
  });
});

describe('extractLivenessIds (total over any payload shape)', () => {
  it('extracts non-empty string ids from a plain object only', () => {
    expect(extractLivenessIds({ session_id: 's1', agent_id: 'a1' })).toEqual({
      sessionId: 's1',
      agentId: 'a1',
    });
    expect(extractLivenessIds({ sessionId: 's1' })).toEqual({ sessionId: 's1', agentId: null });
    expect(extractLivenessIds({})).toEqual({ sessionId: null, agentId: null });
    expect(extractLivenessIds([])).toEqual({ sessionId: null, agentId: null });
    expect(extractLivenessIds(null)).toEqual({ sessionId: null, agentId: null });
    expect(extractLivenessIds(undefined)).toEqual({ sessionId: null, agentId: null });
    expect(extractLivenessIds('sess-1')).toEqual({ sessionId: null, agentId: null });
  });

  it('never coerces non-string ids', () => {
    expect(extractLivenessIds({ session_id: 7, agent_id: { id: 'a' } })).toEqual({
      sessionId: null,
      agentId: null,
    });
  });
});
