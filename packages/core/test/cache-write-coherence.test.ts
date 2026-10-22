/**
 * C-4 regression: the 5m/1h cache-write split of one message is ONE fact, so
 * dedup must never take the 5m maximum from one streamed partial and the 1h
 * maximum from another.
 *
 * A flat-only record (`cache_creation_input_tokens: T`, no breakdown) maps to
 * `{cacheWrite5m: T, cacheWrite1h: 0}` (NN2); a split record of the same write
 * maps to `{cacheWrite5m: a, cacheWrite1h: b}`. An independent per-bucket max
 * over those two shapes yields `T + b` — more cache-write tokens than ANY
 * single record of the message reports. Dedup now carries the cache-write pair
 * as a unit: the pair of the partial with the largest cache-write total, ties
 * going to the later partial (the final streamed state is ground truth).
 */
import { describe, expect, it } from 'vitest';
import {
  dedupeUsageByMessageId,
  parseSession,
  type SessionSubstrate,
  type TokenBuckets,
  type UsageRow,
} from '../src/index';

function usage(overrides: Partial<TokenBuckets>): TokenBuckets {
  return { input: 10, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...overrides };
}

function row(u: TokenBuckets): UsageRow {
  return { messageId: 'msg_c4', model: 'm', timestamp: '2026-09-01T00:00:00.000Z', usage: u };
}

function cacheWrite(u: TokenBuckets): number {
  return u.cacheWrite5m + u.cacheWrite1h;
}

describe('dedupeUsageByMessageId — cache-write split is collapsed as one unit (C-4)', () => {
  it('flat-shaped partial then split-shaped partial: no double count, later split wins the tie', () => {
    const [merged] = dedupeUsageByMessageId([
      row(usage({ cacheWrite5m: 100, cacheWrite1h: 0, output: 5 })),
      row(usage({ cacheWrite5m: 0, cacheWrite1h: 100, output: 50 })),
    ]);
    expect(merged?.usage).toEqual(usage({ cacheWrite5m: 0, cacheWrite1h: 100, output: 50 }));
  });

  it('split-shaped partial then flat-shaped partial: the later partial wins the tie', () => {
    const [merged] = dedupeUsageByMessageId([
      row(usage({ cacheWrite5m: 60, cacheWrite1h: 40, output: 5 })),
      row(usage({ cacheWrite5m: 100, cacheWrite1h: 0, output: 50 })),
    ]);
    expect(merged?.usage).toEqual(usage({ cacheWrite5m: 100, cacheWrite1h: 0, output: 50 }));
  });

  it('takes the pair of the partial with the larger cache-write total, never a cross-row mix', () => {
    const rows = [
      row(usage({ cacheWrite5m: 70, cacheWrite1h: 0 })),
      row(usage({ cacheWrite5m: 0, cacheWrite1h: 90 })),
      row(usage({ cacheWrite5m: 50, cacheWrite1h: 10 })),
    ];
    const [merged] = dedupeUsageByMessageId(rows);
    expect(merged?.usage.cacheWrite5m).toBe(0);
    expect(merged?.usage.cacheWrite1h).toBe(90);
    const maxSingle = Math.max(...rows.map((r) => cacheWrite(r.usage)));
    expect(cacheWrite(merged!.usage)).toBe(maxSingle);
  });

  it('keeps an identical split across partials unchanged (the real-data constant case)', () => {
    const [merged] = dedupeUsageByMessageId([
      row(usage({ cacheWrite5m: 30, cacheWrite1h: 20, output: 1 })),
      row(usage({ cacheWrite5m: 30, cacheWrite1h: 20, output: 9 })),
    ]);
    expect(merged?.usage).toEqual(usage({ cacheWrite5m: 30, cacheWrite1h: 20, output: 9 }));
  });
});

describe('parseSession — mixed flat/split cache-write shapes on one message (C-4)', () => {
  const SESSION = 'c4c40000-1111-4222-8333-444444444444';
  const sub: SessionSubstrate = {
    files: [
      {
        relativePath: `${SESSION}.jsonl`,
        lines: [
          JSON.stringify({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-09-01T00:00:01.000Z',
            message: {
              id: 'm_c4_mixed',
              model: 'm',
              usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 1000 },
            },
          }),
          JSON.stringify({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-09-01T00:00:02.000Z',
            message: {
              id: 'm_c4_mixed',
              model: 'm',
              usage: {
                input_tokens: 3,
                output_tokens: 40,
                cache_creation_input_tokens: 1000,
                cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
              },
            },
          }),
        ],
      },
    ],
  };

  it('reports the cache write once (1000), as the split record states it', () => {
    const result = parseSession(sub);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.usage).toEqual({
      input: 3,
      output: 40,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 1000,
    });
  });
});
