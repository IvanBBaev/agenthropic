/**
 * @agenthropic/core — domain logic (parser contract, cost engine, DAG rules).
 * Server/web-import-free by design (WP-F1): only `@agenthropic/shared` and
 * the standard library, pure data-in/data-out.
 */
export const CORE_PACKAGE_NAME = '@agenthropic/core';

export { dedupeUsageByMessageId, UsageConflictError } from './usage/dedupe';
export { computeCostUsd, priceUsage, PricingError } from './cost/compute-cost';
export type { PricedUsage } from './cost/compute-cost';
export { computeCompactionAwareCost } from './cost/compaction-repricing';
export type { CompactionSegment, CompactionRepricingResult } from './cost/compaction-repricing';
export { computeDelegationSavings } from './cost/delegation-savings';
export type {
  DelegationSavingsOptions,
  AgentDelegationSavings,
  DelegationSavingsResult,
} from './cost/delegation-savings';
export { groupSiblingsIntoWaves, DEFAULT_WAVE_THRESHOLD_MS } from './dag/waves';
export { canonicalizeTimestamp } from './time';
export {
  parseSession,
  peekSubstrateSessionId,
  SubstrateError,
  classifyRelativePath,
} from './parser/parse-session';
export { extractCompactionBoundaries } from './parser/compaction';
export { AGENT_OUTCOME_CAUSES, classifyAgentOutcomeCause } from './parser/agent-outcome';
export type { CompactionBoundary } from './parser/compaction';
export type { TokenBuckets, UsageRow, DedupedUsage, PricingEntry, SiblingWave } from './types';
export { LEGACY_EXPLORE_EDGE_SOURCE } from './parser/types';
export type {
  ParsedSession,
  ParsedAgent,
  ParsedAgentOutcome,
  ParsedEdge,
  ParsedEdgeSource,
  ParsedAgentType,
} from './parser/types';
export type { SessionSubstrate, SubstrateFile } from './parser/substrate';
export {
  censusFormat,
  KNOWN_CACHE_CREATION_KEYS,
  KNOWN_RECORD_TYPES,
  KNOWN_USAGE_KEYS,
  MISSING_RECORD_TYPE,
  UNVERSIONED,
} from './parser/format-census';
export type { CensusFile, FormatCensus, VersionFormatCensus } from './parser/format-census';
