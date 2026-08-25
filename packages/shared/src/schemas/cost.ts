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

/**
 * How much of the corpus the figures alongside it are actually computed from.
 *
 * `unpricedTokens` already discloses the tokens present in the database that
 * carry no dollar figure. This discloses the opposite and larger gap: sessions
 * that are not in the database AT ALL, because ingest could not read or price
 * them. Their tokens are in neither `tokens` nor `unpricedTokens` - nothing in
 * a total computed from stored rows can hint that they exist, and the omission
 * is one-directional, since a total missing sessions is always too SMALL.
 *
 * Omitted (not zeroed) when the server has no ingest seam wired: "we did not
 * ask" and "we asked and the answer is none" are different facts, and a zero
 * would assert the second while meaning the first.
 */
export const CostCoverageSchema = Type.Object(
  {
    /** Sessions whose latest ingest attempt failed; includes `sessionsQuarantined`. */
    sessionsExcluded: Type.Integer({ minimum: 0 }),
    /**
     * Subset that will NOT be retried until the session's bytes or the pricing
     * table change - the ones that need a human, typically a missing price.
     */
    sessionsQuarantined: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type CostCoverageDto = Static<typeof CostCoverageSchema>;

/** `GET /api/cost/summary` response. */
export const CostSummaryResponseSchema = Type.Object(
  {
    totals: CostTotalsSchema,
    perModel: Type.Array(ModelCostSchema),
    perDay: Type.Array(DailyCostSchema),
    topSessions: Type.Array(SessionCostSchema),
    coverage: Type.Optional(CostCoverageSchema),
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

/**
 * Cap on the `skippedSessions` SAMPLE carried by the corpus-wide estimate.
 * The authoritative figure is `skippedSessionCount`, which is never capped -
 * the array is a readable sample so a corpus with thousands of unpriceable
 * sessions cannot turn one KPI request into a multi-megabyte payload.
 */
export const MAX_AGGREGATE_SKIPPED_SAMPLE = 20;

/** Why one session was left out of the corpus-wide estimate. */
export const AggregateSavingsSkipReasonSchema = Type.Union([
  /** Some model/bucket/date in the session has no `model_pricing` row. */
  Type.Literal('unpriceable'),
  /** Some stored usage row has no timestamp, so no dated rate can be chosen. */
  Type.Literal('undated-usage'),
]);

export type AggregateSavingsSkipReason = Static<typeof AggregateSavingsSkipReasonSchema>;

export const AggregateSavingsSkipSchema = Type.Object(
  {
    sessionId: Type.String(),
    reason: AggregateSavingsSkipReasonSchema,
    /** Human-readable cause (e.g. the pricing error naming the model). */
    detail: Type.String(),
  },
  { additionalProperties: false },
);

export type AggregateSavingsSkipDto = Static<typeof AggregateSavingsSkipSchema>;

/**
 * `GET /api/cost/delegation-savings` - the M-9 corpus-wide delegation-savings
 * estimate. Same counterfactual as `DelegationSavingsSchema` (and the same
 * `isEstimate: true` label), summed across every session that recorded a
 * subagent.
 *
 * Two honesty rules are encoded in the shape rather than left to the caller:
 *
 *   1. `basis` names where the numbers came from. `'stored-usage-rows'` means
 *      the sum was rebuilt from the `token_usage` / `agents` tables, NOT by
 *      re-reading the transcripts the per-session route parses. The two agree
 *      row for row on an ingested session (proved by
 *      `api-aggregate-savings-equivalence.test.ts`); they can only diverge
 *      where the database itself lacks the rows - see the endpoint docs.
 *   2. The scope counters are mandatory, not optional extras. An aggregate
 *      quietly computed over a subset is a lie, so every session that was
 *      excluded is counted in `skippedSessionCount` (with a bounded sample in
 *      `skippedSessions`), every subagent the estimator could not resolve is
 *      counted in `subagentsSkipped`, and the sessions that legitimately
 *      contribute nothing are derivable as
 *      `sessionsTotal - sessionsWithSubagents` - they are a measured $0, not
 *      a gap.
 */
export const AggregateDelegationSavingsSchema = Type.Object(
  {
    /** What the included sessions' subagents actually cost. */
    actualUsd: Type.Number({ minimum: 0 }),
    /** What that same work would have cost on the top-tier model instead. */
    hypotheticalUsd: Type.Number({ minimum: 0 }),
    savingsUsd: Type.Number({ minimum: 0 }),
    isEstimate: Type.Literal(true),
    basis: Type.Literal('stored-usage-rows'),
    /** Every session row in the database, delegating or not. */
    sessionsTotal: Type.Integer({ minimum: 0 }),
    /** Sessions with at least one persisted subagent - the estimate's universe. */
    sessionsWithSubagents: Type.Integer({ minimum: 0 }),
    /** Of those, the ones actually summed into the figures above. */
    sessionsPriced: Type.Integer({ minimum: 0 }),
    skippedSessionCount: Type.Integer({ minimum: 0 }),
    /** Bounded sample of the skipped sessions (see MAX_AGGREGATE_SKIPPED_SAMPLE). */
    skippedSessions: Type.Array(AggregateSavingsSkipSchema),
    /** Subagents that carry a resolved counterfactual model in the sums. */
    subagentsPriced: Type.Integer({ minimum: 0 }),
    /** Subagents excluded for want of a top-tier model - never guessed. */
    subagentsSkipped: Type.Integer({ minimum: 0 }),
    /** Agent rows with a NULL `type`: outside the estimate, counted out loud. */
    untypedAgents: Type.Integer({ minimum: 0 }),
    /** Distinct models the counterfactual was priced against, sorted. */
    hypotheticalModels: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export type AggregateDelegationSavingsDto = Static<typeof AggregateDelegationSavingsSchema>;

/** `GET /api/sessions/:id/cost-analysis` response (WP-C4 + WP-C5 over one session). */
export const CostAnalysisSchema = Type.Object(
  {
    compaction: CompactionAnalysisSchema,
    delegationSavings: DelegationSavingsSchema,
  },
  { additionalProperties: false },
);

export type CostAnalysisDto = Static<typeof CostAnalysisSchema>;
