/**
 * DAT-10 - reading Claude Code's `cost-state` records. The record is advisory
 * evidence for the pricing drift check, so the reader must be tolerant (a bad
 * record is skipped and counted, never thrown) and deterministic (the snapshot
 * is stored as JSON and must serialize identically on a replay).
 */
import { describe, expect, it } from 'vitest';
import { extractCostState, parseSession, type SessionSubstrate } from '../src/index';
import { getFixture, listFixtures } from '@agenthropic/test-fixtures';

const SESSION = 'dddddddd-1111-4222-8333-444444444444';
const AGENT_HEX = 'a1b2c3d4e5f60718';

function modelUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: 30,
    cacheCreationInputTokens: 40,
    cacheCreationEphemeral5mInputTokens: 25,
    cacheCreationEphemeral1hInputTokens: 15,
    thinkingTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.5,
    ...overrides,
  };
}

function costState(
  usage: Record<string, unknown> = { 'claude-sonnet-5': modelUsage() },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'cost-state',
    sessionId: SESSION,
    totalCostUSD: 0.5,
    totalAPIDuration: 1000,
    startTime: 1_790_000_000_000,
    hasUnknownModelCost: false,
    modelUsage: usage,
    ...overrides,
  };
}

const EXPECTED_SONNET = {
  model: 'claude-sonnet-5',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadInputTokens: 30,
  cacheCreationInputTokens: 40,
  cacheCreation5mInputTokens: 25,
  cacheCreation1hInputTokens: 15,
  webSearchRequests: 0,
  costUsd: 0.5,
};

describe('extractCostState', () => {
  it('returns null when the transcript has no cost-state record', () => {
    expect(extractCostState([])).toBeNull();
    expect(extractCostState([{ type: 'user' }, null, 'text', [1]])).toBeNull();
  });

  it('normalizes a well-formed record and drops the fields it does not use', () => {
    expect(extractCostState([costState()])).toEqual({
      records: 1,
      malformedRecords: 0,
      latest: { totalCostUsd: 0.5, hasUnknownModelCost: false, models: [EXPECTED_SONNET] },
    });
  });

  it('keeps the LAST valid record - the record is cumulative', () => {
    const result = extractCostState([
      costState(undefined, { totalCostUSD: 0.1 }),
      { type: 'assistant' },
      costState(undefined, { totalCostUSD: 0.7 }),
    ]);
    expect(result?.records).toBe(2);
    expect(result?.latest?.totalCostUsd).toBe(0.7);
  });

  it('sorts models by id so the stored JSON is deterministic', () => {
    const result = extractCostState([
      costState({ 'claude-sonnet-5': modelUsage(), 'claude-haiku-5': modelUsage() }),
    ]);
    expect(result?.latest?.models.map((m) => m.model)).toEqual([
      'claude-haiku-5',
      'claude-sonnet-5',
    ]);
    const reversed = extractCostState([
      costState({ 'claude-haiku-5': modelUsage(), 'claude-sonnet-5': modelUsage() }),
    ]);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(result));
  });

  it('reads absent optional fields as unsplit cache writes, no web search and a known cost', () => {
    const usage = modelUsage();
    delete usage['cacheCreationEphemeral5mInputTokens'];
    delete usage['cacheCreationEphemeral1hInputTokens'];
    delete usage['webSearchRequests'];
    const record = costState({ 'claude-sonnet-5': usage });
    delete record['hasUnknownModelCost'];
    expect(extractCostState([record])?.latest).toEqual({
      totalCostUsd: 0.5,
      hasUnknownModelCost: false,
      models: [
        {
          ...EXPECTED_SONNET,
          cacheCreation5mInputTokens: null,
          cacheCreation1hInputTokens: null,
          webSearchRequests: 0,
        },
      ],
    });
  });

  it('accepts an integer dollar figure and an empty modelUsage map', () => {
    const result = extractCostState([
      costState({}, { totalCostUSD: 0, hasUnknownModelCost: true }),
    ]);
    expect(result?.latest).toEqual({ totalCostUsd: 0, hasUnknownModelCost: true, models: [] });
  });

  it.each([
    ['a missing total', { totalCostUSD: undefined }],
    ['a negative total', { totalCostUSD: -1 }],
    ['a non-finite total', { totalCostUSD: Number.POSITIVE_INFINITY }],
    ['a string total', { totalCostUSD: '0.5' }],
    ['a non-boolean unknown-cost flag', { hasUnknownModelCost: 'no' }],
    ['a missing modelUsage map', { modelUsage: undefined }],
    ['an array modelUsage', { modelUsage: [] }],
  ])('skips and counts a record with %s', (_label, overrides) => {
    const result = extractCostState([costState(undefined, overrides)]);
    expect(result).toEqual({ records: 0, malformedRecords: 1, latest: null });
  });

  it.each([
    ['a non-object entry', 42],
    ['a missing input count', modelUsage({ inputTokens: undefined })],
    ['a fractional output count', modelUsage({ outputTokens: 1.5 })],
    ['a negative cache-read count', modelUsage({ cacheReadInputTokens: -1 })],
    ['a string cache-write count', modelUsage({ cacheCreationInputTokens: '40' })],
    ['a negative cost', modelUsage({ costUSD: -0.01 })],
    ['a bad 5m split', modelUsage({ cacheCreationEphemeral5mInputTokens: 'x' })],
    ['a bad 1h split', modelUsage({ cacheCreationEphemeral1hInputTokens: -2 })],
    ['a bad web-search count', modelUsage({ webSearchRequests: 0.5 })],
  ])('skips the whole record when one model has %s', (_label, entry) => {
    const result = extractCostState([
      costState({ 'claude-haiku-5': modelUsage(), 'claude-sonnet-5': entry }),
    ]);
    expect(result).toEqual({ records: 0, malformedRecords: 1, latest: null });
  });

  it('keeps the last VALID record when a later one is malformed', () => {
    const result = extractCostState([costState(), costState(undefined, { totalCostUSD: -1 })]);
    expect(result).toEqual({
      records: 1,
      malformedRecords: 1,
      latest: { totalCostUsd: 0.5, hasUnknownModelCost: false, models: [EXPECTED_SONNET] },
    });
  });
});

function substrate(files: Array<{ path: string; records: unknown[] }>): SessionSubstrate {
  return {
    files: files.map((f) => ({
      relativePath: f.path,
      lines: f.records.map((r) => JSON.stringify(r)),
    })),
  };
}

const USER = { type: 'user', sessionId: SESSION, timestamp: '2026-01-01T00:00:00.000Z' };

describe('parseSession - costState', () => {
  it('is null on every shipped fixture (none carries a cost-state record)', () => {
    for (const name of listFixtures()) {
      expect(parseSession(getFixture(name)).costState, name).toBeNull();
    }
  });

  it('reads the cost-state of the main transcript', () => {
    const parsed = parseSession(
      substrate([{ path: `${SESSION}.jsonl`, records: [USER, costState()] }]),
    );
    expect(parsed.costState?.latest?.models).toEqual([EXPECTED_SONNET]);
  });

  it('ignores a cost-state record inside a subagent transcript', () => {
    const parsed = parseSession(
      substrate([
        { path: `${SESSION}.jsonl`, records: [USER] },
        {
          path: `${SESSION}/subagents/agent-${AGENT_HEX}.jsonl`,
          records: [{ ...USER, agentId: AGENT_HEX }, costState()],
        },
      ]),
    );
    expect(parsed.costState).toBeNull();
  });

  it('is null when only subagent transcripts were read (no main)', () => {
    const parsed = parseSession(
      substrate([
        {
          path: `${SESSION}/subagents/agent-${AGENT_HEX}.jsonl`,
          records: [{ ...USER, agentId: AGENT_HEX }],
        },
      ]),
    );
    expect(parsed.costState).toBeNull();
  });
});
