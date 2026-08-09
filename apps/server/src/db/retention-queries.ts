/**
 * WP-D10 - the SQL behind retention pruning. SELECT + bounded DELETE only, on
 * the two PROJECTION tables; nothing here can reach the append-only substrate
 * or the persisted DAG (see `retention/policy.ts`
 * `RETENTION_PROTECTED_TABLES`).
 *
 * POLICY STATUS: mechanism only. The retention POLICY (how many days of what)
 * is unset and awaits Ivan's OPEN-1/2/3 ratification - see
 * `docs/analysis/open-decisions.md`. Nothing in this file runs unless a policy
 * is configured, and the default policy is a no-op.
 *
 * BOUNDING. A run must never hold the write lock for an unbounded time on a
 * multi-gigabyte database, so every statement works on a WINDOW: the first
 * `limit` expired rows in `id` order. The window is identified by its greatest
 * id, and the DELETE re-states the same predicate with `id <= maxId`. That set
 * is exactly the window - matches below `maxId` are by construction the ones
 * the window selected - so no id list, and therefore no SQLite host-parameter
 * limit, is involved.
 *
 * EXPIRY. Only rows with a KNOWN timestamp can expire: `occurred_at IS NOT
 * NULL AND occurred_at < cutoff`. A row of unknown age is never deleted by an
 * age rule. ISO-8601 UTC strings compare correctly as text (the same property
 * `api/queries.ts` relies on for dated pricing), so no date parsing is needed.
 *
 * INDEXES. Neither `events.occurred_at` nor `token_usage.occurred_at` is
 * indexed today, so the window scan is a table scan bounded by `LIMIT`. That
 * is acceptable for a bounded run and is called out in the WP-D10 report as a
 * proposed (unmade) migration: this lane may not author schema changes.
 */
import type { SqliteDatabase } from './connection';

/** The only tables retention may delete from. */
export type PrunableTable = 'events' | 'token_usage';

/** The bounded set of expired rows a single run will act on. */
export interface ExpiredWindow {
  /** Rows in the window (0 when nothing expired). */
  readonly rowsMatched: number;
  /** Greatest id in the window, or null when the window is empty. */
  readonly maxId: number | null;
  /** True when the window filled the budget - more rows may remain. */
  readonly budgetExhausted: boolean;
}

/** Per-model dollar impact of removing a window of `token_usage` rows. */
export interface ModelCostImpact {
  readonly model: string;
  readonly tokens: number;
  readonly costUsd: number;
  readonly unpricedTokens: number;
}

/**
 * What a `token_usage` prune takes off the books. `sessionsPartiallyPruned` is
 * the dangerous case worth naming: a session whose rows straddle the cutoff
 * keeps reporting a total, but a SMALLER one - the exact shape of a silently
 * wrong number, so it is counted and journalled rather than left to be noticed.
 */
export interface CostImpact {
  readonly tokens: number;
  readonly costUsd: number;
  readonly unpricedTokens: number;
  readonly byModel: readonly ModelCostImpact[];
  readonly sessionsAffected: number;
  readonly sessionsPartiallyPruned: number;
}

export const ZERO_COST_IMPACT: CostImpact = {
  tokens: 0,
  costUsd: 0,
  unpricedTokens: 0,
  byModel: [],
  sessionsAffected: 0,
  sessionsPartiallyPruned: 0,
};

/** Expiry predicate, written once and reused so window and DELETE cannot drift. */
const EXPIRED = 'occurred_at IS NOT NULL AND occurred_at < @cutoff';

/**
 * Statements per table, built from literal table names only. The table is a
 * closed union and is never interpolated from a caller-supplied string.
 */
const TABLE_SQL: Record<PrunableTable, { readonly window: string; readonly remove: string }> = {
  events: {
    window: `SELECT COUNT(*) AS rows_matched, MAX(id) AS max_id
             FROM (SELECT id FROM events WHERE ${EXPIRED} ORDER BY id LIMIT @limit)`,
    remove: `DELETE FROM events WHERE id <= @maxId AND ${EXPIRED}`,
  },
  token_usage: {
    window: `SELECT COUNT(*) AS rows_matched, MAX(id) AS max_id
             FROM (SELECT id FROM token_usage WHERE ${EXPIRED} ORDER BY id LIMIT @limit)`,
    remove: `DELETE FROM token_usage WHERE id <= @maxId AND ${EXPIRED}`,
  },
};

/**
 * The same dated-rate resolution `api/queries.ts` uses, restricted to the
 * window. Sharing the rule (not the module - that one is the read API's) is
 * what makes the journalled dollars equal the dollars the dashboard reported
 * for those rows before they were deleted.
 */
const WINDOW_COST_SQL = `
  WITH priced AS (
    SELECT
      tu.model AS model,
      tu.tokens AS tokens,
      (
        SELECT mp.usd_per_mtok
        FROM model_pricing mp
        WHERE mp.model = tu.model
          AND mp.bucket = tu.bucket
          AND tu.occurred_at IS NOT NULL
          AND mp.effective_from <= tu.occurred_at
        ORDER BY mp.effective_from DESC
        LIMIT 1
      ) AS rate
    FROM token_usage tu
    WHERE tu.id <= @maxId AND tu.occurred_at IS NOT NULL AND tu.occurred_at < @cutoff
  )
  SELECT
    model,
    SUM(tokens) AS tokens,
    SUM(CASE WHEN rate IS NOT NULL THEN tokens * rate / 1000000.0 ELSE 0 END) AS cost_usd,
    SUM(CASE WHEN rate IS NULL THEN tokens ELSE 0 END) AS unpriced_tokens
  FROM priced
  GROUP BY model
  ORDER BY cost_usd DESC, model ASC
`;

const WINDOW_SESSIONS_SQL = `
  WITH victims AS (
    SELECT DISTINCT session_id
    FROM token_usage
    WHERE id <= @maxId AND occurred_at IS NOT NULL AND occurred_at < @cutoff
  )
  SELECT
    (SELECT COUNT(*) FROM victims) AS sessions_affected,
    (
      SELECT COUNT(*)
      FROM victims v
      WHERE EXISTS (
        SELECT 1 FROM token_usage t
        WHERE t.session_id = v.session_id
          AND NOT (t.id <= @maxId AND t.occurred_at IS NOT NULL AND t.occurred_at < @cutoff)
      )
    ) AS sessions_partially_pruned
`;

/** Locate the bounded window of expired rows. Read-only. */
export function findExpiredWindow(
  db: SqliteDatabase,
  table: PrunableTable,
  cutoff: string,
  limit: number,
): ExpiredWindow {
  const row = db.prepare(TABLE_SQL[table].window).get({ cutoff, limit }) as {
    rows_matched: number;
    max_id: number | null;
  };
  return {
    rowsMatched: row.rows_matched,
    maxId: row.max_id,
    budgetExhausted: row.rows_matched >= limit,
  };
}

/**
 * Price a `token_usage` window WITHOUT touching it. Called before the delete
 * (and instead of it, in a dry run), so the receipt is computed from the rows
 * that are still there.
 */
export function measureWindowCost(db: SqliteDatabase, cutoff: string, maxId: number): CostImpact {
  const rows = db.prepare(WINDOW_COST_SQL).all({ cutoff, maxId }) as Array<{
    model: string;
    tokens: number;
    cost_usd: number;
    unpriced_tokens: number;
  }>;
  const sessions = db.prepare(WINDOW_SESSIONS_SQL).get({ cutoff, maxId }) as {
    sessions_affected: number;
    sessions_partially_pruned: number;
  };
  let tokens = 0;
  let costUsd = 0;
  let unpricedTokens = 0;
  const byModel: ModelCostImpact[] = [];
  for (const row of rows) {
    tokens += row.tokens;
    costUsd += row.cost_usd;
    unpricedTokens += row.unpriced_tokens;
    byModel.push({
      model: row.model,
      tokens: row.tokens,
      costUsd: row.cost_usd,
      unpricedTokens: row.unpriced_tokens,
    });
  }
  return {
    tokens,
    costUsd,
    unpricedTokens,
    byModel,
    sessionsAffected: sessions.sessions_affected,
    sessionsPartiallyPruned: sessions.sessions_partially_pruned,
  };
}

/** Delete exactly the measured window. Returns the number of rows removed. */
export function deleteExpiredWindow(
  db: SqliteDatabase,
  table: PrunableTable,
  cutoff: string,
  maxId: number,
): number {
  return db.prepare(TABLE_SQL[table].remove).run({ cutoff, maxId }).changes;
}
