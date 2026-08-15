/**
 * Client-side "biggest burner" ranking over the served DAG nodes (review item
 * M-8). Per-agent usage is already persisted and served on every
 * `AgentNodeDto`, so this is a pure re-sort of ground truth - nothing here
 * estimates or infers a count.
 *
 * Ranking key is `totalTokens`, NOT `costUsd`: totalTokens is the sum over ALL
 * usage rows (unpriced included), so it is the true token burn even for an
 * agent whose model has no price row. Ranking by dollars would quietly demote
 * exactly the agents whose cost is unknown - the same class of lie as a
 * silent $0. The dollar figure and the unpriced gap are still carried on each
 * entry for display.
 *
 * Ties break by costUsd (desc), then id (asc), so the order is deterministic
 * across refetches - a ranking that reshuffles equal rows on every SSE-driven
 * reload would read as data movement that never happened.
 *
 * Agents with zero recorded tokens are excluded from the ranking (a burner
 * list of non-burners is noise), but their COUNT is returned so the view can
 * disclose the exclusion instead of making agents vanish.
 */
import type { AgentNodeDto } from '../dto';

export interface TopBurnersRanking {
  /** The top slice, at most `topN` entries, heaviest burn first. */
  readonly entries: readonly AgentNodeDto[];
  /** How many agents have recorded usage at all (entries is a slice of these). */
  readonly rankedCount: number;
  /** Agents excluded because they have zero recorded tokens. */
  readonly zeroUsageCount: number;
}

export function rankTopBurners(nodes: readonly AgentNodeDto[], topN: number): TopBurnersRanking {
  const ranked = nodes
    .filter((node) => node.totalTokens > 0)
    .sort((a, b) => {
      if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
      if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
      // Ids are unique (database primary key), so this final tiebreak is total.
      return a.id < b.id ? -1 : 1;
    });
  return {
    entries: ranked.slice(0, topN),
    rankedCount: ranked.length,
    zeroUsageCount: nodes.length - ranked.length,
  };
}
