/**
 * Usage dedup by `message.id` — parser-spec section 5.2 (gate N3).
 *
 * Claude Code writes one JSONL line per content block; every line sharing a
 * `message.id` carries an IDENTICAL `usage` block. Naive row summation
 * over-counts ~2.4-2.7x (corpus: 8,540 raw rows -> 3,339 messages; ~$900 of
 * phantom spend vs the true ~$346). Dedup is a correctness gate, not an
 * optimization.
 */
import type { DedupedUsage, TokenBuckets, UsageRow } from '../types';

/** Rows sharing a `messageId` disagree — corrupted substrate, loud failure. */
export class UsageConflictError extends Error {
  override readonly name = 'UsageConflictError';
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

function bucketsEqual(a: TokenBuckets, b: TokenBuckets): boolean {
  return BUCKET_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Collapses raw usage rows into exactly one entry per `messageId`, preserving
 * first-seen order and the first row's timestamp.
 *
 * Throws {@link UsageConflictError} if two rows share a `messageId` but differ
 * in `usage`, `model`, or `agentId` — parser-spec sections 5.2/5.3 guarantee
 * identical blocks and per-agent-disjoint message ids, so any divergence is a
 * corrupted substrate and must fail loudly, never be summed silently.
 */
export function dedupeUsageByMessageId(rows: readonly UsageRow[]): DedupedUsage[] {
  const byMessageId = new Map<string, DedupedUsage>();
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
      deduped.push(entry);
      continue;
    }

    if (seen.model !== row.model) {
      throw new UsageConflictError(
        `message "${row.messageId}": conflicting model ("${seen.model}" vs "${row.model}")`,
      );
    }
    if (!bucketsEqual(seen.usage, row.usage)) {
      throw new UsageConflictError(
        `message "${row.messageId}": conflicting usage blocks across rows`,
      );
    }
    if (seen.agentId !== agentId) {
      throw new UsageConflictError(
        `message "${row.messageId}": conflicting agent attribution ("${String(seen.agentId)}" vs "${String(agentId)}")`,
      );
    }
  }

  return deduped;
}
