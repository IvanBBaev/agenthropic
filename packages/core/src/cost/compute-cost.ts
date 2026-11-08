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
import { parsePricingInstantMs, parseTimestampMs } from '../time';

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

/**
 * Models whose published price is tiered by prompt length, mapped to the
 * largest prompt (in tokens) the base tier covers. `model_pricing` has no tier
 * dimension and holds ONLY the base-tier rates for these models, so a request
 * over the limit is refused rather than priced at the lower tier.
 *
 * The prompt is every input token of the request - `input` + `cacheRead` +
 * `cacheWrite5m` + `cacheWrite1h` - and each request is priced on its own
 * (pricing page, fetched 2026-10-30). The limit is inclusive: "prompts up to
 * 100,000 tokens" are base tier.
 *
 * claude-haiku-5-5: base tier seeded by migration 25 (owner decision D1).
 */
const BASE_TIER_PROMPT_LIMITS: ReadonlyMap<string, number> = new Map([
  ['claude-haiku-5-5', 100_000],
]);

function buildPricingIndex(pricing: readonly PricingEntry[]): PricingIndex {
  const index: PricingIndex = new Map();
  for (const entry of pricing) {
    if (!Number.isFinite(entry.usdPerMtok) || entry.usdPerMtok < 0) {
      throw new PricingError(
        `pricing for model "${entry.model}" bucket "${entry.bucket}": usdPerMtok must be a non-negative finite number (got ${String(entry.usdPerMtok)})`,
      );
    }
    const effectiveFromMs = parsePricingInstantMs(
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

/** What {@link priceUsage} could price, and what it could not. */
export interface PricedUsage {
  /** USD over the priced buckets only - an unpriced bucket adds $0, never a guess. */
  readonly costUsd: number;
  /** Tokens in buckets with no price row in force at the message timestamp. */
  readonly unpricedTokens: number;
}

/**
 * The one pricing loop. `onUnpriced` decides what a bucket with no resolvable
 * price means: {@link computeCostUsd} throws, {@link priceUsage} counts it.
 * Everything else - a malformed pricing table, an unparsable timestamp, a
 * tiered prompt over its seeded base tier - throws in both modes.
 */
function priceEntries(
  dedupedUsage: readonly DedupedUsage[],
  pricing: readonly PricingEntry[],
  onUnpriced: (message: string, tokens: number) => void,
): number {
  const index = buildPricingIndex(pricing);
  let totalUsd = 0;

  for (const entry of dedupedUsage) {
    const usageMs = parseTimestampMs(entry.timestamp, `usage message "${entry.messageId}"`);
    const buckets = index.get(entry.model);
    if (buckets === undefined) {
      const tokens = BUCKET_MAP.reduce((sum, { key }) => sum + entry.usage[key], 0);
      onUnpriced(
        `unknown model id "${entry.model}" (message "${entry.messageId}") — refusing to price at $0; seed an explicit pricing row instead`,
        tokens,
      );
      continue;
    }
    const promptLimit = BASE_TIER_PROMPT_LIMITS.get(entry.model);
    if (promptLimit !== undefined) {
      const { input, cacheRead, cacheWrite5m, cacheWrite1h } = entry.usage;
      const promptTokens = input + cacheRead + cacheWrite5m + cacheWrite1h;
      if (promptTokens > promptLimit) {
        throw new PricingError(
          `model "${entry.model}" (message "${entry.messageId}"): prompt of ${String(promptTokens)} tokens (input + cache reads + cache writes) exceeds the ${String(promptLimit)}-token base tier, and only base-tier rates are seeded — refusing to price it at the lower tier`,
        );
      }
    }
    for (const { key, bucket } of BUCKET_MAP) {
      const tokens = entry.usage[key];
      if (tokens === 0) {
        continue;
      }
      const rates = buckets.get(bucket);
      if (rates === undefined) {
        onUnpriced(
          `model "${entry.model}" has no price for bucket "${bucket}" (message "${entry.messageId}") — refusing to price at $0`,
          tokens,
        );
        continue;
      }
      const rate = resolveRate(rates, usageMs);
      if (rate === undefined) {
        onUnpriced(
          `model "${entry.model}" bucket "${bucket}": no price effective at ${entry.timestamp} (message "${entry.messageId}")`,
          tokens,
        );
        continue;
      }
      totalUsd += (tokens * rate.usdPerMtok) / USD_PER_TOKEN_DIVISOR;
    }
  }

  return totalUsd;
}

/**
 * Sums the USD cost of already-deduped usage (see `dedupeUsageByMessageId`;
 * feeding raw rows here reintroduces the ~2.4-2.7x over-count).
 *
 * Throws {@link PricingError} when a message's model has no pricing rows at
 * all, when a tiered model's prompt exceeds its seeded base tier
 * ({@link BASE_TIER_PROMPT_LIMITS}), or when any bucket with a nonzero token count has no price row
 * effective at the message timestamp. Zero-token buckets need no price row.
 */
export function computeCostUsd(
  dedupedUsage: readonly DedupedUsage[],
  pricing: readonly PricingEntry[],
): number {
  return priceEntries(dedupedUsage, pricing, (message) => {
    throw new PricingError(message);
  });
}

/**
 * The ingest-side price (R2 / ARC-1): the same per-bucket resolution as
 * {@link computeCostUsd}, but a bucket with no price row in force - an unknown
 * model, a missing bucket, a rate not yet effective - is COUNTED in
 * `unpricedTokens` instead of halting. This is exactly the read path's rule
 * (`pricedCte` resolves such a row to a NULL rate), so the figure ingest
 * announces equals the one the dashboard later reads back.
 *
 * Still throws {@link PricingError} on a malformed pricing table and on a
 * tiered model's prompt over its seeded base tier: the read path cannot tell
 * an over-limit row from a base-tier one, so storing it would price it at the
 * lower tier.
 */
export function priceUsage(
  dedupedUsage: readonly DedupedUsage[],
  pricing: readonly PricingEntry[],
): PricedUsage {
  let unpricedTokens = 0;
  const costUsd = priceEntries(dedupedUsage, pricing, (_message, tokens) => {
    unpricedTokens += tokens;
  });
  return { costUsd, unpricedTokens };
}
