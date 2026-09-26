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
 * across refetches - a ranking that reshuffles equal rows on every refetch
 * (CostView fetches the DAG once per mount, not on SSE events) would read as
 * data movement that never happened.
 *
 * Agents with zero recorded tokens are excluded from the ranking (a burner
 * list of non-burners is noise), but their COUNT is returned so the view can
 * disclose the exclusion instead of making agents vanish.
 *
 * AMENDED 2026-09-03 (CA-6, CA-7): the two claims above - "zero recorded
 * tokens" and "deterministic across refetches" - were both false for a figure
 * this module cannot read. `api.ts` hands the payload over as `body as T`, an
 * unchecked cast with no runtime schema anywhere in this app, so an absent or
 * corrupt `totalTokens` arrives as a non-number: `> 0` is silently false and
 * the agent was filed under `zeroUsageCount`, i.e. reported to the reader as a
 * MEASURED zero. Unreadable burn (and a negative one, which is equally not a
 * count) now has its own bucket, and the three buckets sum to the served node
 * count so the view can account for every agent. Likewise `b.costUsd -
 * a.costUsd` yielded NaN for an unreadable dollar figure, and a NaN comparator
 * result is read by Array#sort as "these two are equal" - so the order fell
 * back to payload order and the table DID reshuffle on a refetch. The
 * comparator now returns only -1/0/1 and sorts unreadable figures last.
 */
import type { AgentNodeDto } from '../dto';

export interface TopBurnersRanking {
  /** The top slice, at most `topN` entries, heaviest burn first. */
  readonly entries: readonly AgentNodeDto[];
  /** How many agents have recorded usage at all (entries is a slice of these). */
  readonly rankedCount: number;
  /** Agents excluded because they have zero recorded tokens (a measured 0). */
  readonly zeroUsageCount: number;
  /**
   * Agents excluded because their served `totalTokens` is not a readable count
   * (absent, NaN, non-finite, or negative). Deliberately NOT folded into
   * `zeroUsageCount`: "we measured nothing" and "we cannot read what we
   * measured" are different facts and only one of them is a zero.
   */
  readonly unreadableUsageCount: number;
}

/** A served count is usable only if it is a finite, non-negative number. */
function isReadableUsage(totalTokens: number): boolean {
  return Number.isFinite(totalTokens) && totalTokens >= 0;
}

/**
 * Descending comparator that never returns NaN. Array#sort treats a NaN result
 * as 0, which silently makes the surrounding order depend on the input order;
 * an unreadable figure is instead ordered last and left to the id tiebreak.
 */
function compareUsageDesc(left: number, right: number): number {
  const leftReadable = Number.isFinite(left);
  const rightReadable = Number.isFinite(right);
  if (!leftReadable || !rightReadable) {
    if (leftReadable === rightReadable) return 0;
    return leftReadable ? -1 : 1;
  }
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

export function rankTopBurners(nodes: readonly AgentNodeDto[], topN: number): TopBurnersRanking {
  const readable = nodes.filter((node) => isReadableUsage(node.totalTokens));
  const ranked = readable
    .filter((node) => node.totalTokens > 0)
    .sort((a, b) => {
      const byTokens = compareUsageDesc(a.totalTokens, b.totalTokens);
      if (byTokens !== 0) return byTokens;
      const byCost = compareUsageDesc(a.costUsd, b.costUsd);
      if (byCost !== 0) return byCost;
      // Ids are unique (database primary key), so this final tiebreak is total.
      return a.id < b.id ? -1 : 1;
    });
  return {
    entries: ranked.slice(0, topN),
    rankedCount: ranked.length,
    zeroUsageCount: readable.length - ranked.length,
    unreadableUsageCount: nodes.length - readable.length,
  };
}
