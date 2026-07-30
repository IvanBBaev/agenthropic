import { describe, expect, it } from 'vitest';
import { dedupeUsageByMessageId, UsageConflictError } from '../src/index';
import type { TokenBuckets, UsageRow } from '../src/index';

const USAGE_A: TokenBuckets = {
  input: 100,
  output: 20,
  cacheRead: 5000,
  cacheWrite5m: 300,
  cacheWrite1h: 0,
};

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    messageId: 'msg_001',
    model: 'claude-sonnet-5',
    timestamp: '2026-07-10T12:00:00.000Z',
    usage: { ...USAGE_A },
    ...overrides,
  };
}

describe('dedupeUsageByMessageId', () => {
  it('returns an empty array for empty input', () => {
    expect(dedupeUsageByMessageId([])).toEqual([]);
  });

  it('collapses rows sharing a messageId into one entry (one line per content block)', () => {
    const rows = [row(), row(), row()];
    const deduped = dedupeUsageByMessageId(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toEqual({
      messageId: 'msg_001',
      model: 'claude-sonnet-5',
      timestamp: '2026-07-10T12:00:00.000Z',
      usage: USAGE_A,
      agentId: null,
    });
  });

  it('keeps distinct messageIds separate, preserving first-seen order', () => {
    const rows = [
      row({ messageId: 'msg_b' }),
      row({ messageId: 'msg_a' }),
      row({ messageId: 'msg_b' }),
      row({ messageId: 'msg_c' }),
    ];
    const deduped = dedupeUsageByMessageId(rows);
    expect(deduped.map((d) => d.messageId)).toEqual(['msg_b', 'msg_a', 'msg_c']);
  });

  it('keeps the first row timestamp for duplicated messages', () => {
    const rows = [
      row({ timestamp: '2026-07-10T12:00:00.000Z' }),
      row({ timestamp: '2026-07-10T12:00:00.250Z' }),
    ];
    const deduped = dedupeUsageByMessageId(rows);
    expect(deduped[0]?.timestamp).toBe('2026-07-10T12:00:00.000Z');
  });

  it('normalizes an undefined agentId to null and matches an explicit null duplicate', () => {
    const deduped = dedupeUsageByMessageId([row(), row({ agentId: null })]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.agentId).toBeNull();
  });

  it('carries the inline agentId through (hard attribution key, parser-spec 5.1)', () => {
    const deduped = dedupeUsageByMessageId([
      row({ agentId: 'a1b2c3' }),
      row({ agentId: 'a1b2c3' }),
    ]);
    expect(deduped[0]?.agentId).toBe('a1b2c3');
  });

  it('copies the usage block instead of aliasing the input row', () => {
    const input = row();
    const deduped = dedupeUsageByMessageId([input]);
    input.usage.input = 999_999;
    expect(deduped[0]?.usage.input).toBe(100);
  });

  it('over-count demonstration: 6 raw lines across 2 messages dedupe to 2 entries', () => {
    const rows = [
      row({ messageId: 'm1' }),
      row({ messageId: 'm1' }),
      row({ messageId: 'm1' }),
      row({ messageId: 'm2', usage: { ...USAGE_A, output: 40 } }),
      row({ messageId: 'm2', usage: { ...USAGE_A, output: 40 } }),
      row({ messageId: 'm2', usage: { ...USAGE_A, output: 40 } }),
    ];
    const deduped = dedupeUsageByMessageId(rows);
    const totalOutput = deduped.reduce((sum, d) => sum + d.usage.output, 0);
    expect(deduped).toHaveLength(2);
    expect(totalOutput).toBe(60); // naive summation would report 180 (3x)
  });

  it('collapses streamed partials to the per-bucket maximum (final complete usage)', () => {
    // Real transcripts stream one message across rows: input/cache constant,
    // output_tokens growing to the final total. Dedup keeps the max per bucket.
    const rows = [
      row({ usage: { ...USAGE_A, output: 7 } }),
      row({ usage: { ...USAGE_A, output: 7 } }),
      row({ usage: { ...USAGE_A, output: 310 } }),
    ];
    const deduped = dedupeUsageByMessageId(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.usage.output).toBe(310);
    expect(deduped[0]?.usage.input).toBe(USAGE_A.input);
    expect(deduped[0]?.usage.cacheRead).toBe(USAGE_A.cacheRead);
  });

  it('takes the maximum regardless of row order (order-independent collapse)', () => {
    const rows = [
      row({ usage: { ...USAGE_A, output: 310 } }),
      row({ usage: { ...USAGE_A, output: 7 } }),
    ];
    const deduped = dedupeUsageByMessageId(rows);
    expect(deduped[0]?.usage.output).toBe(310);
  });

  it('settles the model to the greatest-output row (transient fast-mode label on the first partial)', () => {
    // Real streaming: the first partial can carry a transient routing label
    // (claude-fable-5) that settles to the real model (claude-opus-4-8) on every
    // later partial. The greatest-output (final) row is authoritative.
    const rows = [
      row({ model: 'claude-fable-5', usage: { ...USAGE_A, output: 2 } }),
      row({ model: 'claude-opus-4-8', usage: { ...USAGE_A, output: 2 } }),
      row({ model: 'claude-opus-4-8', usage: { ...USAGE_A, output: 6747 } }),
    ];
    const deduped = dedupeUsageByMessageId(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.model).toBe('claude-opus-4-8');
    expect(deduped[0]?.usage.output).toBe(6747);
  });

  it('settles the model regardless of row order (the final row can arrive first)', () => {
    const rows = [
      row({ model: 'claude-opus-4-8', usage: { ...USAGE_A, output: 6747 } }),
      row({ model: 'claude-fable-5', usage: { ...USAGE_A, output: 2 } }),
    ];
    expect(dedupeUsageByMessageId(rows)[0]?.model).toBe('claude-opus-4-8');
  });

  it('throws when two distinct models are tied at the same maximum output (genuine collision)', () => {
    // No output growth to disambiguate: two models tie at the global maximum,
    // which streaming cannot produce, so it stays a loud failure.
    const rows = [row(), row({ model: 'claude-fable-5' })];
    expect(() => dedupeUsageByMessageId(rows)).toThrow(UsageConflictError);
    expect(() => dedupeUsageByMessageId(rows)).toThrow(/conflicting model/);
  });

  it('throws when duplicate rows carry different agent attribution', () => {
    const rows = [row({ agentId: 'a1b2c3' }), row({ agentId: 'd4e5f6' })];
    expect(() => dedupeUsageByMessageId(rows)).toThrow(UsageConflictError);
    expect(() => dedupeUsageByMessageId(rows)).toThrow(/conflicting agent attribution/);
  });

  it('throws on a negative token count', () => {
    expect(() => dedupeUsageByMessageId([row({ usage: { ...USAGE_A, input: -1 } })])).toThrow(
      UsageConflictError,
    );
  });

  it('throws on a non-integer token count', () => {
    expect(() => dedupeUsageByMessageId([row({ usage: { ...USAGE_A, output: 1.5 } })])).toThrow(
      /non-negative integer/,
    );
  });

  it('throws on a NaN token count', () => {
    expect(() =>
      dedupeUsageByMessageId([row({ usage: { ...USAGE_A, cacheWrite1h: Number.NaN } })]),
    ).toThrow(UsageConflictError);
  });
});
