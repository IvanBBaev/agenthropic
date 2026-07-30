/**
 * Core domain input/output types for the parser-contract pure functions
 * (parser-spec sections 5-6). Camel-cased in-memory shapes; the snake_case
 * SQLite row contracts live in `@agenthropic/shared`.
 */
import type { TokenBucket } from '@agenthropic/shared';

/** The five priced token buckets of a single `usage` block (parser-spec section 5.4). */
export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * One raw JSONL `usage` row. Claude Code writes one line per content block, so
 * many rows share a `messageId`; on real data those are streamed partials whose
 * `input`/cache buckets are constant while `output` grows toward the final
 * total. Dedup collapses each `messageId` to its per-bucket maximum
 * (parser-spec section 5.2).
 */
export interface UsageRow {
  messageId: string;
  model: string;
  /** ISO-8601 UTC timestamp of the JSONL line; drives dated-price resolution. */
  timestamp: string;
  usage: TokenBuckets;
  /** Inline hard attribution key; absent/null for the main agent's own turns. */
  agentId?: string | null;
}

/** One entry per `messageId` after dedup (parser-spec section 5.2, gate N3). */
export interface DedupedUsage {
  messageId: string;
  model: string;
  /** Timestamp of the first row seen for this message. */
  timestamp: string;
  usage: TokenBuckets;
  agentId: string | null;
}

/**
 * One dated per-model per-bucket price point. Resolution picks the row with
 * the latest `effectiveFrom` <= the usage timestamp (WP-C2 semantics).
 */
export interface PricingEntry {
  model: string;
  bucket: TokenBucket;
  usdPerMtok: number;
  effectiveFrom: string;
}

/**
 * A group of siblings whose start deltas fall below the concurrency
 * threshold. `startedTogether: true` marks the wave as explicitly UNORDERED:
 * the substrate carries no total order inside it (parser-spec section 6.3).
 */
export interface SiblingWave<T> {
  startedTogether: boolean;
  agents: T[];
}
