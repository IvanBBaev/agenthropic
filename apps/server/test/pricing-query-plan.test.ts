/**
 * DAT-13: the per-row rate lookup in `pricedCte` must stay an index seek on
 * `model_pricing`. It is a correlated subquery that runs once per
 * `token_usage` row, so a plan that scans the pricing table or sorts its rows
 * would cost O(rows x prices) on the cross-session paths.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pricedCte } from '../src/api/queries';
import { createMigratedTempDb, type TempDb } from './helpers';

/** The `detail` column of EXPLAIN QUERY PLAN, one string per plan node. */
function planOf(temp: TempDb, sql: string, params: readonly string[]): string[] {
  return (
    temp.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      readonly detail: string;
    }>
  ).map((row) => row.detail);
}

const RATE_SEEK =
  'SEARCH mp USING INDEX sqlite_autoindex_model_pricing_1 (model=? AND bucket=? AND effective_from<?)';

describe('pricedCte query plan (DAT-13)', () => {
  let temp: TempDb | undefined;

  afterEach(() => {
    temp?.cleanup();
    temp = undefined;
  });

  it.each([
    ['unscoped', pricedCte(), []],
    ['scoped to one session', pricedCte('WHERE tu.session_id = ?'), ['s-1']],
  ] as const)('the %s rate lookup seeks the primary-key index', (_label, cte, params) => {
    temp = createMigratedTempDb();
    const plan = planOf(temp, `WITH ${cte} SELECT session_id, rate FROM priced`, params);

    expect(plan).toContain('CORRELATED SCALAR SUBQUERY 1');
    expect(plan).toContain(RATE_SEEK);
    // Never a scan of the pricing table, and no sort for ORDER BY ... LIMIT 1:
    // the index is walked backwards instead.
    expect(plan.filter((detail) => /\bSCAN mp\b/.test(detail))).toEqual([]);
    expect(plan.filter((detail) => detail.includes('TEMP B-TREE'))).toEqual([]);
  });

  it('the primary key the seek relies on is (model, bucket, effective_from)', () => {
    temp = createMigratedTempDb();
    const columns = (
      temp.db.prepare("PRAGMA index_info('sqlite_autoindex_model_pricing_1')").all() as Array<{
        readonly name: string;
      }>
    ).map((row) => row.name);

    expect(columns).toEqual(['model', 'bucket', 'effective_from']);
  });
});
