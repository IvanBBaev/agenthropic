import { describe, expect, it } from 'vitest';
import { InMemoryEventStore, type RawEventEnvelope } from '../src/index';

function envelope(overrides: Partial<RawEventEnvelope> = {}): RawEventEnvelope {
  return {
    idempotencyKey: 'key-1',
    source: 'hook',
    eventType: 'PreToolUse',
    payload: { tool: 'Read' },
    receivedAt: '2026-07-11T10:00:00.000Z',
    ...overrides,
  };
}

describe('InMemoryEventStore', () => {
  it('inserts a new envelope and reports inserted: true', () => {
    const store = new InMemoryEventStore();
    expect(store.append(envelope())).toEqual({ inserted: true });
    expect(store.readAll()).toHaveLength(1);
  });

  it('is idempotent by idempotencyKey: duplicate append reports inserted: false', () => {
    const store = new InMemoryEventStore();
    store.append(envelope());
    const result = store.append(envelope({ eventType: 'PostToolUse' }));
    expect(result).toEqual({ inserted: false });
    expect(store.readAll()).toHaveLength(1);
  });

  it('keeps the first envelope on duplicate append (append-only, no update)', () => {
    const store = new InMemoryEventStore();
    store.append(envelope({ eventType: 'PreToolUse' }));
    store.append(envelope({ eventType: 'PostToolUse' }));
    expect(store.readAll()[0]?.eventType).toBe('PreToolUse');
  });

  it('stores envelopes with distinct keys separately, in append order', () => {
    const store = new InMemoryEventStore();
    store.append(envelope({ idempotencyKey: 'key-1', eventType: 'SubagentStart' }));
    store.append(envelope({ idempotencyKey: 'key-2', eventType: 'SubagentStop' }));
    const all = store.readAll();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.eventType)).toEqual(['SubagentStart', 'SubagentStop']);
  });

  it('readAll returns a snapshot, not live internal state', () => {
    const store = new InMemoryEventStore();
    store.append(envelope());
    const before = store.readAll();
    store.append(envelope({ idempotencyKey: 'key-2' }));
    expect(before).toHaveLength(1);
    expect(store.readAll()).toHaveLength(2);
  });

  it('supports both raw-event sources', () => {
    const store = new InMemoryEventStore();
    store.append(envelope({ idempotencyKey: 'hook-1', source: 'hook' }));
    store.append(envelope({ idempotencyKey: 'jsonl-1', source: 'jsonl' }));
    expect(store.readAll().map((e) => e.source)).toEqual(['hook', 'jsonl']);
  });
});
