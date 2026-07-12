/**
 * Bucket-and-model-aware, timestamp-dated cost computation — parser-spec
 * section 5.4 (gate N3) and WP-C2 (dated-price resolver).
 *
 * 88% of corpus tokens are cheap cache reads; a flat per-token rate would be
 * wildly wrong. Every bucket with tokens must resolve an explicit price row.
 * `<synthetic>` is priced $0 via explicit seed rows, never via a fallback:
 * an unknown model id or a missing bucket price HALTS LOUDLY — silence here
 * is phantom-free but money-wrong.
 */
import type { TokenBucket } from '@agenthropic/shared';
import type { DedupedUsage, PricingEntry, TokenBuckets } from '../types';
import { parseTimestampMs } from '../time';

/** Unknown model, missing bucket price, or malformed pricing table. */
export class PricingError extends Error {
  override readonly name = 'PricingError';
}

const USD_PER_TOKEN_DIVISOR = 1_000_000;

const BUCKET_MAP = [
  { key: 'input', bucket: 'input' },
  { key: 'output', bucket: 'output' },
  { key: 'cacheRead', bucket: 'cache_read' },
  { key: 'cacheWrite5m', bucket: 'cache_write_5m' },
  { key: 'cacheWrite1h', bucket: 'cache_write_1h' },
] as const satisfies ReadonlyArray<{ key: keyof TokenBuckets; bucket: TokenBucket }>;

interface DatedRate {
  effectiveFromMs: number;
  usdPerMtok: number;
}

type PricingIndex = Map<string, Map<TokenBucket, DatedRate[]>>;

function buildPricingIndex(pricing: readonly PricingEntry[]): PricingIndex {
  const index: PricingIndex = new Map();
  for (const entry of pricing) {
    if (!Number.isFinite(entry.usdPerMtok) || entry.usdPerMtok < 0) {
      throw new PricingError(
        `pricing for model "${entry.model}" bucket "${entry.bucket}": usdPerMtok must be a non-negative finite number (got ${String(entry.usdPerMtok)})`,
      );
    }
    const effectiveFromMs = parseTimestampMs(
      entry.effectiveFrom,
      `pricing for model "${entry.model}" bucket "${entry.bucket}"`,
    );
    let buckets = index.get(entry.model);
    if (buckets === undefined) {
      buckets = new Map();
      index.set(entry.model, buckets);
    }
    let rates = buckets.get(entry.bucket);
    if (rates === undefined) {
      rates = [];
      buckets.set(entry.bucket, rates);
    }
    rates.push({ effectiveFromMs, usdPerMtok: entry.usdPerMtok });
  }
  for (const buckets of index.values()) {
    for (const rates of buckets.values()) {
      rates.sort((a, b) => a.effectiveFromMs - b.effectiveFromMs);
    }
  }
  return index;
}

/** Latest rate with `effectiveFrom` <= the usage timestamp (WP-C2: old rate before a change, new rate at/after). */
function resolveRate(rates: readonly DatedRate[], usageMs: number): DatedRate | undefined {
  let resolved: DatedRate | undefined;
  for (const rate of rates) {
    if (rate.effectiveFromMs <= usageMs) {
      resolved = rate;
    } else {
      break;
    }
  }
  return resolved;
}

/**
 * Sums the USD cost of already-deduped usage (see `dedupeUsageByMessageId`;
 * feeding raw rows here reintroduces the ~2.4-2.7x over-count).
 *
 * Throws {@link PricingError} when a message's model has no pricing rows at
 * all, or when any bucket with a nonzero token count has no price row
 * effective at the message timestamp. Zero-token buckets need no price row.
 */
export function computeCostUsd(
  dedupedUsage: readonly DedupedUsage[],
  pricing: readonly PricingEntry[],
): number {
  const index = buildPricingIndex(pricing);
  let totalUsd = 0;

  for (const entry of dedupedUsage) {
    const usageMs = parseTimestampMs(entry.timestamp, `usage message "${entry.messageId}"`);
    const buckets = index.get(entry.model);
    if (buckets === undefined) {
      throw new PricingError(
        `unknown model id "${entry.model}" (message "${entry.messageId}") — refusing to price at $0; seed an explicit pricing row instead`,
      );
    }
    for (const { key, bucket } of BUCKET_MAP) {
      const tokens = entry.usage[key];
      if (tokens === 0) {
        continue;
      }
      const rates = buckets.get(bucket);
      if (rates === undefined) {
        throw new PricingError(
          `model "${entry.model}" has no price for bucket "${bucket}" (message "${entry.messageId}") — refusing to price at $0`,
        );
      }
      const rate = resolveRate(rates, usageMs);
      if (rate === undefined) {
        throw new PricingError(
          `model "${entry.model}" bucket "${bucket}": no price effective at ${entry.timestamp} (message "${entry.messageId}")`,
        );
      }
      totalUsd += (tokens * rate.usdPerMtok) / USD_PER_TOKEN_DIVISOR;
    }
  }

  return totalUsd;
}
