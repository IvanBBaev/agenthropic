/**
 * NN1 / NN2 — usage the parser used to lose without a trace.
 *
 * NN2: a `cache_creation` breakdown that is empty or covers only part of the
 * flat `cache_creation_input_tokens` total used to REPLACE the flat total, so
 * the uncovered tokens vanished. The fallback keeps every token: the part the
 * breakdown does not account for lands in the unsplit bucket (`cacheWrite5m`,
 * the API's default TTL — the same bucket a flat-only record has always used),
 * and no split is ever invented.
 *
 * NN1: an assistant record with a `usage` block but no string `message.id`
 * cannot be deduplicated (streamed partials share the id), so it is still
 * EXCLUDED from the ledger — but it is now COUNTED, never silently skipped.
 */
import { describe, expect, it } from 'vitest';
import { parseSession, UsageConflictError, type SessionSubstrate } from '../src/index';

const SESSION = 'abcdabcd-0000-4000-8000-000000000012';

function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function mainOnly(lines: string[]): SessionSubstrate {
  return {
    files: [
      {
        relativePath: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-09-01T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
          ...lines,
        ],
      },
    ],
  };
}

function assistant(message: Record<string, unknown>, second = 1): string {
  return jline({
    sessionId: SESSION,
    type: 'assistant',
    timestamp: `2026-09-01T00:00:${String(second).padStart(2, '0')}.000Z`,
    message,
  });
}

function bucketsOf(usage: Record<string, unknown>) {
  const result = parseSession(mainOnly([assistant({ id: 'm1', model: 'm', usage })]));
  return result.usage[0]?.usage;
}

describe('NN2 — cache_creation breakdown falls back to the flat total', () => {
  it('an EMPTY breakdown keeps the whole flat total in the unsplit bucket', () => {
    expect(bucketsOf({ cache_creation_input_tokens: 100, cache_creation: {} })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 100,
      cacheWrite1h: 0,
    });
  });

  it('a PARTIAL breakdown keeps the known split and puts only the remainder in the unsplit bucket', () => {
    expect(
      bucketsOf({
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 30 },
      }),
    ).toMatchObject({ cacheWrite5m: 70, cacheWrite1h: 30 });
    expect(
      bucketsOf({
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 25, ephemeral_1h_input_tokens: null },
      }),
    ).toMatchObject({ cacheWrite5m: 100, cacheWrite1h: 0 });
  });

  it('a COMPLETE breakdown is used exactly as written', () => {
    expect(
      bucketsOf({
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
      }),
    ).toMatchObject({ cacheWrite5m: 60, cacheWrite1h: 40 });
  });

  it('a breakdown LARGER than the flat total is kept verbatim — tokens are never subtracted', () => {
    expect(
      bucketsOf({
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
      }),
    ).toMatchObject({ cacheWrite5m: 60, cacheWrite1h: 40 });
  });

  it('a breakdown with no flat total at all is used as written', () => {
    expect(bucketsOf({ cache_creation: { ephemeral_1h_input_tokens: 7 } })).toMatchObject({
      cacheWrite5m: 0,
      cacheWrite1h: 7,
    });
  });

  it('a non-numeric flat total beside a breakdown is not trusted over the breakdown', () => {
    expect(
      bucketsOf({
        cache_creation_input_tokens: 'lots',
        cache_creation: { ephemeral_1h_input_tokens: 7 },
      }),
    ).toMatchObject({ cacheWrite5m: 0, cacheWrite1h: 7 });
  });

  it('a non-numeric breakdown value still fails loudly (no fallback hides it)', () => {
    expect(() =>
      parseSession(
        mainOnly([
          assistant({
            id: 'm1',
            model: 'm',
            usage: {
              cache_creation_input_tokens: 100,
              cache_creation: { ephemeral_5m_input_tokens: 'x' },
            },
          }),
        ]),
      ),
    ).toThrow(UsageConflictError);
  });
});

describe('NN1 — usage records without a message.id are counted, not silently skipped', () => {
  it('counts every assistant record that carries usage but no string message.id', () => {
    const result = parseSession(
      mainOnly([
        assistant({ id: 'kept', model: 'm', usage: { input_tokens: 1 } }, 1),
        // Two streamed partials of the same id-less message: each is a record
        // that could not be deduplicated, so each is counted.
        assistant({ model: 'm', usage: { input_tokens: 9, output_tokens: 1 } }, 2),
        assistant({ model: 'm', usage: { input_tokens: 9, output_tokens: 5 } }, 3),
        // A non-string id is no id.
        assistant({ id: 42, model: 'm', usage: { input_tokens: 3 } }, 4),
        // No usage block at all: nothing was dropped, nothing is counted.
        assistant({ model: 'm', content: [{ type: 'text', text: 'x' }] }, 5),
        // A usage-looking block on a non-assistant record is not usage.
        jline({
          sessionId: SESSION,
          type: 'user',
          timestamp: '2026-09-01T00:00:06.000Z',
          message: { usage: { input_tokens: 4 } },
        }),
      ]),
    );
    expect(result.usage.map((u) => u.messageId)).toEqual(['kept']);
    expect(result.usageRecordsDropped).toBe(3);
  });

  it('counts dropped records in subagent transcripts too', () => {
    const hex = 'a0000000000000012';
    const result = parseSession({
      files: [
        ...mainOnly([]).files,
        {
          relativePath: `${SESSION}/subagents/agent-${hex}.jsonl`,
          lines: [
            jline({
              sessionId: SESSION,
              agentId: hex,
              type: 'assistant',
              timestamp: '2026-09-01T00:00:07.000Z',
              message: { model: 'm', usage: { input_tokens: 2 } },
            }),
          ],
        },
      ],
    });
    expect(result.usageRecordsDropped).toBe(1);
  });

  it('is zero — present, not absent — when nothing was dropped', () => {
    const result = parseSession(
      mainOnly([assistant({ id: 'kept', model: 'm', usage: { input_tokens: 1 } })]),
    );
    expect(result.usageRecordsDropped).toBe(0);
  });
});
