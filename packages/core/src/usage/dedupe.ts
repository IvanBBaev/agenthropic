/**
 * Usage dedup by `message.id` — parser-spec section 5.2 (gate N3).
 *
 * Claude Code writes one JSONL line per content block, so many lines share a
 * `message.id`. On real data those lines are STREAMED PARTIALS of one message:
 * the `input` and cache buckets are byte-identical across them and only
 * `output` grows, with the final line carrying the true total. Dedup therefore
 * collapses each `message.id` to its PER-BUCKET MAXIMUM — equivalently the
 * final streamed state — never a sum. Naive row summation over-counts
 * substantially (every partial repeats the message's input/cache buckets), so
 * dedup is a correctness gate, not an optimization.
 *
 * PROVISIONAL (LABEL-ME): the original spec asserted the partials were fully
 * byte-identical and made ANY usage divergence a loud failure. Real transcripts
 * disprove that premise on TWO axes, both reconciled here by "the final streamed
 * row is ground truth":
 *   1. USAGE — only `output` grows across partials, so usage is collapsed to the
 *      per-bucket maximum (the final total) rather than asserted byte-identical.
 *   2. MODEL — the FIRST partial can carry a transient fast-mode routing label
 *      (e.g. `claude-fable-5`) that settles to the real model (`claude-opus-4-8`)
 *      on every later partial. The authoritative model is therefore the one on
 *      the row with the greatest `output` (the settled, complete state), never an
 *      early partial. Fast mode runs Opus, so the settled label is the true model.
 * A genuine model collision (two DISTINCT models tied at the SAME maximum output)
 * cannot arise from streaming and stays a loud failure, as does any `agentId`
 * disagreement (parser-spec 5.3 makes message ids per-agent-disjoint).
 */
import type { DedupedUsage, TokenBuckets, UsageRow } from '../types';

/**
 * Rows sharing a `messageId` disagree irreconcilably — two DISTINCT models tied
 * at the same maximum `output` (not a streaming fast-mode rename), or a differing
 * `agentId` — i.e. a corrupted / colliding substrate, so a loud failure.
 */
export class UsageConflictError extends Error {
  override readonly name = 'UsageConflictError';
}

/**
 * Model resolution state for one `messageId`: the model on the greatest-`output`
 * row seen so far (`model`), the `output` that anchors it, and any OTHER models
 * observed tied at that same maximum (`rivals`). A non-empty `rivals` after the
 * full pass is an unresolvable model collision — see {@link dedupeUsageByMessageId}.
 */
interface ModelPick {
  model: string;
  output: number;
  rivals: Set<string>;
}

const BUCKET_KEYS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
] as const satisfies ReadonlyArray<keyof TokenBuckets>;

function assertValidBuckets(row: UsageRow): void {
  for (const key of BUCKET_KEYS) {
    const value = row.usage[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new UsageConflictError(
        `message "${row.messageId}": bucket "${key}" is not a non-negative integer (got ${String(value)})`,
      );
    }
  }
}

/**
 * Collapses raw usage rows into exactly one entry per `messageId`, preserving
 * first-seen order and the first row's timestamp. Rows sharing a `messageId`
 * are streamed partials of one message, so their `usage` is collapsed to the
 * PER-BUCKET MAXIMUM (the final, complete usage) — never summed — and their
 * `model` is settled to the greatest-`output` row (early partials may carry a
 * transient fast-mode label; see the module doc).
 *
 * Throws {@link UsageConflictError} if two rows share a `messageId` but differ
 * in `agentId`, or carry two DISTINCT models tied at the same maximum `output`
 * (a collision streaming cannot produce). Parser-spec section 5.3 makes message
 * ids per-agent-disjoint, so such a case is a corrupted substrate and must fail
 * loudly, never be merged silently.
 */
export function dedupeUsageByMessageId(rows: readonly UsageRow[]): DedupedUsage[] {
  const byMessageId = new Map<string, DedupedUsage>();
  const modelPicks = new Map<string, ModelPick>();
  const deduped: DedupedUsage[] = [];

  for (const row of rows) {
    assertValidBuckets(row);
    const agentId = row.agentId ?? null;
    const seen = byMessageId.get(row.messageId);

    if (seen === undefined) {
      const entry: DedupedUsage = {
        messageId: row.messageId,
        model: row.model,
        timestamp: row.timestamp,
        usage: { ...row.usage },
        agentId,
      };
      byMessageId.set(row.messageId, entry);
      modelPicks.set(row.messageId, {
        model: row.model,
        output: row.usage.output,
        rivals: new Set(),
      });
      deduped.push(entry);
      continue;
    }

    if (seen.agentId !== agentId) {
      throw new UsageConflictError(
        `message "${row.messageId}": conflicting agent attribution ("${String(seen.agentId)}" vs "${String(agentId)}")`,
      );
    }

    // Settle the model to the greatest-`output` row. A strictly greater output
    // is a later (more complete) partial: adopt its model and drop stale rivals.
    // An equal-output row with a different model is a rival tied at the current
    // maximum — recorded, and if it survives to the global maximum it is a real
    // collision (thrown after the pass).
    const pick = modelPicks.get(row.messageId)!;
    if (row.usage.output > pick.output) {
      pick.model = row.model;
      pick.output = row.usage.output;
      pick.rivals.clear();
      seen.model = row.model;
    } else if (row.usage.output === pick.output && row.model !== pick.model) {
      pick.rivals.add(row.model);
    }

    // Streamed partials of one message: keep the per-bucket maximum, i.e. the
    // final complete usage (input/cache are constant; output grows to total).
    for (const key of BUCKET_KEYS) {
      if (row.usage[key] > seen.usage[key]) {
        seen.usage[key] = row.usage[key];
      }
    }
  }

  for (const [messageId, pick] of modelPicks) {
    const rival = [...pick.rivals][0];
    if (rival !== undefined) {
      throw new UsageConflictError(
        `message "${messageId}": conflicting model ("${pick.model}" vs "${rival}")`,
      );
    }
  }

  return deduped;
}
