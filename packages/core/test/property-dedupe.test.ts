/**
 * QA-8 — property tests for `dedupeUsageByMessageId` (parser-spec section 5.2).
 *
 * The example tests pin the cases someone thought of; these check the rule
 * itself against a deliberately naive reference model over thousands of
 * generated row sets. Values are drawn from tiny ranges (few message ids, few
 * models, small token counts) on purpose: ties are where dedup is subtle — the
 * model tie that must throw, the cache-write pair tie that goes to the later
 * row — and wide ranges would almost never produce one.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  dedupeUsageByMessageId,
  UsageConflictError,
  type DedupedUsage,
  type TokenBuckets,
  type UsageRow,
} from '../src/index';

const MESSAGE_IDS = ['msg_a', 'msg_b', 'msg_c'];
const MODELS = ['model-x', 'model-y'];
const AGENTS = [undefined, 'agent-1', 'agent-2'];

const bucket = fc.nat({ max: 6 });
const buckets: fc.Arbitrary<TokenBuckets> = fc.record({
  input: bucket,
  output: bucket,
  cacheRead: bucket,
  cacheWrite5m: bucket,
  cacheWrite1h: bucket,
});

/** Any row: agent attribution and model drawn freely, so conflicts do occur. */
const anyRow: fc.Arbitrary<UsageRow> = fc.record(
  {
    messageId: fc.constantFrom(...MESSAGE_IDS),
    model: fc.constantFrom(...MODELS),
    timestamp: fc.constantFrom('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z'),
    usage: buckets,
    agentId: fc.constantFrom(...AGENTS),
  },
  { requiredKeys: ['messageId', 'model', 'timestamp', 'usage'] },
);

/**
 * Rows that can never conflict: every row of a message shares one agent and
 * one model. Dedup must then always succeed, which lets the order-sensitive
 * properties run without a throw filtering most cases away.
 */
const consistentRows: fc.Arbitrary<UsageRow[]> = fc
  .array(
    fc.record({
      messageId: fc.constantFrom(...MESSAGE_IDS),
      timestamp: fc.constantFrom('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z'),
      usage: buckets,
    }),
    { maxLength: 12 },
  )
  .map((rows) =>
    rows.map((r) => {
      const index = MESSAGE_IDS.indexOf(r.messageId);
      return { ...r, model: MODELS[index % MODELS.length]!, agentId: AGENTS[index] };
    }),
  );

function cacheWriteTotal(usage: TokenBuckets): number {
  return usage.cacheWrite5m + usage.cacheWrite1h;
}

/**
 * The rule, written as plainly as possible: group by message id in first-seen
 * order; independent max for input/output/cacheRead; the cache-write pair of
 * the LAST row with the largest total; the model of the FIRST row at the max
 * output. `undefined` means "must throw".
 */
function reference(rows: readonly UsageRow[]): DedupedUsage[] | undefined {
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) {
    groups.set(r.messageId, [...(groups.get(r.messageId) ?? []), r]);
  }
  const out: DedupedUsage[] = [];
  for (const [messageId, group] of groups) {
    const first = group[0]!;
    if (group.some((r) => (r.agentId ?? null) !== (first.agentId ?? null))) {
      return undefined;
    }
    const maxOutput = Math.max(...group.map((r) => r.usage.output));
    const atMax = group.filter((r) => r.usage.output === maxOutput);
    if (new Set(atMax.map((r) => r.model)).size > 1) {
      return undefined;
    }
    const maxCacheWrite = Math.max(...group.map((r) => cacheWriteTotal(r.usage)));
    const pairRow = group.filter((r) => cacheWriteTotal(r.usage) === maxCacheWrite).at(-1)!;
    out.push({
      messageId,
      model: atMax[0]!.model,
      timestamp: first.timestamp,
      agentId: first.agentId ?? null,
      usage: {
        input: Math.max(...group.map((r) => r.usage.input)),
        output: maxOutput,
        cacheRead: Math.max(...group.map((r) => r.usage.cacheRead)),
        cacheWrite5m: pairRow.usage.cacheWrite5m,
        cacheWrite1h: pairRow.usage.cacheWrite1h,
      },
    });
  }
  return out;
}

function tryDedupe(rows: readonly UsageRow[]): DedupedUsage[] | undefined {
  try {
    return dedupeUsageByMessageId(rows);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageConflictError);
    return undefined;
  }
}

function asRows(deduped: readonly DedupedUsage[]): UsageRow[] {
  return deduped.map(({ agentId, ...rest }) => (agentId === null ? rest : { ...rest, agentId }));
}

describe('dedupeUsageByMessageId — properties (QA-8)', () => {
  it('matches the reference model on any row set, including which sets throw', () => {
    fc.assert(
      fc.property(fc.array(anyRow, { maxLength: 12 }), (rows) => {
        expect(tryDedupe(rows)).toEqual(reference(rows));
      }),
      { numRuns: 2000 },
    );
  });

  it('is idempotent: deduping its own output changes nothing', () => {
    fc.assert(
      fc.property(consistentRows, (rows) => {
        const once = dedupeUsageByMessageId(rows);
        expect(dedupeUsageByMessageId(asRows(once))).toEqual(once);
      }),
    );
  });

  it('yields exactly one entry per distinct message id, in first-seen order', () => {
    fc.assert(
      fc.property(consistentRows, (rows) => {
        const firstSeen = [...new Set(rows.map((r) => r.messageId))];
        expect(dedupeUsageByMessageId(rows).map((d) => d.messageId)).toEqual(firstSeen);
      }),
    );
  });

  it('per-message totals do not depend on row order (only the cache-write SPLIT may)', () => {
    fc.assert(
      fc.property(
        consistentRows.chain((rows) =>
          fc.tuple(fc.constant(rows), fc.shuffledSubarray(rows, { minLength: rows.length })),
        ),
        ([rows, shuffled]) => {
          const summary = (deduped: DedupedUsage[]): Record<string, unknown> =>
            Object.fromEntries(
              deduped.map((d) => [
                d.messageId,
                [
                  d.model,
                  d.usage.input,
                  d.usage.output,
                  d.usage.cacheRead,
                  cacheWriteTotal(d.usage),
                ],
              ]),
            );
          expect(summary(dedupeUsageByMessageId(shuffled))).toEqual(
            summary(dedupeUsageByMessageId(rows)),
          );
        },
      ),
    );
  });

  it('never reports more tokens in any bucket than one single row of the message does', () => {
    fc.assert(
      fc.property(consistentRows, (rows) => {
        for (const d of dedupeUsageByMessageId(rows)) {
          const group = rows.filter((r) => r.messageId === d.messageId);
          // The cache-write pair is one row's pair, never a cross-row mix (C-4).
          expect(
            group.some(
              (r) =>
                r.usage.cacheWrite5m === d.usage.cacheWrite5m &&
                r.usage.cacheWrite1h === d.usage.cacheWrite1h,
            ),
          ).toBe(true);
          const total =
            d.usage.input + d.usage.output + d.usage.cacheRead + cacheWriteTotal(d.usage);
          const naiveSum = group.reduce(
            (sum, r) =>
              sum + r.usage.input + r.usage.output + r.usage.cacheRead + cacheWriteTotal(r.usage),
            0,
          );
          expect(total).toBeLessThanOrEqual(naiveSum);
        }
      }),
    );
  });

  it('rejects any bucket that is not a non-negative integer, wherever it sits', () => {
    const badValue = fc.oneof(
      fc.integer({ max: -1 }),
      fc.double({ noInteger: true }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    );
    const key = fc.constantFrom<keyof TokenBuckets>(
      'input',
      'output',
      'cacheRead',
      'cacheWrite5m',
      'cacheWrite1h',
    );
    fc.assert(
      fc.property(consistentRows, fc.nat(), key, badValue, (rows, at, bucketKey, value) => {
        const victim = rows.length === 0 ? 0 : at % rows.length;
        const base: UsageRow = rows[victim] ?? {
          messageId: 'msg_a',
          model: 'model-x',
          timestamp: '2026-09-01T00:00:00.000Z',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        };
        const corrupted = [...rows];
        corrupted[victim] = { ...base, usage: { ...base.usage, [bucketKey]: value } };
        expect(() => dedupeUsageByMessageId(corrupted)).toThrow(UsageConflictError);
      }),
    );
  });
});
