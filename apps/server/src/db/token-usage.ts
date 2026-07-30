/**
 * WP-D8 - insert path for the LONG-format token_usage matrix.
 *
 * Each deduped `usage` block fans out to FIVE rows, one per priced bucket, so
 * the table is a complete queryable (message_id, bucket) matrix - zero-token
 * buckets are stored too. Dedup lives in the storage engine: INSERT OR IGNORE
 * against the UNIQUE (message_id, bucket) key, so replaying the same deduped
 * set - e.g. re-parsing a transcript - inserts exactly zero new rows.
 */
import type { DedupedUsage } from '@agenthropic/core';
import type { SqliteDatabase } from './connection';

export interface TokenUsageInsertResult {
  /** Total rows actually inserted (sum of statement changes). */
  readonly inserted: number;
}

/** The five priced buckets, paired with their `token_usage.bucket` snake-case names. */
const BUCKET_COLUMNS: readonly [keyof DedupedUsage['usage'], string][] = [
  ['input', 'input'],
  ['output', 'output'],
  ['cacheRead', 'cache_read'],
  ['cacheWrite5m', 'cache_write_5m'],
  ['cacheWrite1h', 'cache_write_1h'],
];

export function insertTokenUsageRows(
  db: SqliteDatabase,
  sessionId: string,
  deduped: readonly DedupedUsage[],
): TokenUsageInsertResult {
  const insertStatement = db.prepare(
    `INSERT OR IGNORE INTO token_usage
       (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  );

  const insertAll = db.transaction((entries: readonly DedupedUsage[]): number => {
    let inserted = 0;
    for (const entry of entries) {
      for (const [key, bucket] of BUCKET_COLUMNS) {
        const info = insertStatement.run(
          sessionId,
          entry.agentId,
          entry.messageId,
          entry.model,
          bucket,
          entry.usage[key],
          entry.timestamp,
        );
        inserted += info.changes;
      }
    }
    return inserted;
  });

  return { inserted: insertAll(deduped) };
}
