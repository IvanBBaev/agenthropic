/**
 * Migration 16 - the rollup under BOTH multi-trigger firing orders, plus the
 * one state the equivalence suite cannot reach through the application.
 *
 * SQLITE DOES NOT SPECIFY THE ORDER IN WHICH SEVERAL TRIGGERS ON ONE EVENT
 * FIRE. Migration 15's canonicalizing `AFTER INSERT ON token_usage` and
 * migration 16's rollup `AFTER INSERT ON token_usage` sit on the same event,
 * and nothing in SQLite's documentation says which runs first. The build this
 * repository currently resolves to (measured, not assumed: see the
 * order-flipping guard test in each block) happens to fire triggers in REVERSE
 * CREATION ORDER, which puts migration 16's rollup trigger FIRST because it was
 * created later. That is an accident of the build, not a contract - a SQLite
 * upgrade, or a future migration that re-creates one of these triggers, may
 * invert it without warning.
 *
 * WHY THAT MATTERS. Two of migration 16's own claims are correct only in the
 * order the current build happens not to use:
 *
 *   - the subtract arm being a signed `INSERT ... ON CONFLICT` rather than a
 *     bare `UPDATE`, and
 *   - both timestamps in the key expression going through
 *     `strftime('%Y-%m-%dT%H:%M:%fZ', ...)`.
 *
 * In the current order neither is observable: the rollup row always already
 * exists by the time anything subtracts from it, and the raw spelling has
 * already been rewritten by the time the key is derived a second time. An
 * adversarial mutation of either survives every other test in this repository.
 * These tests INVERT the relative firing order of two triggers - without
 * changing either trigger's body - so the rollup is asserted correct under
 * EITHER order instead of being correct by accident of this build.
 *
 * THE MECHANISM. `recreateTriggerLast` reads a trigger's own `sql` text out of
 * `sqlite_master`, drops it, and re-creates it VERBATIM. The body is unchanged
 * byte for byte; only its position in creation order moves, which on this build
 * moves its position in firing order. Each block asserts that the re-creation
 * really happened (same normalized SQL, now the newest trigger on its table)
 * rather than assuming it.
 *
 * THE ORACLE HERE IS A COPY, NOT A SECOND OPINION. It is duplicated from
 * `db-token-usage-rollup-equivalence.test.ts`, which exports nothing (importing
 * a Vitest module would re-register its 61 tests into this file). Precisely:
 * `ORACLE_SQL`, `scanRollup`, `readRollup` and `diffRollup` are verbatim;
 * `expectRollupMatchesScan` is the same code minus its explanatory comment; and
 * `keyOf` is a RE-IMPLEMENTATION, not a copy - the equivalence version routes
 * through a `renderKeyPart` helper with a `<null>` branch, this one inlines an
 * `'' -> '<empty>'` ternary. The two agree on the five NOT NULL key columns,
 * which is every column they are used on here. Either way it is the same
 * oracle, reused - this file's contribution is the STATES it drives the schema
 * into, not a new way of checking the answer, and a bug in the oracle would be
 * invisible to both files alike.
 *
 * WHAT IS NOT PROVEN HERE. The `effective_from` block (the pricing half of the
 * key expression) is state coverage only: no mutation is known that it kills.
 * It says so at the block, with the reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCostSummary } from '../src/api/queries';
import type { SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

/** One rollup group, in the column spelling both the table and the oracle use. */
interface RollupRow {
  readonly session_id: string;
  readonly model: string;
  readonly bucket: string;
  readonly day: string;
  readonly rate_effective_from: string;
  readonly tokens: number;
  readonly row_count: number;
}

// --- the oracle (duplicated, not verbatim throughout - see the file docstring)

const ORACLE_SQL = `
  SELECT u.session_id AS session_id,
         u.model      AS model,
         u.bucket     AS bucket,
         IIF(u.occurred_at IS NULL, 'unknown', substr(u.occurred_at, 1, 10)) AS day,
         IFNULL(
           (SELECT p.effective_from
              FROM model_pricing p
             WHERE p.model = u.model
               AND p.bucket = u.bucket
               AND u.occurred_at IS NOT NULL
               AND p.effective_from <= u.occurred_at
             ORDER BY p.effective_from DESC
             LIMIT 1),
           ''
         ) AS rate_effective_from,
         SUM(u.tokens) AS tokens,
         COUNT(*)      AS row_count
    FROM token_usage u
   GROUP BY 1, 2, 3, 4, 5
   ORDER BY 1, 2, 3, 4, 5
`;

function scanRollup(db: SqliteDatabase): RollupRow[] {
  return db.prepare(ORACLE_SQL).all() as RollupRow[];
}

function readRollup(db: SqliteDatabase): RollupRow[] {
  return db
    .prepare(
      `SELECT session_id, model, bucket, day, rate_effective_from, tokens, row_count
         FROM token_usage_rollup
        ORDER BY 1, 2, 3, 4, 5`,
    )
    .all() as RollupRow[];
}

function keyOf(row: RollupRow): string {
  return [row.session_id, row.model, row.bucket, row.day, row.rate_effective_from]
    .map((part) => (part === '' ? '<empty>' : part))
    .join(' | ');
}

function diffRollup(scan: readonly RollupRow[], stored: readonly RollupRow[]): string[] {
  const diffs: string[] = [];
  const storedByKey = new Map(stored.map((row) => [keyOf(row), row]));
  for (const expected of scan) {
    const key = keyOf(expected);
    const actual = storedByKey.get(key);
    if (actual === undefined) {
      diffs.push(
        `MISSING from rollup: ${key} (scan says tokens=${String(expected.tokens)}, ` +
          `row_count=${String(expected.row_count)})`,
      );
      continue;
    }
    if (actual.tokens !== expected.tokens) {
      diffs.push(
        `tokens differ at ${key}: rollup=${String(actual.tokens)}, ` +
          `scan=${String(expected.tokens)}`,
      );
    }
    if (actual.row_count !== expected.row_count) {
      diffs.push(
        `row_count differs at ${key}: rollup=${String(actual.row_count)}, ` +
          `scan=${String(expected.row_count)}`,
      );
    }
  }
  const scanKeys = new Set(scan.map(keyOf));
  for (const actual of stored) {
    const key = keyOf(actual);
    if (!scanKeys.has(key)) {
      diffs.push(
        `EXTRA in rollup: ${key} (rollup says tokens=${String(actual.tokens)}, ` +
          `row_count=${String(actual.row_count)}; the scan produces no such group)`,
      );
    }
  }
  return diffs.sort();
}

function expectRollupMatchesScan(db: SqliteDatabase): RollupRow[] {
  const scan = scanRollup(db);
  const diffs = diffRollup(scan, readRollup(db));
  if (diffs.length > 0) {
    throw new Error(
      `token_usage_rollup diverges from the direct grouped scan:\n  ${diffs.join('\n  ')}`,
    );
  }
  return scan;
}

// --- the order-flipping mechanism -------------------------------------------

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function triggerSql(db: SqliteDatabase, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(name) as { sql: string } | undefined;
  if (row === undefined) {
    throw new Error(`trigger ${name} is not installed`);
  }
  return row.sql;
}

/** `sqlite_master` rowid - the order in which the schema objects were created. */
function creationRank(db: SqliteDatabase, name: string): number {
  const row = db
    .prepare("SELECT rowid AS rank FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(name) as { rank: number } | undefined;
  if (row === undefined) {
    throw new Error(`trigger ${name} is not installed`);
  }
  return row.rank;
}

/**
 * Move a trigger to the END of creation order by dropping it and re-creating it
 * from its OWN stored text. The body is unchanged byte for byte.
 *
 * SQLite does NOT specify which of several triggers on one event fires first.
 * The build this repository resolves to happens to fire them in reverse
 * creation order, so "created last" means "fires first" here - but that is an
 * observed property of this build, not a promise. These tests exist precisely
 * so the rollup is asserted correct under EITHER order rather than only under
 * the one today's SQLite happens to pick.
 */
function recreateTriggerLast(db: SqliteDatabase, name: string): void {
  const sql = triggerSql(db, name);
  db.exec(`DROP TRIGGER ${name};`);
  db.exec(`${sql};`);
}

/** Migration 15's canonicalizing `AFTER INSERT ON token_usage`, re-created last. */
function recreateCanonicalTriggerLast(db: SqliteDatabase): void {
  recreateTriggerLast(db, 'token_usage_occurred_at_canonical_insert');
}

/** Migration 16's rollup `AFTER INSERT ON token_usage`, re-created last. */
function recreateRollupTriggerLast(db: SqliteDatabase): void {
  recreateTriggerLast(db, 'token_usage_rollup_usage_insert');
}

/**
 * Guard the mechanism: the trigger really was re-installed with the identical
 * body, and it really is now the newest of the pair. Without this, a typo in a
 * trigger name would silently turn every test in the block into a test of the
 * unmodified schema.
 */
function expectRecreatedLast(
  db: SqliteDatabase,
  moved: string,
  other: string,
  before: string,
): void {
  expect(normalizeSql(triggerSql(db, moved))).toBe(normalizeSql(before));
  expect(creationRank(db, moved)).toBeGreaterThan(creationRank(db, other));
}

// --- fixtures ----------------------------------------------------------------

const SESSION = 's-order';
const MODEL = 'order-test-model';

/**
 * '2026-05-05T20:00:00-05:00' is 01:00Z on the SIXTH. It is the spelling whose
 * raw text and canonical form fall on DIFFERENT days, so a key derived from raw
 * text is distinguishable from one derived through `strftime`.
 */
const NON_CANONICAL = '2026-05-05T20:00:00-05:00';
const CANONICAL_DAY = '2026-05-06';

let messageSeq = 0;

function addUsage(
  db: SqliteDatabase,
  tokens: number,
  occurredAt: string | null,
  bucket = 'input',
): number {
  messageSeq += 1;
  const info = db
    .prepare(
      `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(SESSION, `order-msg-${String(messageSeq)}`, MODEL, bucket, tokens, occurredAt);
  return Number(info.lastInsertRowid);
}

function addRate(db: SqliteDatabase, effectiveFrom: string, usd = 5): void {
  db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
  ).run(MODEL, 'input', usd, effectiveFrom);
}

function countRows(db: SqliteDatabase, fromClause: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${fromClause}`).get() as { n: number }).n;
}

describe('migration 16 - token_usage_rollup under either multi-trigger firing order', () => {
  let temp: TempDb;
  let db: SqliteDatabase;

  beforeEach(() => {
    temp = createMigratedTempDb();
    db = temp.db;
    insertSession(db, SESSION);
  });

  afterEach(() => {
    temp.cleanup();
  });

  // --- migration 15's canonicalizer moved to the END of creation order -------

  describe("the occurred_at canonicalizer re-created LAST (it wins the event's start)", () => {
    it('re-installs the canonicalizer verbatim and makes it the newest of the pair', () => {
      const before = triggerSql(db, 'token_usage_occurred_at_canonical_insert');

      recreateCanonicalTriggerLast(db);

      expectRecreatedLast(
        db,
        'token_usage_occurred_at_canonical_insert',
        'token_usage_rollup_usage_insert',
        before,
      );
    });

    it('counts a non-canonical INSERT exactly once', () => {
      // In this order the canonicalizing rewrite runs BEFORE the rollup has any
      // row for the key, so the rewrite's nested AFTER UPDATE subtracts from a
      // key that does not exist yet. A signed upsert creates the row at -1 and
      // its own add brings it back to 0, the prune removes it, and the rollup's
      // AFTER INSERT then lands the single real row. A bare `UPDATE` in the
      // subtract arm would no-op instead, leaving the add uncancelled: 2000
      // tokens over 2 rows for one 1000-token row.
      recreateCanonicalTriggerLast(db);

      addUsage(db, 1_000, NON_CANONICAL);

      // `expectRollupMatchesScan` is what discriminates; the `scan[...]`
      // assertions below read the ORACLE, not the rollup, so they pin the
      // fixture - one ledger row, canonicalized in storage, one group.
      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe(CANONICAL_DAY);
      expect(scan[0]?.tokens).toBe(1_000);
      expect(scan[0]?.row_count).toBe(1);
      // A key derived from the raw text would file the same row under
      // '2026-05-05' and leave a zeroed ghost group behind.
      expect(readRollup(db)).toHaveLength(1);
    });

    it('resolves the rate from the canonical instant on a non-canonical INSERT', () => {
      // The rate starts at 00:00Z on the 6th. The raw text sorts BELOW it, the
      // canonical instant (01:00Z on the 6th) sits above it, so the resolved
      // `rate_effective_from` says which operand the key expression used.
      addRate(db, '2026-05-06T00:00:00.000Z', 9);
      recreateCanonicalTriggerLast(db);

      addUsage(db, 1_000, NON_CANONICAL);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.rate_effective_from).toBe('2026-05-06T00:00:00.000Z');
      expect(scan[0]?.tokens).toBe(1_000);
      expect(scan[0]?.row_count).toBe(1);
    });

    it('counts a non-canonical UPDATE exactly once', () => {
      // Migration 15 canonicalizes on UPDATE too, so the same inversion exists
      // on the update path and reaches the same absent-key subtract.
      const id = addUsage(db, 1_000, '2026-05-01T00:00:00.000Z');
      const before = triggerSql(db, 'token_usage_occurred_at_canonical_update');
      recreateTriggerLast(db, 'token_usage_occurred_at_canonical_update');
      expectRecreatedLast(
        db,
        'token_usage_occurred_at_canonical_update',
        'token_usage_rollup_usage_update',
        before,
      );

      db.prepare('UPDATE token_usage SET occurred_at = ? WHERE id = ?').run(NON_CANONICAL, id);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe(CANONICAL_DAY);
      expect(scan[0]?.tokens).toBe(1_000);
      expect(scan[0]?.row_count).toBe(1);
      expect(readRollup(db)).toHaveLength(1);
    });

    it('leaves nothing behind when a row that arrived non-canonical is DELETED', () => {
      // There is no canonicalizing AFTER DELETE trigger, so the inversion under
      // test is the one on the way IN: whatever the insert path left in the
      // rollup, the delete path must take back out exactly.
      recreateCanonicalTriggerLast(db);
      addUsage(db, 1_000, NON_CANONICAL);
      expect(countRows(db, 'token_usage')).toBe(1); // guard the guard

      db.prepare('DELETE FROM token_usage').run();

      expectRollupMatchesScan(db);
      expect(readRollup(db)).toEqual([]);
    });
  });

  // --- migration 16's rollup trigger moved to the END of creation order ------

  describe('the rollup trigger re-created LAST (it wins the event start instead)', () => {
    /*
     * The other direction - and, like the pricing block below, STATE COVERAGE
     * WITH NO KNOWN KILLING MUTATION. Measured: neither the bare-`UPDATE`
     * subtract arm nor the stripped-`strftime` key expression is observable in
     * this order, and both mutations leave this block green. Said plainly so
     * the block is not read as carrying its own weight against a mutant.
     *
     * What it is worth: on today's build this order is already the default, so
     * re-creating the trigger explicitly is what keeps this half covered if a
     * future SQLite, or a future migration that re-creates one of migration
     * 15's triggers, flips which one fires first. The block above would then be
     * testing the default and this one the exotic order; the pair covers both
     * either way, which is the point.
     */
    it('re-installs the rollup trigger verbatim and makes it the newest of the pair', () => {
      const before = triggerSql(db, 'token_usage_rollup_usage_insert');

      recreateRollupTriggerLast(db);

      expectRecreatedLast(
        db,
        'token_usage_rollup_usage_insert',
        'token_usage_occurred_at_canonical_insert',
        before,
      );
    });

    it('counts a non-canonical INSERT exactly once', () => {
      addRate(db, '2026-05-06T00:00:00.000Z', 9);
      recreateRollupTriggerLast(db);

      addUsage(db, 1_000, NON_CANONICAL);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe(CANONICAL_DAY);
      expect(scan[0]?.rate_effective_from).toBe('2026-05-06T00:00:00.000Z');
      expect(scan[0]?.tokens).toBe(1_000);
      expect(scan[0]?.row_count).toBe(1);
      expect(readRollup(db)).toHaveLength(1);
    });

    it('counts a non-canonical UPDATE exactly once', () => {
      const id = addUsage(db, 1_000, '2026-05-01T00:00:00.000Z');
      const before = triggerSql(db, 'token_usage_rollup_usage_update');
      recreateTriggerLast(db, 'token_usage_rollup_usage_update');
      expectRecreatedLast(
        db,
        'token_usage_rollup_usage_update',
        'token_usage_occurred_at_canonical_update',
        before,
      );

      db.prepare('UPDATE token_usage SET occurred_at = ? WHERE id = ?').run(NON_CANONICAL, id);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe(CANONICAL_DAY);
      expect(scan[0]?.tokens).toBe(1_000);
      expect(scan[0]?.row_count).toBe(1);
      expect(readRollup(db)).toHaveLength(1);
    });
  });

  // --- migration 14's canonicalizer moved to the END of creation order -------

  describe('the effective_from canonicalizer re-created LAST (pricing side)', () => {
    /*
     * STATE COVERAGE, NOT A PROOF - and this block says so rather than borrowing
     * the credibility of the two above.
     *
     * The `occurred_at` half of the key expression is order-SENSITIVE because
     * the rollup maintains it with signed deltas. The `effective_from` half is
     * not: migration 16 maintains it with a FULL REBUILD of the (model, bucket)
     * slice, and migration 14's canonicalizing rewrite is itself an
     * `UPDATE model_pricing`, which fires that rebuild again on its way out. So
     * whichever trigger goes first, the LAST rebuild always reads a pricing
     * table that is already canonical - which is exactly why no mutation of the
     * pricing side of the key expression is known to be observable here, and
     * why these two tests are NOT claimed to kill one. What they do is drive the
     * schema through an order no other test reaches and assert the rollup still
     * equals the direct scan there.
     */
    it('re-installs the pricing canonicalizer verbatim and makes it the newest', () => {
      const before = triggerSql(db, 'model_pricing_effective_from_canonical_insert');

      recreateTriggerLast(db, 'model_pricing_effective_from_canonical_insert');

      expectRecreatedLast(
        db,
        'model_pricing_effective_from_canonical_insert',
        'token_usage_rollup_pricing_insert',
        before,
      );
    });

    it('stays consistent when a rate arrives with a non-canonical effective_from', () => {
      // '2026-05-01T20:00:00-05:00' is 01:00Z on the SECOND, so it splits the
      // two ledger rows: the 22:00Z row on the first is still unpriced, the
      // 05:00Z row on the second resolves to the new rate.
      addUsage(db, 100, '2026-05-01T22:00:00.000Z');
      addUsage(db, 200, '2026-05-02T05:00:00.000Z');
      recreateTriggerLast(db, 'model_pricing_effective_from_canonical_insert');

      addRate(db, '2026-05-01T20:00:00-05:00', 9);

      const scan = expectRollupMatchesScan(db);
      // Guard the guard: the rate really landed canonical and really split the
      // ledger, so this is not asserting equivalence over an inert table.
      expect(countRows(db, `model_pricing WHERE effective_from = '2026-05-02T01:00:00.000Z'`)).toBe(
        1,
      );
      expect(scan.map((row) => [row.day, row.rate_effective_from, row.tokens])).toEqual([
        ['2026-05-01', '', 100],
        ['2026-05-02', '2026-05-02T01:00:00.000Z', 200],
      ]);
    });

    it('stays consistent when a rate is UPDATED to a non-canonical effective_from', () => {
      addUsage(db, 100, '2026-05-01T22:00:00.000Z');
      addUsage(db, 200, '2026-05-02T05:00:00.000Z');
      addRate(db, '2020-01-01T00:00:00.000Z', 3);
      const before = triggerSql(db, 'model_pricing_effective_from_canonical_update');
      recreateTriggerLast(db, 'model_pricing_effective_from_canonical_update');
      expectRecreatedLast(
        db,
        'model_pricing_effective_from_canonical_update',
        'token_usage_rollup_pricing_update',
        before,
      );

      db.prepare(
        `UPDATE model_pricing SET effective_from = '2026-05-01T20:00:00-05:00'
          WHERE model = ? AND bucket = 'input' AND effective_from = '2020-01-01T00:00:00.000Z'`,
      ).run(MODEL);

      const scan = expectRollupMatchesScan(db);
      expect(countRows(db, `model_pricing WHERE effective_from = '2026-05-02T01:00:00.000Z'`)).toBe(
        1,
      );
      expect(scan.map((row) => [row.day, row.rate_effective_from, row.tokens])).toEqual([
        ['2026-05-01', '', 100],
        ['2026-05-02', '2026-05-02T01:00:00.000Z', 200],
      ]);
    });
  });

  // --- the subtract arm, without depending on trigger order ------------------

  describe('subtracting from a key that has no rollup row', () => {
    /*
     * A DELIBERATELY CORRUPTED INTERMEDIATE STATE. Deleting a rollup row while
     * its ledger rows remain is something the application cannot do - the only
     * writers of `token_usage_rollup` are migration 16's six triggers, and every
     * one of them keeps the table equal to the scan. These tests reach that
     * state by hand, on purpose, because it is the ONE state in which the
     * subtract arm's shape is observable, and because reaching it needs no
     * assumption about which trigger SQLite fires first.
     *
     * The rollup is therefore NOT equal to the direct scan at the end of these
     * tests, and they do not claim it is. What they assert is the exact SIGNED
     * row the subtract arm must leave: a signed `INSERT ... ON CONFLICT` creates
     * the missing row at a negative count, a bare `UPDATE` silently loses it.
     */
    const KEY = {
      session_id: SESSION,
      model: MODEL,
      bucket: 'input',
      rate_effective_from: '',
    } as const;

    it('leaves a negative signed row when a DELETE hits a key with no rollup row', () => {
      const id = addUsage(db, 100, '2026-05-01T01:00:00.000Z');
      addUsage(db, 200, '2026-05-01T02:00:00.000Z');
      expect(readRollup(db)).toEqual([{ ...KEY, day: '2026-05-01', tokens: 300, row_count: 2 }]);

      db.prepare(
        `DELETE FROM token_usage_rollup
          WHERE session_id = ? AND model = ? AND bucket = 'input'
            AND day = '2026-05-01' AND rate_effective_from = ''`,
      ).run(SESSION, MODEL);
      db.prepare('DELETE FROM token_usage WHERE id = ?').run(id);

      // The subtract created the row it could not find. `row_count` is -1, not
      // 0, so the prune (which fires only at exactly 0) correctly leaves it.
      expect(readRollup(db)).toEqual([{ ...KEY, day: '2026-05-01', tokens: -100, row_count: -1 }]);
      // Stated in code: the state is corrupt by construction. This assertion
      // does NOT discriminate a bare-UPDATE subtract arm - both shapes diverge
      // from the scan here - it exists so the block cannot be misread as an
      // equivalence claim.
      expect(() => expectRollupMatchesScan(db)).toThrow(/diverges from the direct grouped scan/);
    });

    it('leaves a negative signed row when an UPDATE moves a key with no rollup row', () => {
      const id = addUsage(db, 100, '2026-05-01T01:00:00.000Z');
      addUsage(db, 200, '2026-05-01T02:00:00.000Z');
      expect(readRollup(db)).toEqual([{ ...KEY, day: '2026-05-01', tokens: 300, row_count: 2 }]);

      db.prepare(
        `DELETE FROM token_usage_rollup
          WHERE session_id = ? AND model = ? AND bucket = 'input'
            AND day = '2026-05-01' AND rate_effective_from = ''`,
      ).run(SESSION, MODEL);
      db.prepare('UPDATE token_usage SET occurred_at = ? WHERE id = ?').run(
        '2026-05-02T01:00:00.000Z',
        id,
      );

      // Two rows: the OLD key subtracted into existence at -1, and the NEW key
      // added normally. A bare `UPDATE` subtract arm produces only the second.
      expect(readRollup(db)).toEqual([
        { ...KEY, day: '2026-05-01', tokens: -100, row_count: -1 },
        { ...KEY, day: '2026-05-02', tokens: 100, row_count: 1 },
      ]);
      expect(() => expectRollupMatchesScan(db)).toThrow(/diverges from the direct grouped scan/);
    });

    /**
     * WHAT THE COST READ MAKES OF A NEGATIVE ROW. The two tests above establish
     * that the subtract arm can leave `tokens` and `row_count` NEGATIVE - by
     * design, so the prune (which fires at exactly 0) does not swallow the
     * evidence. `getCostSummary` now reads its dollars straight off this table,
     * so the negative row is worth following one step further than the table.
     *
     * MEASURED: the negative figures asserted below are what this test actually
     * observed when it was run. Nothing in the read clamps at zero and nothing
     * complains, so the negative propagates into the bill.
     */
    it('propagates a negative rollup row into a negative bill without complaint', () => {
      db.prepare(
        `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
         VALUES (?, 'input', 10, '2020-01-01T00:00:00.000Z')`,
      ).run(MODEL);
      const id = addUsage(db, 1_000_000, '2026-05-01T01:00:00.000Z');
      addUsage(db, 2_000_000, '2026-05-01T02:00:00.000Z');
      expect(getCostSummary(db, 5).totals).toEqual({
        tokens: 3_000_000,
        costUsd: 30,
        unpricedTokens: 0,
      });

      db.prepare(
        `DELETE FROM token_usage_rollup
          WHERE session_id = ? AND model = ? AND bucket = 'input' AND day = '2026-05-01'`,
      ).run(SESSION, MODEL);
      db.prepare('DELETE FROM token_usage WHERE id = ?').run(id);

      // The corrupt intermediate, as the two tests above describe it...
      expect(db.prepare('SELECT tokens, row_count FROM token_usage_rollup').all()).toEqual([
        { tokens: -1_000_000, row_count: -1 },
      ]);

      // ...and the bill that comes out of it. A NEGATIVE dollar figure, served
      // as a normal success, while the ledger plainly holds 2,000,000 tokens
      // worth $20. The response schema declares `minimum: 0` on all three of
      // these fields; nothing enforces it on the way out.
      expect(getCostSummary(db, 5).totals).toEqual({
        tokens: -1_000_000,
        costUsd: -10,
        unpricedTokens: 0,
      });
      expect(
        (db.prepare('SELECT SUM(tokens) AS n FROM token_usage').get() as { n: number }).n,
      ).toBe(2_000_000);
    });
  });
});
