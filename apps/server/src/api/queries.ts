/**
 * WP-U3/WP-U4 - read-only SQL behind the API routes. SELECT statements only:
 * every write path belongs to ingest, never to this layer.
 *
 * Cost discipline (the honesty rules of ux0-design):
 * - every dollar is tokens x a dated `model_pricing` rate - the rate is the
 *   latest row with `effective_from <= occurred_at` for the exact
 *   (model, bucket); nothing is ever invented;
 * - tokens with no resolvable rate (unknown model, missing timestamp, or no
 *   effective price yet) are counted in `unpricedTokens` and contribute $0 -
 *   surfaced, never silently priced;
 * - agents with a NULL status are counted in the `unknown` bucket - an absent
 *   status IS unknown, and hiding it would fake certainty;
 * - trees/DAGs are queries over persisted rows (`agents.parent_agent_id`,
 *   `orchestration_edges`), never a render-time reconstruction, and the edge
 *   `source` provenance is served verbatim.
 *
 * ARC-4 (2026-11-19): this file is now only the public entry point. The reads
 * live in `read-models/`, one module per read model (`sessions`, `cost`, `dag`,
 * `savings`, `changes`) over the pricing fragments in `read-models/shared`.
 * Importers keep importing from here; the export list below is the exact set
 * this module exported before the split.
 */
export { COST_USD, pricedCte } from './read-models/shared';
export {
  countSessions,
  getSessionDetail,
  getSessionEvents,
  getSessionTree,
  listSessions,
  type SessionListFilter,
} from './read-models/sessions';
export {
  type CostSummaryProbe,
  getCostSummary,
  getSessionProjectSlug,
  listSessionCostsAtLeast,
  type SessionCostRow,
  sessionExists,
} from './read-models/cost';
export { getGlobalDag, type GlobalDagProbe } from './read-models/dag';
export {
  type AggregateDelegationSavingsOptions,
  type DelegationSavingsProbe,
  getAggregateDelegationSavings,
} from './read-models/savings';
export {
  assertChangesInvariants,
  getChanges,
  ISO_INSTANT_PATTERN,
  normalizeSinceInstant,
} from './read-models/changes';
