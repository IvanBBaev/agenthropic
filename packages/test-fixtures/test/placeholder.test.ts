import { describe, expect, it } from 'vitest';
import { makeRawEventEnvelope } from '../src/index';

describe('makeRawEventEnvelope', () => {
  it('builds a valid envelope with defaults', () => {
    const envelope = makeRawEventEnvelope();
    expect(envelope.idempotencyKey).toBe('fixture-key-1');
    expect(envelope.source).toBe('hook');
  });

  it('applies overrides', () => {
    const envelope = makeRawEventEnvelope({ source: 'jsonl', eventType: 'assistant' });
    expect(envelope.source).toBe('jsonl');
    expect(envelope.eventType).toBe('assistant');
  });
});
