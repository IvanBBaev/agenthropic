/**
 * A PRESENT but non-numeric token field (`"input_tokens": "1200"`) must be a
 * loud failure, never silently counted as zero tokens / $0. Absent and `null`
 * fields stay zero - the API legitimately omits or nulls the cache buckets.
 */
import { describe, expect, it } from 'vitest';
import { parseSession, UsageConflictError, type SessionSubstrate } from '../src/index';

function sessionWithUsage(usage: Record<string, unknown>): SessionSubstrate {
  return {
    files: [
      {
        relativePath: 'session.jsonl',
        lines: [
          JSON.stringify({ sessionId: 's', type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }),
          JSON.stringify({
            sessionId: 's',
            type: 'assistant',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: { id: 'm_1', model: 'm', usage },
          }),
        ],
      },
    ],
  };
}

describe('usage bucket mapping refuses non-numeric token counts', () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ['input_tokens as a string', { input_tokens: '1200', output_tokens: 5 }],
    ['output_tokens as a boolean', { input_tokens: 1, output_tokens: true }],
    ['cache_read_input_tokens as an object', { cache_read_input_tokens: { n: 3 } }],
    ['flat cache_creation_input_tokens as a string', { cache_creation_input_tokens: '9' }],
    [
      'nested ephemeral_5m_input_tokens as a string',
      { cache_creation: { ephemeral_5m_input_tokens: '9', ephemeral_1h_input_tokens: 0 } },
    ],
    [
      'nested ephemeral_1h_input_tokens as a string',
      { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: '9' } },
    ],
  ];

  for (const [label, usage] of malformed) {
    it(`throws on ${label}`, () => {
      expect(() => parseSession(sessionWithUsage(usage))).toThrow(UsageConflictError);
    });
  }

  it('keeps absent and null buckets at zero', () => {
    const result = parseSession(
      sessionWithUsage({
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: null,
        cache_creation: { ephemeral_5m_input_tokens: null },
      }),
    );
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    });
  });
});
