/**
 * Shared pricing SQL fragments and the canonical-instant helper used by every read model.
 *
 * Split out of `api/queries.ts` (ARC-4, 2026-11-19), which stays the public
 * entry point and re-exports this module. The cost and honesty rules that
 * govern every read here are documented at the top of that file.
 */

/**
 * Shared CTE: every `token_usage` row with its resolved USD/Mtok rate (NULL
 * when no dated price applies). ISO-8601 strings compare correctly as text,
 * so `effective_from <= occurred_at` needs no date parsing.
 *
 * DAT-13 (2026-11-19): the rate subquery is correlated - it runs once per
 * `token_usage` row - so each run must be an index seek, never a scan of
 * `model_pricing`. The table's primary key `(model, bucket, effective_from)`
 * already serves it: equality on the first two columns, a range on the third,
 * and the ORDER BY ... DESC LIMIT 1 walks that index backwards, so no sort is
 * needed. No extra index is needed. Exported so a test can pin that plan.
 */
export function pricedCte(where = ''): string {
  return `
  priced AS (
    SELECT
      tu.session_id AS session_id,
      tu.agent_id AS agent_id,
      tu.model AS model,
      tu.tokens AS tokens,
      tu.occurred_at AS occurred_at,
      (
        -- The LATEST dated row decides; a rate that is not a finite,
        -- non-negative number resolves to NULL (unpriced) rather than to a
        -- negative, infinite or text-coerced dollar figure. It never falls
        -- back to an older row - that would price at a rate no longer in force.
        SELECT CASE
          WHEN typeof(mp.usd_per_mtok) IN ('integer', 'real')
            AND mp.usd_per_mtok >= 0
            AND mp.usd_per_mtok < 9e999
          THEN mp.usd_per_mtok
        END
        FROM model_pricing mp
        WHERE mp.model = tu.model
          AND mp.bucket = tu.bucket
          AND tu.occurred_at IS NOT NULL
          AND mp.effective_from <= tu.occurred_at
        ORDER BY mp.effective_from DESC
        LIMIT 1
      ) AS rate
    FROM token_usage tu
    ${where}
  )
`;
}

// Unscoped: the three per-session readers in `sessions.ts` (session detail's per-model
// split, the tree's usage_by_agent, and the unattributed probe) filter
// `priced` on `session_id` in the OUTER query. SQLite flattens the CTE and
// pushes that predicate into the scan - EXPLAIN QUERY PLAN on the migrated
// schema (2026-10-10, API-3) shows `SEARCH tu USING INDEX
// idx_token_usage_session_id` for all three, identical to the plan of an
// explicitly scoped `pricedCte('WHERE tu.session_id = ?')`. The scoped form
// is required only where the outer query cannot carry the predicate: the
// LEFT JOIN onto a GROUP BY (sessionSummarySelect) or a per-session
// statement with no outer query (getGlobalDag's usage cache).
export const PRICED_CTE = pricedCte();

/** USD over PRICED rows only - unpriced rows contribute $0, never a guess. */
export const COST_USD = `SUM(CASE WHEN rate IS NOT NULL THEN tokens * rate / 1000000.0 ELSE 0 END)`;

/** Tokens whose rate could not be resolved - surfaced, never hidden. */
export const UNPRICED = `SUM(CASE WHEN rate IS NULL THEN tokens ELSE 0 END)`;

/**
 * The canonical instant spelling, derived rather than trusted. Why every read
 * of `sessions`/`agents` timestamps goes through it: the timestamp-regime note
 * at the top of `changes.ts`.
 */
export function canonicalInstant(expr: string): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', ${expr})`;
}
