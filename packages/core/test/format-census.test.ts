/**
 * Tests for the format-drift census (R13 - ARC-6, QA-3, DAT-7, DAT-11).
 *
 * The census is what turns the parser's silent tolerance into a counted
 * signal: a renamed usage key that would read as zero tokens, a new record
 * type, a torn JSONL line. Each case below is one way upstream drift can
 * under-report dollars while every other test stays green.
 */
import { describe, expect, it } from 'vitest';
import {
  censusFormat,
  KNOWN_RECORD_TYPES,
  MISSING_RECORD_TYPE,
  parseSession,
  SubstrateError,
  UNVERSIONED,
  type SessionSubstrate,
} from '../src/index';
import { getFixture, listFixtures } from '@agenthropic/test-fixtures';

const SESSION = 'cccccccc-1111-4222-8333-444444444444';

function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function substrate(files: Array<{ path: string; lines: string[] }>): SessionSubstrate {
  return { files: files.map((f) => ({ relativePath: f.path, lines: f.lines })) };
}

function user(timestamp: string, extra: Record<string, unknown> = {}): string {
  return jline({ sessionId: SESSION, type: 'user', timestamp, ...extra });
}

function assistant(
  id: string,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  model = 'claude-opus-4-5',
): string {
  return jline({
    sessionId: SESSION,
    type: 'assistant',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { id, model, role: 'assistant', content: [], usage },
    ...extra,
  });
}

const FULL_USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 4,
  cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 },
  service_tier: 'standard',
};

describe('parseSession - format census on a clean substrate', () => {
  it('reports no drift on every shipped fixture', () => {
    for (const name of listFixtures()) {
      const census = parseSession(getFixture(name)).formatCensus;
      expect(census, name).toEqual({ malformedLines: 0, byVersion: {} });
    }
  });

  it('does not count a fully known assistant record', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            user('2026-01-01T00:00:00.000Z', { version: '2.1.80' }),
            assistant('msg_1', FULL_USAGE, { version: '2.1.80' }),
          ],
        },
      ]),
    );
    expect(result.formatCensus).toEqual({ malformedLines: 0, byVersion: {} });
  });
});

describe('parseSession - renamed usage keys raise the counters (QA-3)', () => {
  // The drift scenario of record: upstream renames `input_tokens` to
  // `prompt_tokens`. The parser reads no input bucket - the row prices as
  // zero - and nothing throws. The census must say so.
  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          user('2026-01-01T00:00:00.000Z', { version: '2.2.0' }),
          assistant('msg_1', { prompt_tokens: 10, completion_tokens: 20 }, { version: '2.2.0' }),
          assistant('msg_2', { prompt_tokens: 5, completion_tokens: 6 }, { version: '2.2.0' }),
        ],
      },
    ]),
  );

  it('still parses: the renamed buckets read as zero tokens', () => {
    expect(result.usage).toHaveLength(2);
    expect(result.usage[0]?.usage.input).toBe(0);
  });

  it('counts each unknown key and each all-zero usage block under the version', () => {
    expect(result.formatCensus).toEqual({
      malformedLines: 0,
      byVersion: {
        '2.2.0': {
          unknownRecordTypes: {},
          unknownUsageKeys: { completion_tokens: 2, prompt_tokens: 2 },
          zeroUsageRecords: 2,
        },
      },
    });
  });

  it('counts an unknown nested cache_creation key with its path', () => {
    const nested = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            user('2026-01-01T00:00:00.000Z', { version: '2.2.0' }),
            assistant(
              'msg_1',
              { ...FULL_USAGE, cache_creation: { ephemeral_24h_input_tokens: 7 } },
              { version: '2.2.0' },
            ),
          ],
        },
      ]),
    );
    expect(nested.formatCensus?.byVersion['2.2.0']?.unknownUsageKeys).toEqual({
      'cache_creation.ephemeral_24h_input_tokens': 1,
    });
  });
});

describe('parseSession - zero-usage records', () => {
  it('does not count a <synthetic> record, whose all-zero usage is by design', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            user('2026-01-01T00:00:00.000Z', { version: '2.1.80' }),
            assistant(
              'msg_s',
              { input_tokens: 0, output_tokens: 0 },
              { version: '2.1.80' },
              '<synthetic>',
            ),
          ],
        },
      ]),
    );
    expect(result.formatCensus?.byVersion).toEqual({});
  });

  it('counts a null-bucket usage block as zero and skips an assistant record without usage', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            user('2026-01-01T00:00:00.000Z', { version: '2.1.80' }),
            assistant('msg_n', { input_tokens: null, output_tokens: 0 }, { version: '2.1.80' }),
            jline({
              sessionId: SESSION,
              type: 'assistant',
              timestamp: '2026-01-01T00:00:02.000Z',
              message: { id: 'msg_x', role: 'assistant', content: [] },
            }),
          ],
        },
      ]),
    );
    expect(result.formatCensus?.byVersion['2.1.80']?.zeroUsageRecords).toBe(1);
  });

  it('does not count a usage block with tokens in any single bucket', () => {
    for (const usage of [
      { input_tokens: 1 },
      { output_tokens: 1 },
      { cache_read_input_tokens: 1 },
      { cache_creation_input_tokens: 1 },
      { cache_creation: { ephemeral_5m_input_tokens: 1 } },
      { cache_creation: { ephemeral_1h_input_tokens: 1 } },
    ]) {
      const census = censusFormat(
        [
          {
            isTranscript: true,
            records: [{ type: 'assistant', version: '1', message: { model: 'm', usage } }],
          },
        ],
        0,
      );
      expect(census.byVersion, JSON.stringify(usage)).toEqual({});
    }
  });
});

describe('parseSession - unknown record types and version attribution', () => {
  it('counts unknown and type-less records under the version in force at the record', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            // Before the first version: attributed to the file's first version.
            jline({ sessionId: SESSION, type: 'brand-new-record' }),
            user('2026-01-01T00:00:00.000Z', { version: '2.1.80' }),
            jline({ sessionId: SESSION, type: 'brand-new-record' }),
            user('2026-01-01T00:00:01.000Z', { version: '2.1.81' }),
            // No own version: attributed to the last version seen (2.1.81).
            jline({ sessionId: SESSION, kind: 'no-type-field' }),
            '[1, 2]',
            jline({ sessionId: SESSION, type: 'brand-new-record', version: '2.1.80' }),
          ],
        },
      ]),
    );
    expect(result.formatCensus).toEqual({
      malformedLines: 0,
      byVersion: {
        '2.1.80': {
          unknownRecordTypes: { 'brand-new-record': 3 },
          unknownUsageKeys: {},
          zeroUsageRecords: 0,
        },
        '2.1.81': {
          unknownRecordTypes: { [MISSING_RECORD_TYPE]: 2 },
          unknownUsageKeys: {},
          zeroUsageRecords: 0,
        },
      },
    });
  });

  it('files drift from an unversioned transcript under (none)', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [user('2026-01-01T00:00:00.000Z'), jline({ sessionId: SESSION, type: 'novel' })],
        },
      ]),
    );
    expect(Object.keys(result.formatCensus?.byVersion ?? {})).toEqual([UNVERSIONED]);
  });

  it('censuses agent transcripts but never sidecars or journals', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [user('2026-01-01T00:00:00.000Z', { version: '2.1.80' })],
        },
        {
          path: `${SESSION}/subagents/agent-abcd1234.jsonl`,
          lines: [
            user('2026-01-01T00:00:00.000Z', { agentId: 'abcd1234', version: '2.1.80' }),
            jline({ sessionId: SESSION, agentId: 'abcd1234', type: 'novel' }),
          ],
        },
        {
          path: `${SESSION}/subagents/agent-abcd1234.meta.json`,
          lines: [jline({ agentType: 'general-purpose' })],
        },
        {
          path: `${SESSION}/subagents/workflows/wf_x/journal.jsonl`,
          lines: [jline({ type: 'journal-entry' })],
        },
      ]),
    );
    expect(result.formatCensus?.byVersion).toEqual({
      '2.1.80': { unknownRecordTypes: { novel: 1 }, unknownUsageKeys: {}, zeroUsageRecords: 0 },
    });
  });

  it('knows every type the parser itself reads', () => {
    for (const type of ['assistant', 'user', 'system', 'progress', 'queue-operation']) {
      expect(KNOWN_RECORD_TYPES.has(type), type).toBe(true);
    }
  });
});

describe('parseSession - malformed lines are skipped and counted (DAT-7)', () => {
  it('keeps the session and its usage when one line is torn', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            user('2026-01-01T00:00:00.000Z', { version: '2.1.80' }),
            '{"type": "assistant", "sessionId":', // torn write
            assistant('msg_1', FULL_USAGE, { version: '2.1.80' }),
            '',
          ],
        },
      ]),
    );
    expect(result.sessionId).toBe(SESSION);
    expect(result.usage.map((u) => u.messageId)).toEqual(['msg_1']);
    expect(result.formatCensus).toEqual({ malformedLines: 1, byVersion: {} });
  });

  it('sums malformed lines across every file kind, sidecars included', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [user('2026-01-01T00:00:00.000Z'), 'not json', 'nor this'],
        },
        { path: `${SESSION}/subagents/agent-abcd1234.meta.json`, lines: ['{broken'] },
      ]),
    );
    expect(result.formatCensus?.malformedLines).toBe(3);
  });

  it('still fails loudly when a transcript is nothing but malformed lines', () => {
    const input = substrate([{ path: `${SESSION}.jsonl`, lines: ['not json {'] }]);
    expect(() => parseSession(input)).toThrow(SubstrateError);
  });
});

describe('censusFormat - determinism', () => {
  it('emits versions and keys in sorted order regardless of encounter order', () => {
    const census = censusFormat(
      [
        {
          isTranscript: true,
          records: [
            { type: 'zeta', version: '2.0.0' },
            { type: 'alpha', version: '2.0.0' },
            { type: 'beta', version: '1.0.0' },
          ],
        },
      ],
      0,
    );
    expect(JSON.stringify(census)).toBe(
      JSON.stringify({
        malformedLines: 0,
        byVersion: {
          '1.0.0': { unknownRecordTypes: { beta: 1 }, unknownUsageKeys: {}, zeroUsageRecords: 0 },
          '2.0.0': {
            unknownRecordTypes: { alpha: 1, zeta: 1 },
            unknownUsageKeys: {},
            zeroUsageRecords: 0,
          },
        },
      }),
    );
  });
});
