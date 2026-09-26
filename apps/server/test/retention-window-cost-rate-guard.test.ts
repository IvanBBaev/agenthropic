/**
 * Lane Z read-API audit (SA-Z2): the retention prune receipt prices the
 * window it is about to delete with its own SQL. That SQL must apply the same
 * rate-validity rule as the dashboard's priced CTE (finite, non-negative,
 * numeric), otherwise an invalid `model_pricing` row is served as a negative,
 * infinite or text-coerced dollar figure in the receipt while every dashboard
 * route reports the same tokens as UNPRICED.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { measureWindowCost } from '../src/db/retention-queries';
import { createMigratedTempDb, type TempDb } from './helpers';

const MTOK = 1_000_000;
const CUTOFF = '2026-08-01T00:00:00.000Z';

let temp: TempDb | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

function seed(pricingSql: string): TempDb {
  temp = createMigratedTempDb();
  temp.db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
      VALUES ('s1', 'p', '2026-07-10T00:00:00Z', '2026-07-10T02:00:00Z', 'active');
    INSERT INTO agents (id, session_id, type, status) VALUES ('s1', 's1', 'main', 'working');
    INSERT INTO token_usage
      (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
      VALUES ('s1', 's1', 'm1', 'm-x', 'input', ${MTOK}, 0, '2026-07-10T01:00:00Z');
    ${pricingSql}
  `);
  return temp;
}

function maxId(t: TempDb): number {
  return (t.db.prepare('SELECT MAX(id) AS m FROM token_usage').get() as { m: number }).m;
}

describe('SA-Z2: the prune receipt treats an invalid rate as unpriced', () => {
  it('control: a valid rate prices the window', () => {
    const t = seed(
      `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
         VALUES ('m-x', 'input', 3, '2026-01-01');`,
    );
    const impact = measureWindowCost(t.db, CUTOFF, maxId(t));
    expect(impact).toMatchObject({ tokens: MTOK, costUsd: 3, unpricedTokens: 0 });
    expect(impact.byModel).toEqual([{ model: 'm-x', tokens: MTOK, costUsd: 3, unpricedTokens: 0 }]);
  });

  it.each([
    ['a negative rate', '-3'],
    ['an infinite rate', '9e999'],
    ['a non-numeric text rate', `'abc'`],
    ['a numeric-prefixed text rate', `'3.00$'`],
  ])('%s', (_label, literal) => {
    const t = seed(
      `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
         VALUES ('m-x', 'input', ${literal}, '2026-01-01');`,
    );
    const impact = measureWindowCost(t.db, CUTOFF, maxId(t));
    expect(impact).toMatchObject({ tokens: MTOK, costUsd: 0, unpricedTokens: MTOK });
    expect(impact.byModel).toEqual([
      { model: 'm-x', tokens: MTOK, costUsd: 0, unpricedTokens: MTOK },
    ]);
  });

  it('an invalid LATEST rate does not fall back to an older valid one', () => {
    const t = seed(
      `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES
         ('m-x', 'input', 3, '2026-01-01'),
         ('m-x', 'input', -1, '2026-06-01');`,
    );
    expect(measureWindowCost(t.db, CUTOFF, maxId(t))).toMatchObject({
      costUsd: 0,
      unpricedTokens: MTOK,
    });
  });
});
