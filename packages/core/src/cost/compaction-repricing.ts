/**
 * WP-C4 — compaction-baseline preservation + re-pricing across PreCompact
 * (development-plan section 5, cost workstream; Phase-3 exit gate "PreCompact
 * reprices vs baseline").
 *
 * A `compact_boundary` resets the owning transcript's context: cache-read
 * baselines restart from the post-compaction summary, so a session's spend is
 * only honest when it is accounted PER COMPACTION SEGMENT — the pre-boundary
 * spend is the preserved baseline (WP-S6's "PreCompact baseline", whose
 * context-token size the boundary records as `preTokens`) and each post-boundary
 * segment accrues against its own fresh cache lineage. The oracle statement of
 * the plan is: a PreCompact session reprices to baseline + post-compaction
 * spend.
 *
 * The result therefore exposes BOTH figures so the delta is visible:
 * - `naiveUsd` — the boundary-blind single-pass sum over all deduped usage
 *   (exactly `computeCostUsd`), i.e. the naive baseline;
 * - `repricedUsd` — the sum of per-segment costs, each segment cut at its
 *   transcript's compaction boundaries;
 * - `deltaUsd` = `repricedUsd - naiveUsd`.
 *
 * RECONCILIATION INVARIANT: on a complete, correctly deduped substrate the
 * per-message usage rows are ground truth and cost is linear over them, so
 * `deltaUsd` MUST be ~0 (floating-point epsilon) — that equality IS the exit
 * gate ("reprices vs baseline, matching the oracle"). A materially nonzero
 * delta means rows were lost or double-assigned during segmentation and must
 * be treated as a loud mispricing signal, never averaged away. The per-segment
 * breakdown is what the naive sum cannot show: where each context reset falls,
 * the `preTokens` baseline it preserved, and how much of the spend belongs to
 * each cache lineage.
 *
 * Segmentation semantics:
 * - Boundaries are per-transcript events: a boundary with `agentId: null` cuts
 *   only the main agent's usage stream; a boundary carrying an agent hex cuts
 *   only that subagent's stream (compaction mid-agent).
 * - A usage row timestamped exactly at a boundary belongs to the segment the
 *   boundary OPENS (the boundary record precedes subsequent usage).
 * - Every transcript that carries usage or boundaries emits all
 *   `boundaryCount + 1` segments, empty ones included, so multiple resets stay
 *   visible even when a lineage recorded no priced usage.
 *
 * Pricing is delegated to `computeCostUsd`: an unknown model id or a missing
 * bucket price still HALTS with `PricingError` — never a silent $0.
 */
import type { DedupedUsage, PricingEntry, TokenBuckets } from '../types';
import type { CompactionBoundary } from '../parser/compaction';
import { computeCostUsd } from './compute-cost';
import { parseTimestampMs } from '../time';

/** One compaction-delimited slice of a single transcript's usage stream. */
export interface CompactionSegment {
  /** Owning transcript: `null` for the main agent, the agent hex for a subagent. */
  agentId: string | null;
  /** 0 = the pre-first-boundary segment; n = the segment opened by the n-th boundary. */
  index: number;
  /** The boundary that OPENED this segment; `null` for the initial segment. */
  boundary: CompactionBoundary | null;
  /** Cost of this segment's usage at dated per-bucket prices. */
  usd: number;
  /** Deduped messages priced into this segment. */
  messageCount: number;
  /** Per-bucket token sums of this segment. */
  tokens: TokenBuckets;
}

/** The WP-C4 comparison: naive boundary-blind sum vs compaction-segmented repricing. */
export interface CompactionRepricingResult {
  /** Boundary-blind single-pass cost of all deduped usage (the naive baseline). */
  naiveUsd: number;
  /** Sum of per-segment costs (baseline segment + each post-compaction segment). */
  repricedUsd: number;
  /** `repricedUsd - naiveUsd` — must be ~0 on a complete substrate; nonzero = mispricing. */
  deltaUsd: number;
  /** Total compaction boundaries supplied. */
  compactionCount: number;
  /** All segments, main transcript first, then subagents in first-seen order. */
  segments: CompactionSegment[];
}

const ZERO_BUCKETS: Readonly<TokenBuckets> = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

const BUCKET_KEYS = Object.keys(ZERO_BUCKETS) as ReadonlyArray<keyof TokenBuckets>;

interface TranscriptGroup {
  agentId: string | null;
  boundaries: Array<{ boundary: CompactionBoundary; ms: number }>;
  rows: DedupedUsage[];
}

/**
 * Groups usage rows and boundaries by owning transcript, ordered main-first
 * then by first appearance (usage order, then boundary order for
 * boundary-only transcripts).
 */
function groupByTranscript(
  dedupedUsage: readonly DedupedUsage[],
  boundaries: readonly CompactionBoundary[],
): TranscriptGroup[] {
  const groups = new Map<string | null, TranscriptGroup>();
  const ordered: TranscriptGroup[] = [];

  const groupFor = (agentId: string | null): TranscriptGroup => {
    let group = groups.get(agentId);
    if (group === undefined) {
      group = { agentId, boundaries: [], rows: [] };
      groups.set(agentId, group);
      if (agentId === null) {
        ordered.unshift(group); // Main transcript always reports first.
      } else {
        ordered.push(group);
      }
    }
    return group;
  };

  for (const row of dedupedUsage) {
    groupFor(row.agentId).rows.push(row);
  }
  for (const boundary of boundaries) {
    groupFor(boundary.agentId).boundaries.push({
      boundary,
      ms: parseTimestampMs(
        boundary.timestamp,
        `compaction boundary (agent ${boundary.agentId ?? 'main'})`,
      ),
    });
  }
  for (const group of ordered) {
    group.boundaries.sort((a, b) => a.ms - b.ms);
  }
  return ordered;
}

/**
 * Computes the compaction-aware cost of one session's deduped usage and the
 * comparison against the naive boundary-blind baseline (see the module doc for
 * the full WP-C4 semantics and the `deltaUsd` reconciliation invariant).
 *
 * `boundaries` come from `extractCompactionBoundaries` — `parseSession` does
 * not surface compaction markers, so extraction is a separate pure pass over
 * the raw substrate.
 *
 * @throws {PricingError} (from `computeCostUsd`) on an unknown model id or a
 *   missing/undated bucket price — never a silent $0.
 * @throws {RangeError} on an unparsable boundary or usage timestamp.
 */
export function computeCompactionAwareCost(
  dedupedUsage: readonly DedupedUsage[],
  boundaries: readonly CompactionBoundary[],
  pricing: readonly PricingEntry[],
): CompactionRepricingResult {
  const naiveUsd = computeCostUsd(dedupedUsage, pricing);

  const segments: CompactionSegment[] = [];
  let repricedUsd = 0;

  for (const group of groupByTranscript(dedupedUsage, boundaries)) {
    // Partition the transcript's rows: segment n is opened by boundary n-1 and
    // covers rows with boundary[n-1].ms <= row.ms < boundary[n].ms.
    const segmentRows: DedupedUsage[][] = Array.from(
      { length: group.boundaries.length + 1 },
      () => [],
    );
    for (const row of group.rows) {
      const rowMs = parseTimestampMs(row.timestamp, `usage message "${row.messageId}"`);
      let index = 0;
      for (const { ms } of group.boundaries) {
        if (ms <= rowMs) {
          index += 1;
        } else {
          break;
        }
      }
      segmentRows[index]!.push(row);
    }

    segmentRows.forEach((rows, index) => {
      const usd = computeCostUsd(rows, pricing);
      const tokens: TokenBuckets = { ...ZERO_BUCKETS };
      for (const row of rows) {
        for (const key of BUCKET_KEYS) {
          tokens[key] += row.usage[key];
        }
      }
      repricedUsd += usd;
      segments.push({
        agentId: group.agentId,
        index,
        boundary: index === 0 ? null : group.boundaries[index - 1]!.boundary,
        usd,
        messageCount: rows.length,
        tokens,
      });
    });
  }

  return {
    naiveUsd,
    repricedUsd,
    deltaUsd: repricedUsd - naiveUsd,
    compactionCount: boundaries.length,
    segments,
  };
}
