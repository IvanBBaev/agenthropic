/**
 * The test-side, INDEPENDENT reading of one raw usage block — shared by the P0
 * token reconciliation (synthetic fixtures) and the opt-in real-corpus contract
 * suite (R17). It deliberately does NOT reuse the production parser: it is a
 * minimal reader written against the normative rules of
 * docs/analysis/parser-spec.md:
 *
 *  - section 5.1: a usage row is a `type === 'assistant'` record carrying both
 *    `message.usage` and `message.id`;
 *  - section 5.2 (correctness gate N3): lines sharing a `message.id` are
 *    streamed partials of ONE message — dedup collapses them to the PER-BUCKET
 *    MAXIMUM (never a sum), and the model settles to the greatest-output row;
 *  - section 5.3 bucket mapping: `cache_creation.ephemeral_5m/1h_input_tokens`
 *    when the nested object is present, else the legacy flat
 *    `cache_creation_input_tokens` as the 5m bucket (1h = 0).
 */
import type { DbBucket } from './harness';

export type JsonRecord = Record<string, unknown>;

/** One message's usage as the independent reader currently sees it. */
export interface RawUsagePartial {
  model: string;
  /** Greatest output seen so far — the model-settling criterion (spec 5.2). */
  settledOutput: number;
  readonly buckets: Record<DbBucket, number>;
}

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/**
 * Raw-field bucket mapping per parser-spec section 5.3 (NOT the production mapper).
 * NN2: a breakdown that covers only part of the flat cache-write total keeps its
 * split, and the uncovered remainder goes to the unsplit 5m bucket.
 */
export function bucketsOfRawUsage(usage: JsonRecord): Record<DbBucket, number> {
  const cacheCreation = asRecord(usage['cache_creation']);
  const flat = asCount(usage['cache_creation_input_tokens']);
  const split5m = cacheCreation !== null ? asCount(cacheCreation['ephemeral_5m_input_tokens']) : 0;
  const split1h = cacheCreation !== null ? asCount(cacheCreation['ephemeral_1h_input_tokens']) : 0;
  return {
    input: asCount(usage['input_tokens']),
    output: asCount(usage['output_tokens']),
    cache_read: asCount(usage['cache_read_input_tokens']),
    cache_write_5m: cacheCreation !== null ? split5m + Math.max(0, flat - split5m - split1h) : flat,
    cache_write_1h: split1h,
  };
}

/** Per-bucket maxima apply to these; the two cache-write buckets move as one pair (C-4). */
const MAX_BUCKETS: readonly DbBucket[] = ['input', 'output', 'cache_read'];

/**
 * The usage carried by one raw transcript record, or null when the record is
 * not a usage row (spec 5.1: it needs BOTH `message.usage` and `message.id`).
 */
export function usageOfRawRecord(
  record: JsonRecord | null,
): { messageId: string; partial: RawUsagePartial } | null {
  if (record === null || record['type'] !== 'assistant') {
    return null;
  }
  const message = asRecord(record['message']);
  const usage = message === null ? null : asRecord(message['usage']);
  const messageId = message?.['id'];
  if (message === null || usage === null || typeof messageId !== 'string') {
    return null;
  }
  const buckets = bucketsOfRawUsage(usage);
  return {
    messageId,
    partial: {
      model: typeof message['model'] === 'string' ? message['model'] : '',
      settledOutput: buckets.output,
      buckets,
    },
  };
}

/** Folds a LATER partial of the same `message.id` into `existing`, in place. */
export function mergeUsagePartial(existing: RawUsagePartial, later: RawUsagePartial): void {
  // Spec 5.2: per-bucket MAXIMUM across partials, never a sum.
  for (const bucket of MAX_BUCKETS) {
    existing.buckets[bucket] = Math.max(existing.buckets[bucket], later.buckets[bucket]);
  }
  // C-4: the cache-write pair comes whole from the partial with the largest
  // 5m+1h total (a tie goes to the later partial), so mixed flat/split
  // shapes are never counted twice.
  if (
    later.buckets.cache_write_5m + later.buckets.cache_write_1h >=
    existing.buckets.cache_write_5m + existing.buckets.cache_write_1h
  ) {
    existing.buckets.cache_write_5m = later.buckets.cache_write_5m;
    existing.buckets.cache_write_1h = later.buckets.cache_write_1h;
  }
  // Spec 5.2: the message's model settles to the greatest-output row.
  if (later.settledOutput > existing.settledOutput) {
    existing.settledOutput = later.settledOutput;
    existing.model = later.model;
  }
}
