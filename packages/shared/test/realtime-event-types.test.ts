/**
 * SERVER_EVENT_TYPES is the one list both the server bridge and the web SSE
 * client import. EventSource silently drops a named event with no registered
 * listener, so an entry missing here is a frame the dashboard never sees -
 * exactly the drift that once shipped (`ingest-failed` published, never
 * heard). These tests pin the list's content; the server side holds its
 * published types equal to it in realtime-event-contract.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentStatusChangedEventSchema,
  SERVER_EVENT_TYPES,
  SessionIngestedEventSchema,
} from '../src/index';

describe('SERVER_EVENT_TYPES', () => {
  it('lists exactly the three published event types, ingest-failed included', () => {
    expect([...SERVER_EVENT_TYPES]).toEqual([
      'session-ingested',
      'agent-status-changed',
      'ingest-failed',
    ]);
  });

  it('holds no duplicates (each name registers one EventSource listener)', () => {
    expect(new Set(SERVER_EVENT_TYPES).size).toBe(SERVER_EVENT_TYPES.length);
  });

  it('covers every literal-typed arm of the RealtimeEvent union', () => {
    // The generic arm carries a free-form `type`; the two literal arms must
    // each appear in the list or their frames are dropped unheard.
    const literalTypes = [
      SessionIngestedEventSchema.properties.type.const,
      AgentStatusChangedEventSchema.properties.type.const,
    ];
    for (const literal of literalTypes) {
      expect(SERVER_EVENT_TYPES).toContain(literal);
    }
  });
});
