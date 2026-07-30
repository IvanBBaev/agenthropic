/**
 * WP-U4 - cost DTOs. Every dollar in these shapes traces to tokens x a dated
 * `model_pricing` row; tokens with no resolvable price are reported in
 * `unpricedTokens` and NEVER silently priced at $0 (honest-uncertainty rule).
 */
import { Type, type Static } from '@sinclair/typebox';
import { nullable } from './common';

/** Ground-truth rollup: tokens, the priced part in USD, and what wasn't priceable. */
export const CostTotalsSchema = Type.Object(
  {
    tokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    unpricedTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type CostTotalsDto = Static<typeof CostTotalsSchema>;

export const ModelCostSchema = Type.Object(
  {
    model: Type.String(),
    tokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    unpricedTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ModelCostDto = Static<typeof ModelCostSchema>;

export const DailyCostSchema = Type.Object(
  {
    /** `YYYY-MM-DD`, or the literal `'unknown'` for usage rows without a timestamp. */
    day: Type.String(),
    tokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    unpricedTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type DailyCostDto = Static<typeof DailyCostSchema>;

export const SessionCostSchema = Type.Object(
  {
    sessionId: Type.String(),
    projectSlug: nullable(Type.String()),
    tokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    unpricedTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type SessionCostDto = Static<typeof SessionCostSchema>;

/** `GET /api/cost/summary` response. */
export const CostSummaryResponseSchema = Type.Object(
  {
    totals: CostTotalsSchema,
    perModel: Type.Array(ModelCostSchema),
    perDay: Type.Array(DailyCostSchema),
    topSessions: Type.Array(SessionCostSchema),
  },
  { additionalProperties: false },
);

export type CostSummaryDto = Static<typeof CostSummaryResponseSchema>;

/** The five priced token buckets of one usage aggregate (camelCase mirror of `TokenBucket`). */
export const TokenBucketsSchema = Type.Object(
  {
    input: Type.Integer({ minimum: 0 }),
    output: Type.Integer({ minimum: 0 }),
    cacheRead: Type.Integer({ minimum: 0 }),
    cacheWrite5m: Type.Integer({ minimum: 0 }),
    cacheWrite1h: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type TokenBucketsDto = Static<typeof TokenBucketsSchema>;

/** One `compact_boundary` context reset (WP-C4). `agentId` null = the main transcript. */
export const CompactionBoundarySchema = Type.Object(
  {
    agentId: nullable(Type.String()),
    timestamp: Type.String(),
    trigger: nullable(Type.String()),
    /** The preserved pre-compaction context-token baseline, when recorded. */
    preTokens: nullable(Type.Number()),
  },
  { additionalProperties: false },
);

export type CompactionBoundaryDto = Static<typeof CompactionBoundarySchema>;

/** One compaction-delimited slice of a single transcript's usage stream. */
export const CompactionSegmentSchema = Type.Object(
  {
    agentId: nullable(Type.String()),
    index: Type.Integer({ minimum: 0 }),
    /** The boundary that OPENED this segment; null for the initial segment. */
    boundary: nullable(CompactionBoundarySchema),
    usd: Type.Number({ minimum: 0 }),
    messageCount: Type.Integer({ minimum: 0 }),
    tokens: TokenBucketsSchema,
  },
  { additionalProperties: false },
);

export type CompactionSegmentDto = Static<typeof CompactionSegmentSchema>;

/**
 * WP-C4 compaction repricing: the boundary-blind naive sum vs the
 * compaction-segmented repricing. `deltaUsd` must be ~0 on a complete
 * substrate; a materially nonzero delta is a loud mispricing signal and is
 * served as-is, never averaged away.
 */
export const CompactionAnalysisSchema = Type.Object(
  {
    naiveUsd: Type.Number({ minimum: 0 }),
    repricedUsd: Type.Number({ minimum: 0 }),
    deltaUsd: Type.Number(),
    compactionCount: Type.Integer({ minimum: 0 }),
    segments: Type.Array(CompactionSegmentSchema),
  },
  { additionalProperties: false },
);

export type CompactionAnalysisDto = Static<typeof CompactionAnalysisSchema>;

/**
 * Per-subagent WP-C5 delegation savings. `isEstimate` is a literal `true`:
 * the counterfactual cache profile is not observable, so the figure must never
 * be presented as a measured dollar amount.
 */
export const AgentDelegationSavingsSchema = Type.Object(
  {
    agentId: Type.String(),
    parentAgentId: nullable(Type.String()),
    actualUsd: Type.Number({ minimum: 0 }),
    hypotheticalUsd: Type.Number({ minimum: 0 }),
    savingsUsd: Type.Number({ minimum: 0 }),
    hypotheticalModel: Type.String(),
    isEstimate: Type.Literal(true),
  },
  { additionalProperties: false },
);

export type AgentDelegationSavingsDto = Static<typeof AgentDelegationSavingsSchema>;

/** WP-C5 delegation-savings estimate for one session (honest-uncertainty label kept). */
export const DelegationSavingsSchema = Type.Object(
  {
    actualUsd: Type.Number({ minimum: 0 }),
    hypotheticalUsd: Type.Number({ minimum: 0 }),
    savingsUsd: Type.Number({ minimum: 0 }),
    perAgent: Type.Array(AgentDelegationSavingsSchema),
    /** Subagents with no resolvable top-tier model — excluded, never guessed. */
    skippedAgentIds: Type.Array(Type.String()),
    isEstimate: Type.Literal(true),
  },
  { additionalProperties: false },
);

export type DelegationSavingsDto = Static<typeof DelegationSavingsSchema>;

/** `GET /api/sessions/:id/cost-analysis` response (WP-C4 + WP-C5 over one session). */
export const CostAnalysisSchema = Type.Object(
  {
    compaction: CompactionAnalysisSchema,
    delegationSavings: DelegationSavingsSchema,
  },
  { additionalProperties: false },
);

export type CostAnalysisDto = Static<typeof CostAnalysisSchema>;
