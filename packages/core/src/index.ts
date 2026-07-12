/**
 * @agenthropic/core — domain logic (parser contract, cost engine, DAG rules).
 * Server/web-import-free by design (WP-F1): only `@agenthropic/shared` and
 * the standard library, pure data-in/data-out.
 */
export const CORE_PACKAGE_NAME = '@agenthropic/core';

export { dedupeUsageByMessageId, UsageConflictError } from './usage/dedupe';
export { computeCostUsd, PricingError } from './cost/compute-cost';
export { groupSiblingsIntoWaves, DEFAULT_WAVE_THRESHOLD_MS } from './dag/waves';
export type { TokenBuckets, UsageRow, DedupedUsage, PricingEntry, SiblingWave } from './types';
