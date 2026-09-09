/**
 * Migration 16 - the standing EQUIVALENCE guard for `token_usage_rollup`.
 *
 * Migration 16 installs a persisted rollup of `token_usage`, keyed
 * `(session_id, model, bucket, day, rate_effective_from)`, maintained by six
 * triggers. Its own comment names the gap this file closes: the table is a
 * SHADOW - no reader is switched onto it - and "today the triggers below are
 * asserted by nothing". The whole value of the table is that it EQUALS a
 * direct grouped scan of `token_usage`, so that is the one thing every test
 * here ends by asserting, after every mutation shape the ledger admits.
 *
 * WHAT THE ORACLE IS, AND WHAT IT IS NOT. {@link ORACLE_SQL} is not imported
 * from `migrations.ts`, so an edit to the migration cannot silently edit the
 * check with it. That, and only that, is what its separateness buys. It is
 * otherwise a REWORDING of the same query shape, not a second route to the
 * answer: `IIF` is SQLite's documented shorthand for `CASE WHEN`, `IFNULL` is
 * two-argument `COALESCE`, and the correlated subquery, the `<=` direction, the
 * `ORDER BY ... DESC LIMIT 1` tie-break and the five-column `GROUP BY` are
 * structurally identical to the migration's. A defect that lives in that SHARED
 * SHAPE - a reversed comparison, a wrong tie-break, a wrong grain - would be
 * reproduced by the oracle and would NOT be detected here. What the oracle does
 * check, and checks well, is the TRIGGER MACHINERY: that six incremental
 * deltas, a prune and a slice rebuild keep arriving at the same answer as one
 * grouped scan, after every mutation shape the ledger admits.
 *
 * Its one real divergence from the migration is that it compares the STORED
 * timestamp text directly instead of re-deriving a canonical form. It leans on
 * migrations 14 and 15 - BEFORE guards that RAISE(ABORT) plus AFTER triggers
 * that rewrite, both with their own tests - having already stored canonical
 * `YYYY-MM-DDTHH:mm:ss.sssZ`, the only textual form where lexicographic order
 * and chronological order coincide, rather than on migration 16's own
 * `strftime(...)` wrapping. If the two ever disagree, one of them is wrong, and
 * this suite says which key.
 *
 * WHERE THE ANTI-VACUITY ACTUALLY COMES FROM. Not from the oracle. Three
 * anchors in this file state the expected answer as a literal computed by hand,
 * so no query in the system can agree with them by sharing a bug:
 *   1. the hardcoded rate/token/row tuples in property 2's "splits one
 *      (session, model, bucket, day) group across a mid-day rate change";
 *   2. the priced-join dollar figure in property 2's "prices the split day
 *      correctly" - $0.010, being 1000 tokens at $1/Mtok plus 1000 at $9/Mtok,
 *      a number neither the rollup nor the oracle can produce on its own;
 *   3. the offset-crossing literal days in property 5
 *      ('2026-05-05T20:00:00-05:00' and '2026-05-07T02:00:00+03:00' both land
 *      on '2026-05-06'), which are wrong under any raw-text key derivation.
 * Plus the first `describe` block, which deliberately corrupts the rollup four
 * different ways and asserts the shared assertion FAILS on each, with its own
 * distinct message. An equivalence suite that cannot fail is decoration.
 *
 * A SECOND, NON-SQL ORACLE, AND ITS NARROW SCOPE. {@link scanRollupInJs}
 * rebuilds the same grouping in JavaScript. It differs from {@link ORACLE_SQL}
 * in exactly ONE respect - it resolves dated rates by `Date.parse` epoch
 * comparison instead of by text order - and shares everything else, including
 * the `slice(0, 10)` day derivation. It is therefore evidence about RATE
 * RESOLUTION only, and it is cross-checked at two call sites rather than on
 * every mutation.
 *
 * WHAT IS PROVEN ONLY STRUCTURALLY, IN THIS FILE. Two of the migration's
 * claims - "the subtract arm is an upsert, not a bare UPDATE" (property 6) and
 * "the prune runs LAST rather than between the subtract and the add"
 * (property 7) - are asserted HERE by reading the installed trigger text out of
 * `sqlite_master` (SQLite executes a trigger body's statements in the order
 * written, so the text IS the order), and by nothing else in this file. The
 * `row_count = 1` outcome assertions that sit beside them do NOT upgrade the
 * claim: they hold identically whether the mechanism is present or not, because
 * every subtract in this file's scenarios targets a key row that already
 * exists, so a bare `UPDATE` would find it, and because the add re-creates
 * whatever a mid-body prune removed. Each block says so at the block.
 *
 * The upsert half of that is no longer structural-only in the REPOSITORY:
 * `db-token-usage-rollup-trigger-order.test.ts` re-creates migration 15's
 * canonicalizing trigger last, which on this build makes it fire first, and
 * then the subtract does reach a key row that does not exist yet. Property 6
 * points at it. The prune half stays structural everywhere - see property 7 for
 * the measurement and what it does and does not cover.
 *
 * NOT PROVEN HERE, and covered in sibling files instead:
 *   - migration 16's Step-1 backfill seed. `createMigratedTempDb()` migrates an
 *     EMPTY file, so every rollup this file inspects was built by the six
 *     triggers and the seed scan runs over zero rows.
 *     `db-token-usage-rollup-seed.test.ts` builds its databases by hand and
 *     covers it.
 *   - the rollup under an inverted multi-trigger firing order. SQLite does not
 *     specify which of several triggers on one event fires first;
 *     `db-token-usage-rollup-trigger-order.test.ts` drives both orders.
 *
 * NOT PROVEN ANYWHERE: the migration's COALESCE fallback arm on a non-NULL
 * timestamp that is not a date at all. See the last `describe` block - it is
 * unreachable through SQL and is left untested rather than reached by
 * disabling the guard that makes it unreachable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DedupedUsage } from '@agenthropic/core';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { upsertPricingRate } from '../src/db/pricing';
import { insertTokenUsageRows } from '../src/db/token-usage';
import { NO_RETENTION, type RetentionPolicy } from '../src/retention/policy';
import { prune } from '../src/retention/prune';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

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

interface UsageRowShape {
  readonly session_id: string;
  readonly model: string;
  readonly bucket: string;
  readonly tokens: number;
  readonly occurred_at: string | null;
}

interface RateRowShape {
  readonly model: string;
  readonly bucket: string;
  readonly effective_from: string;
}

/**
 * The oracle: what the rollup MUST contain, computed by one grouped scan of the
 * ledger.
 *
 * NOT an independent derivation - see the file docstring. `IIF` is `CASE WHEN`
 * renamed and `IFNULL` is two-argument `COALESCE` renamed; the subquery shape,
 * the `<=` direction, the `ORDER BY ... DESC LIMIT 1` tie-break and the
 * five-column `GROUP BY` are the migration's. A defect in that shared shape is
 * invisible to this oracle. Its two real jobs are (a) to be a SINGLE GROUPED
 * SCAN, so the six incremental triggers have something whole to be checked
 * against, and (b) to compare the stored timestamp text as-is, relying on
 * migrations 14/15 having canonicalized storage rather than on migration 16's
 * own `strftime` wrapping.
 */
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

/**
 * Render one key column for a divergence report.
 *
 * `''` and SQL NULL are DIFFERENT divergences - `''` is the rollup's encoding
 * of "no rate was in force", NULL is a violated NOT NULL - so they must not
 * print identically. Both key columns are declared NOT NULL on the stored side
 * and both oracle expressions are total, so NULL is not reachable through the
 * shipped schema today; this is a report-fidelity guard, not evidence that it
 * can happen.
 */
function renderKeyPart(part: string | null | undefined): string {
  if (part === null || part === undefined) {
    return '<null>';
  }
  return part === '' ? '<empty>' : part;
}

function keyOf(row: RollupRow): string {
  const parts: readonly (string | null | undefined)[] = [
    row.session_id,
    row.model,
    row.bucket,
    row.day,
    row.rate_effective_from,
  ];
  return parts.map(renderKeyPart).join(' | ');
}

/**
 * Row-for-row comparison producing a readable list of divergences, each naming
 * the key it happened at. An empty array is the proof; anything else is the
 * report.
 */
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

/**
 * THE shared assertion. Every mutation test ends by calling it. Returns the
 * oracle rows so a test can additionally assert what the correct answer IS,
 * not merely that the two agree.
 */
function expectRollupMatchesScan(db: SqliteDatabase): RollupRow[] {
  const scan = scanRollup(db);
  const diffs = diffRollup(scan, readRollup(db));
  if (diffs.length > 0) {
    // Thrown rather than `expect(diffs).toEqual([])` so the divergent keys
    // reach the failure message intact - a matcher on an array of strings
    // truncates them out of it, which is the one moment they matter.
    throw new Error(
      `token_usage_rollup diverges from the direct grouped scan:\n  ${diffs.join('\n  ')}`,
    );
  }
  return scan;
}

/**
 * The non-SQL oracle: the same grouping rebuilt in JavaScript, with dated-rate
 * resolution done by epoch milliseconds instead of by text order.
 *
 * SCOPE, stated narrowly: epoch-vs-text rate resolution is the ONLY thing this
 * function does differently from {@link ORACLE_SQL}. The day derivation is the
 * same `slice(0, 10)` of the same stored text, the grouping key is the same
 * five columns, and the '' / 'unknown' sentinels are the same. So it is a
 * cross-check on rate resolution, not a second opinion about the grain, and it
 * runs at its two explicit call sites rather than inside the shared assertion.
 *
 * Sorted with plain string comparison, which matches SQLite's BINARY collation
 * for the ASCII-only values these tests use.
 */
function scanRollupInJs(db: SqliteDatabase): RollupRow[] {
  const usage = db
    .prepare('SELECT session_id, model, bucket, tokens, occurred_at FROM token_usage')
    .all() as UsageRowShape[];
  const rates = db
    .prepare('SELECT model, bucket, effective_from FROM model_pricing')
    .all() as RateRowShape[];

  const groups = new Map<string, { key: string[]; tokens: number; rowCount: number }>();
  for (const row of usage) {
    const day = row.occurred_at === null ? 'unknown' : row.occurred_at.slice(0, 10);
    let rate = '';
    if (row.occurred_at !== null) {
      const at = Date.parse(row.occurred_at);
      let bestMs = Number.NEGATIVE_INFINITY;
      for (const candidate of rates) {
        if (candidate.model !== row.model || candidate.bucket !== row.bucket) {
          continue;
        }
        const from = Date.parse(candidate.effective_from);
        if (from <= at && from > bestMs) {
          bestMs = from;
          rate = candidate.effective_from;
        }
      }
    }
    const key = [row.session_id, row.model, row.bucket, day, rate];
    const mapKey = key.join('\u0000');
    const existing = groups.get(mapKey);
    if (existing === undefined) {
      groups.set(mapKey, { key, tokens: row.tokens, rowCount: 1 });
    } else {
      existing.tokens += row.tokens;
      existing.rowCount += 1;
    }
  }

  return [...groups.values()]
    .map((group) => ({
      session_id: group.key[0] ?? '',
      model: group.key[1] ?? '',
      bucket: group.key[2] ?? '',
      day: group.key[3] ?? '',
      rate_effective_from: group.key[4] ?? '',
      tokens: group.tokens,
      row_count: group.rowCount,
    }))
    .sort((a, b) => {
      const left = [a.session_id, a.model, a.bucket, a.day, a.rate_effective_from];
      const right = [b.session_id, b.model, b.bucket, b.day, b.rate_effective_from];
      for (let i = 0; i < left.length; i += 1) {
        const l = left[i] ?? '';
        const r = right[i] ?? '';
        if (l !== r) {
          return l < r ? -1 : 1;
        }
      }
      return 0;
    });
}

// --- structural helpers (properties 5, 6, 7, 8, 9) ---------------------------

const ROLLUP_TRIGGERS = [
  'token_usage_rollup_usage_insert',
  'token_usage_rollup_usage_update',
  'token_usage_rollup_usage_delete',
  'token_usage_rollup_pricing_insert',
  'token_usage_rollup_pricing_update',
  'token_usage_rollup_pricing_delete',
] as const;

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
  return normalizeSql(row.sql);
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const CANON_PREFIX = "strftime('%Y-%m-%dT%H:%M:%fZ', ";

function canonOf(ref: string): string {
  return `${CANON_PREFIX}${ref})`;
}

function fallbackOf(ref: string): string {
  return `COALESCE(${canonOf(ref)}, ${ref})`;
}

/**
 * Every use of a timestamp column inside a key expression must go through
 * `strftime('%Y-%m-%dT%H:%M:%fZ', ...)`. The two legitimate exceptions are the
 * COALESCE fallback's second operand and a bare `IS [NOT] NULL` test, which
 * reads no value. Anything else returned here is a raw-text key derivation -
 * exactly the trigger-order bug migration 16 says it avoids.
 */
function unwrappedTimestampUses(sql: string, ref: string): string[] {
  const stripped = sql.split(fallbackOf(ref)).join('').split(canonOf(ref)).join('');
  return stripped
    .split(ref)
    .slice(1)
    .filter((tail) => !/^ IS (NOT )?NULL/.test(tail))
    .map((tail) => `${ref}${tail.slice(0, 48)}`);
}

// --- fixtures ----------------------------------------------------------------

const SESSION = 's-rollup';
const OTHER_SESSION = 's-other';
/** No seeded rate exists for these, so `rate_effective_from` is '' unless a test adds one. */
const MODEL = 'rollup-test-model';
const SPLIT_MODEL = 'rollup-split-model';

let messageSeq = 0;

interface UsageInput {
  readonly tokens: number;
  readonly occurredAt: string | null;
  readonly sessionId?: string;
  readonly model?: string;
  readonly bucket?: string;
  readonly messageId?: string;
}

/** Raw-SQL ledger write: this suite tests STORAGE, not one writer. */
function addUsage(db: SqliteDatabase, input: UsageInput): number {
  messageSeq += 1;
  const info = db
    .prepare(
      `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId ?? SESSION,
      input.messageId ?? `msg-${String(messageSeq)}`,
      input.model ?? MODEL,
      input.bucket ?? 'input',
      input.tokens,
      input.occurredAt,
    );
  return Number(info.lastInsertRowid);
}

function addRate(db: SqliteDatabase, model: string, bucket: string, from: string, usd = 1): void {
  db.prepare(
    `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)`,
  ).run(model, bucket, usd, from);
}

function totalChanges(db: SqliteDatabase): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

/** Counts rows; `fromClause` may carry its own WHERE (test-local literals only). */
function countRows(db: SqliteDatabase, fromClause: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${fromClause}`).get() as { n: number }).n;
}

/** A representative ledger: several sessions, models, buckets, days and rates. */
function seedRichLedger(db: SqliteDatabase): void {
  addRate(db, MODEL, 'input', '2020-01-01', 5);
  addRate(db, MODEL, 'output', '2020-01-01', 25);
  addUsage(db, { tokens: 1_000, occurredAt: '2026-05-01T01:00:00.000Z' });
  addUsage(db, { tokens: 2_000, occurredAt: '2026-05-01T23:59:59.999Z' });
  addUsage(db, { tokens: 3_000, occurredAt: '2026-05-02T00:00:00.000Z', bucket: 'output' });
  addUsage(db, { tokens: 0, occurredAt: '2026-05-02T00:00:00.000Z', bucket: 'cache_read' });
  addUsage(db, { tokens: 7, occurredAt: null });
  addUsage(db, { tokens: 11, occurredAt: null, bucket: 'output' });
  addUsage(db, {
    tokens: 500,
    occurredAt: '2026-05-03T10:00:00.000Z',
    sessionId: OTHER_SESSION,
    model: 'rollup-unpriced-model',
  });
}

describe('migration 16 - token_usage_rollup equals a direct grouped scan', () => {
  let temp: TempDb;
  let db: SqliteDatabase;

  beforeEach(() => {
    temp = createMigratedTempDb();
    db = temp.db;
    insertSession(db, SESSION);
    insertSession(db, OTHER_SESSION);
  });

  afterEach(() => {
    temp.cleanup();
  });

  // --- the oracle itself ----------------------------------------------------

  describe('the oracle', () => {
    it('agrees with an independent JavaScript reconstruction of the same grain', () => {
      seedRichLedger(db);
      addRate(db, MODEL, 'input', '2026-05-02T00:00:00.000Z', 9);

      const sqlScan = scanRollup(db);
      expect(sqlScan.length).toBeGreaterThan(4); // guard the guard: non-trivial data
      expect(scanRollupInJs(db)).toEqual(sqlScan);
      expectRollupMatchesScan(db);
    });

    // The most important test in this file. If the assertion below cannot
    // fail, every other test in the suite is decoration.
    it('FAILS when the rollup over-counts tokens by one', () => {
      seedRichLedger(db);
      expectRollupMatchesScan(db);

      db.prepare('UPDATE token_usage_rollup SET tokens = tokens + 1').run();

      expect(() => expectRollupMatchesScan(db)).toThrow(/tokens differ at/);
    });

    it('FAILS when a rollup row is deleted behind the triggers back', () => {
      seedRichLedger(db);
      expectRollupMatchesScan(db);

      db.prepare("DELETE FROM token_usage_rollup WHERE day = '2026-05-01'").run();

      expect(() => expectRollupMatchesScan(db)).toThrow(/MISSING from rollup/);
    });

    it('FAILS when only row_count is wrong and tokens still add up', () => {
      seedRichLedger(db);
      expectRollupMatchesScan(db);

      db.prepare(
        "UPDATE token_usage_rollup SET row_count = row_count + 1 WHERE day = 'unknown'",
      ).run();

      expect(() => expectRollupMatchesScan(db)).toThrow(/row_count differs at/);
    });

    // The corruption class the COST READ cannot see. `rateFor` throws only when
    // a pointer resolves to NOTHING; a pointer moved onto a DIFFERENT REAL
    // pricing row resolves fine and prices at the wrong rate with no error
    // anywhere. This oracle is the only thing in the tree that catches it, so
    // it has to be proven to catch it.
    it('FAILS when a rollup row points at a DIFFERENT real rate epoch', () => {
      seedRichLedger(db);
      addRate(db, MODEL, 'input', '2026-05-02T00:00:00.000Z', 9);
      expectRollupMatchesScan(db);

      // Both epochs exist in model_pricing, so nothing about this row is
      // dangling - only wrong.
      const skewed = db
        .prepare(
          `UPDATE token_usage_rollup
              SET rate_effective_from = '2026-05-02T00:00:00.000Z'
            WHERE session_id = ? AND model = ? AND bucket = 'input'
              AND day = '2026-05-01' AND rate_effective_from = '2020-01-01T00:00:00.000Z'`,
        )
        .run(SESSION, MODEL);
      expect(skewed.changes).toBe(1); // a no-op UPDATE would make this vacuous

      const report = (() => {
        try {
          expectRollupMatchesScan(db);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return null;
      })();
      expect(report).not.toBeNull();
      // A moved key is one row missing and one row extra, not a value diff.
      expect(report).toMatch(/MISSING from rollup/);
      expect(report).toMatch(/EXTRA in rollup/);
      // Token totals are untouched, which is exactly why a sum-only check -
      // and the cost read, which sums - would have passed here.
      expect(
        db.prepare('SELECT SUM(tokens) AS n FROM token_usage_rollup').get() as { n: number },
      ).toEqual(db.prepare('SELECT SUM(tokens) AS n FROM token_usage').get() as { n: number });
    });

    it('FAILS when the rollup invents a group the ledger has no rows for', () => {
      seedRichLedger(db);
      expectRollupMatchesScan(db);

      db.prepare(
        `INSERT INTO token_usage_rollup
           (session_id, model, bucket, day, rate_effective_from, tokens, row_count)
         VALUES (?, ?, 'input', '2026-12-24', '', 42, 1)`,
      ).run(SESSION, MODEL);

      expect(() => expectRollupMatchesScan(db)).toThrow(/EXTRA in rollup/);
    });
  });

  // --- property 1: core equivalence after every mutation shape ---------------

  describe('property 1 - equivalence after every mutation shape', () => {
    it('holds for a single INSERT', () => {
      addUsage(db, { tokens: 1_234, occurredAt: '2026-05-01T01:00:00.000Z' });

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.tokens).toBe(1_234);
      expect(scan[0]?.row_count).toBe(1);
    });

    it('holds for a batch INSERT of many rows in one statement', () => {
      db.prepare(
        `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
         VALUES (?, NULL, 'b1', ?, 'input', 1, '2026-05-01T00:00:00.000Z'),
                (?, NULL, 'b2', ?, 'input', 2, '2026-05-01T00:00:00.000Z'),
                (?, NULL, 'b3', ?, 'output', 3, '2026-05-02T00:00:00.000Z')`,
      ).run(SESSION, MODEL, SESSION, MODEL, SESSION, MODEL);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(2);
      expect(countRows(db, 'token_usage_rollup')).toBe(2);
    });

    it("holds across the production writer's convergence upsert", () => {
      // insertTokenUsageRows fans one message out to five buckets and later
      // CORRECTS them in place when a fuller read arrives - an UPDATE that
      // changes tokens, model and occurred_at at once.
      const partial: DedupedUsage = {
        messageId: 'conv-1',
        model: MODEL,
        timestamp: '2026-05-01T01:00:00.000Z',
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        agentId: null,
      };
      insertTokenUsageRows(db, SESSION, [partial]);
      expectRollupMatchesScan(db);

      const settled: DedupedUsage = {
        ...partial,
        model: `${MODEL}-settled`,
        timestamp: '2026-05-02T01:00:00.000Z',
        usage: { input: 100, output: 900, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 0 },
      };
      const result = insertTokenUsageRows(db, SESSION, [settled]);
      expect(result.corrected).toBeGreaterThan(0); // guard the guard: an UPDATE really ran

      const scan = expectRollupMatchesScan(db);
      expect(scan.every((row) => row.day === '2026-05-02')).toBe(true);
    });

    it('holds for an UPDATE that moves the key across a day boundary', () => {
      const id = addUsage(db, { tokens: 500, occurredAt: '2026-05-01T23:00:00.000Z' });

      db.prepare('UPDATE token_usage SET occurred_at = ? WHERE id = ?').run(
        '2026-05-02T01:00:00.000Z',
        id,
      );

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe('2026-05-02');
    });

    it('holds for an UPDATE that moves the key to another model', () => {
      const id = addUsage(db, { tokens: 500, occurredAt: '2026-05-01T01:00:00.000Z' });
      addUsage(db, { tokens: 7, occurredAt: '2026-05-01T01:00:00.000Z' });

      db.prepare('UPDATE token_usage SET model = ? WHERE id = ?').run('another-model', id);

      const scan = expectRollupMatchesScan(db);
      expect(scan.map((row) => row.model).sort()).toEqual(['another-model', MODEL]);
    });

    it('holds for an UPDATE that moves the key to another bucket', () => {
      const id = addUsage(db, { tokens: 500, occurredAt: '2026-05-01T01:00:00.000Z' });

      db.prepare("UPDATE token_usage SET bucket = 'cache_write_1h' WHERE id = ?").run(id);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.bucket).toBe('cache_write_1h');
    });

    it('holds for an UPDATE that moves the key to another session', () => {
      const id = addUsage(db, { tokens: 500, occurredAt: '2026-05-01T01:00:00.000Z' });

      db.prepare('UPDATE token_usage SET session_id = ? WHERE id = ?').run(OTHER_SESSION, id);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.session_id).toBe(OTHER_SESSION);
    });

    it('holds for an UPDATE that does NOT move the key (tokens only)', () => {
      const id = addUsage(db, { tokens: 500, occurredAt: '2026-05-01T01:00:00.000Z' });
      addUsage(db, { tokens: 500, occurredAt: '2026-05-01T02:00:00.000Z' });

      db.prepare('UPDATE token_usage SET tokens = 1500 WHERE id = ?').run(id);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.tokens).toBe(2_000);
      expect(scan[0]?.row_count).toBe(2);
    });

    it('holds for a multi-row UPDATE in one statement', () => {
      seedRichLedger(db);

      db.prepare(
        "UPDATE token_usage SET occurred_at = '2026-06-01T00:00:00.000Z' WHERE occurred_at IS NOT NULL",
      ).run();

      const scan = expectRollupMatchesScan(db);
      expect(scan.some((row) => row.day === '2026-06-01')).toBe(true);
      expect(scan.some((row) => row.day === '2026-05-01')).toBe(false);
    });

    it('holds for a DELETE of one row out of a group', () => {
      const id = addUsage(db, { tokens: 500, occurredAt: '2026-05-01T01:00:00.000Z' });
      addUsage(db, { tokens: 700, occurredAt: '2026-05-01T02:00:00.000Z' });

      db.prepare('DELETE FROM token_usage WHERE id = ?').run(id);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.tokens).toBe(700);
      expect(scan[0]?.row_count).toBe(1);
    });

    it('holds for a DELETE of the LAST row of a group, which removes the row', () => {
      const id = addUsage(db, { tokens: 500, occurredAt: '2026-05-01T01:00:00.000Z' });
      addUsage(db, { tokens: 700, occurredAt: '2026-05-02T01:00:00.000Z' });
      expect(countRows(db, 'token_usage_rollup')).toBe(2);

      db.prepare('DELETE FROM token_usage WHERE id = ?').run(id);

      expectRollupMatchesScan(db);
      expect(countRows(db, 'token_usage_rollup')).toBe(1);
      expect(countRows(db, "token_usage_rollup WHERE day = '2026-05-01'")).toBe(0);
    });

    it('holds for an unqualified DELETE FROM token_usage', () => {
      seedRichLedger(db);
      expect(countRows(db, 'token_usage_rollup')).toBeGreaterThan(0);

      db.prepare('DELETE FROM token_usage').run();

      expectRollupMatchesScan(db);
      expect(countRows(db, 'token_usage_rollup')).toBe(0);
    });

    it('holds after a transaction that ROLLS BACK', () => {
      seedRichLedger(db);
      const before = readRollup(db);

      db.exec('BEGIN');
      addUsage(db, { tokens: 999_999, occurredAt: '2026-07-01T00:00:00.000Z' });
      db.prepare('DELETE FROM token_usage WHERE occurred_at IS NULL').run();
      db.exec('ROLLBACK');

      expectRollupMatchesScan(db);
      expect(readRollup(db)).toEqual(before);
    });

    it('holds when a SAVEPOINT is rolled back inside a COMMITTED transaction', () => {
      // A full ROLLBACK is the easy case - everything unwinds. A partial
      // rollback is the one that can leave the ledger and its shadow out of
      // step, because the surviving statements were interleaved with the undone
      // ones. Three shapes are undone here (an INSERT, a DELETE and an UPDATE),
      // and one INSERT taken before the savepoint survives the COMMIT.
      seedRichLedger(db);
      const before = readRollup(db);

      db.exec('BEGIN');
      const keptId = addUsage(db, { tokens: 42, occurredAt: '2026-07-01T00:00:00.000Z' });
      db.exec('SAVEPOINT partial');
      addUsage(db, { tokens: 999_999, occurredAt: '2026-07-02T00:00:00.000Z' });
      db.prepare('DELETE FROM token_usage WHERE occurred_at IS NULL').run();
      db.prepare('UPDATE token_usage SET tokens = 0 WHERE id = ?').run(keptId);
      db.exec('ROLLBACK TO partial');
      db.exec('RELEASE partial');
      db.exec('COMMIT');

      const scan = expectRollupMatchesScan(db);
      // The pre-savepoint INSERT survived, at its original token count.
      expect(scan.filter((row) => row.day === '2026-07-01')).toEqual([
        {
          session_id: SESSION,
          model: MODEL,
          bucket: 'input',
          day: '2026-07-01',
          rate_effective_from: '2020-01-01T00:00:00.000Z',
          tokens: 42,
          row_count: 1,
        },
      ]);
      // Everything the savepoint undid is undone in the rollup too: the new
      // day is absent and the deleted 'unknown' groups are back, byte for byte
      // as they were before the transaction opened.
      expect(scan.some((row) => row.day === '2026-07-02')).toBe(false);
      expect(readRollup(db).filter((row) => row.day !== '2026-07-01')).toEqual(before);
    });
  });

  // --- property 2: the grain pins the resolved pricing row -------------------

  describe('property 2 - the key pins the resolved rate, not merely the day', () => {
    beforeEach(() => {
      addRate(db, SPLIT_MODEL, 'input', '2020-01-01', 1);
      addUsage(db, { tokens: 1_000, occurredAt: '2026-05-01T01:00:00.000Z', model: SPLIT_MODEL });
      addUsage(db, { tokens: 1_000, occurredAt: '2026-05-01T05:00:00.000Z', model: SPLIT_MODEL });
    });

    it('splits one (session, model, bucket, day) group across a mid-day rate change', () => {
      const merged = expectRollupMatchesScan(db);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.tokens).toBe(2_000);

      addRate(db, SPLIT_MODEL, 'input', '2026-05-01T03:00:00.000Z', 9);

      const split = expectRollupMatchesScan(db);
      expect(split).toHaveLength(2);
      expect(split.every((row) => row.day === '2026-05-01')).toBe(true);
      expect(
        split.map((row) => [row.rate_effective_from, row.tokens, row.row_count]).sort(),
      ).toEqual([
        ['2020-01-01T00:00:00.000Z', 1_000, 1],
        ['2026-05-01T03:00:00.000Z', 1_000, 1],
      ]);
    });

    it('prices the split day correctly, which a day-only grain cannot', () => {
      addRate(db, SPLIT_MODEL, 'input', '2026-05-01T03:00:00.000Z', 9);
      expectRollupMatchesScan(db);

      // 1000 tokens at $1/Mtok plus 1000 tokens at $9/Mtok = $0.010.
      // A (session, model, day) rollup would hold 2000 tokens and one rate,
      // and could only answer $0.002 or $0.018 - both wrong, on exactly the
      // day an operator looks at.
      const priced = db
        .prepare(
          `SELECT SUM(r.tokens * p.usd_per_mtok) / 1000000.0 AS usd
             FROM token_usage_rollup r
             JOIN model_pricing p
               ON p.model = r.model AND p.bucket = r.bucket
              AND p.effective_from = r.rate_effective_from
            WHERE r.model = ?`,
        )
        .get(SPLIT_MODEL) as { usd: number };
      expect(priced.usd).toBeCloseTo(0.01, 10);
    });

    it('merges the two groups back into one when the mid-day rate is deleted', () => {
      addRate(db, SPLIT_MODEL, 'input', '2026-05-01T03:00:00.000Z', 9);
      expect(expectRollupMatchesScan(db)).toHaveLength(2);

      db.prepare(
        `DELETE FROM model_pricing
          WHERE model = ? AND bucket = 'input' AND effective_from = '2026-05-01T03:00:00.000Z'`,
      ).run(SPLIT_MODEL);

      const merged = expectRollupMatchesScan(db);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.tokens).toBe(2_000);
      expect(merged[0]?.row_count).toBe(2);
    });

    it("collapses every group in a slice to '' when its LAST rate is deleted", () => {
      // The tests above always leave one rate standing, so the recompute always
      // has something to resolve. Removing the last rate of a (model, bucket)
      // slice is the shape where the rebuild must produce the '' sentinel for
      // EVERY group at once, including the 'unknown' day - and where a rebuild
      // that skipped rows with no resolvable rate would silently drop tokens.
      addRate(db, MODEL, 'input', '2020-01-01', 5);
      addUsage(db, { tokens: 100, occurredAt: '2026-05-01T01:00:00.000Z' });
      addUsage(db, { tokens: 200, occurredAt: '2026-05-02T01:00:00.000Z' });
      addUsage(db, { tokens: 7, occurredAt: null });
      const slice = (rows: readonly RollupRow[]): RollupRow[] =>
        rows.filter((row) => row.model === MODEL);
      expect(slice(readRollup(db)).filter((row) => row.rate_effective_from !== '')).toHaveLength(2);

      db.prepare("DELETE FROM model_pricing WHERE model = ? AND bucket = 'input'").run(MODEL);
      expect(countRows(db, `model_pricing WHERE model = '${MODEL}'`)).toBe(0); // guard the guard

      const scan = expectRollupMatchesScan(db);
      expect(
        slice(scan).map((row) => [row.day, row.rate_effective_from, row.tokens, row.row_count]),
      ).toEqual([
        ['2026-05-01', '', 100, 1],
        ['2026-05-02', '', 200, 1],
        ['unknown', '', 7, 1],
      ]);
      // The untouched slice is proof the DELETE's recompute stayed inside its
      // own (model, bucket): SPLIT_MODEL's rate is still resolved.
      expect(
        scan.filter((row) => row.model === SPLIT_MODEL && row.rate_effective_from === ''),
      ).toEqual([]);
    });
  });

  // --- property 3: zero-token groups are real groups -------------------------

  describe('property 3 - a row is dropped on row_count 0, never on tokens 0', () => {
    it('keeps a group whose tokens fall to zero while rows remain', () => {
      const id = addUsage(db, { tokens: 900, occurredAt: '2026-05-01T01:00:00.000Z' });
      addUsage(db, { tokens: 0, occurredAt: '2026-05-01T02:00:00.000Z' });

      db.prepare('UPDATE token_usage SET tokens = 0 WHERE id = ?').run(id);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.tokens).toBe(0);
      expect(scan[0]?.row_count).toBe(2);
    });

    it('keeps a group made entirely of zero-token rows', () => {
      addUsage(db, { tokens: 0, occurredAt: '2026-05-01T01:00:00.000Z', bucket: 'cache_write_5m' });

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.tokens).toBe(0);
      expect(scan[0]?.row_count).toBe(1);
    });

    it('drops the group only when its last row leaves', () => {
      const id = addUsage(db, { tokens: 0, occurredAt: '2026-05-01T01:00:00.000Z' });
      expect(countRows(db, 'token_usage_rollup')).toBe(1);

      db.prepare('DELETE FROM token_usage WHERE id = ?').run(id);

      expectRollupMatchesScan(db);
      expect(countRows(db, 'token_usage_rollup')).toBe(0);
    });
  });

  // --- property 4: total, non-NULL key encodings -----------------------------

  describe('property 4 - both absent key values have a total non-NULL encoding', () => {
    it("encodes a NULL occurred_at as day 'unknown' and merges such rows into ONE group", () => {
      addUsage(db, { tokens: 1, occurredAt: null });
      addUsage(db, { tokens: 2, occurredAt: null });
      addUsage(db, { tokens: 3, occurredAt: null });

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe('unknown');
      // The point of the sentinel: NULLs are DISTINCT in a uniqueness
      // constraint, so a NULL key column would leave three un-mergeable rows.
      expect(scan[0]?.row_count).toBe(3);
      expect(scan[0]?.tokens).toBe(6);
    });

    it("encodes an unresolved rate as '' and merges such rows into ONE group", () => {
      addUsage(db, { tokens: 10, occurredAt: '2026-05-01T01:00:00.000Z' });
      addUsage(db, { tokens: 20, occurredAt: '2026-05-01T02:00:00.000Z' });

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.rate_effective_from).toBe('');
      expect(scan[0]?.row_count).toBe(2);
    });

    it("resolves to '' when every rate starts AFTER the usage instant", () => {
      addRate(db, MODEL, 'input', '2026-09-01', 5);
      addUsage(db, { tokens: 10, occurredAt: '2026-05-01T01:00:00.000Z' });

      const scan = expectRollupMatchesScan(db);
      expect(scan[0]?.rate_effective_from).toBe('');
    });

    it('never stores NULL in any key column', () => {
      seedRichLedger(db);
      addUsage(db, { tokens: 5, occurredAt: null, model: 'rollup-unpriced-model' });

      expectRollupMatchesScan(db);
      expect(
        countRows(
          db,
          `token_usage_rollup WHERE session_id IS NULL OR model IS NULL OR bucket IS NULL
             OR day IS NULL OR rate_effective_from IS NULL`,
        ),
      ).toBe(0);
    });
  });

  // --- property 5: the key is derived from the instant, not the text ---------

  describe('property 5 - the key is never derived from raw timestamp text', () => {
    // NAMED FOR WHAT IT PROVES. An earlier name claimed this block showed the
    // key "survives an unspecified trigger firing order", which it does not: no
    // test here induces an alternative order, so every one of them runs in
    // whatever order this build happens to pick. What they do show is that the
    // stored key lands on the CANONICAL INSTANT - the offset spellings below
    // fall on a different day than their raw text does, and the rate case
    // resolves against a rate the raw text sorts below.
    //
    // The order property itself is exercised in
    // `db-token-usage-rollup-trigger-order.test.ts`, which re-creates one of
    // the two triggers on the event so it moves to the other end of creation
    // order. SQLite does not specify multi-trigger firing order at all; that
    // file's own docstring says so, and says that reverse-creation-order is an
    // observed property of this build rather than a contract.
    const SPELLINGS: readonly [string, string, string][] = [
      ['bare UTC date', '2026-05-01', '2026-05-01'],
      ['second precision Z', '2026-05-01T10:00:05Z', '2026-05-01'],
      ['millisecond precision Z', '2026-05-01T10:00:05.250Z', '2026-05-01'],
      // The offset form is the one that crosses a day boundary: 20:00-05:00 on
      // the 5th is 01:00Z on the 6th, so a key derived from the RAW text would
      // file the spend under the wrong day.
      ['negative offset crossing midnight', '2026-05-05T20:00:00-05:00', '2026-05-06'],
      ['positive offset crossing midnight', '2026-05-07T02:00:00+03:00', '2026-05-06'],
    ];

    for (const [label, spelling, expectedDay] of SPELLINGS) {
      it(`lands on the canonical day for a ${label}`, () => {
        addUsage(db, { tokens: 1_000, occurredAt: spelling });

        const scan = expectRollupMatchesScan(db);
        expect(scan).toHaveLength(1);
        expect(scan[0]?.day).toBe(expectedDay);
        // Exactly one row counted: the nested fire of migration 15's rewrite
        // subtracts and re-adds the SAME key, so it cancels rather than
        // double-counting.
        expect(scan[0]?.row_count).toBe(1);
        expect(scan[0]?.tokens).toBe(1_000);
      });
    }

    it('lands on the same key when a non-canonical spelling arrives by UPDATE', () => {
      const id = addUsage(db, { tokens: 1_000, occurredAt: '2026-05-01T00:00:00.000Z' });

      db.prepare('UPDATE token_usage SET occurred_at = ? WHERE id = ?').run(
        '2026-05-05T20:00:00-05:00',
        id,
      );

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe('2026-05-06');
      expect(scan[0]?.row_count).toBe(1);
    });

    it('resolves the rate from the canonical instant, not the raw text', () => {
      // '2026-02-28T20:00:00-05:00' is one hour AFTER '2026-03-01T00:00:00Z'
      // but sorts BELOW it as text - the exact defect migration 15 exists for.
      addRate(db, MODEL, 'input', '2026-03-01T00:00:00.000Z', 9);
      addUsage(db, { tokens: 1_000, occurredAt: '2026-02-28T20:00:00-05:00' });

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.rate_effective_from).toBe('2026-03-01T00:00:00.000Z');
    });

    it('derives every key expression through strftime, in all six triggers', () => {
      const refsByTrigger: Record<string, readonly string[]> = {
        token_usage_rollup_usage_insert: ['NEW.occurred_at', 'mp.effective_from'],
        token_usage_rollup_usage_update: [
          'NEW.occurred_at',
          'OLD.occurred_at',
          'mp.effective_from',
        ],
        token_usage_rollup_usage_delete: ['OLD.occurred_at', 'mp.effective_from'],
        token_usage_rollup_pricing_insert: ['tu.occurred_at', 'mp.effective_from'],
        token_usage_rollup_pricing_update: ['tu.occurred_at', 'mp.effective_from'],
        token_usage_rollup_pricing_delete: ['tu.occurred_at', 'mp.effective_from'],
      };
      for (const name of ROLLUP_TRIGGERS) {
        const sql = triggerSql(db, name);
        for (const ref of refsByTrigger[name] ?? []) {
          expect(countOf(sql, ref)).toBeGreaterThan(0); // guard the guard
          expect(unwrappedTimestampUses(sql, ref)).toEqual([]);
        }
      }
    });
  });

  // --- property 6: the subtract arm is an upsert -----------------------------

  describe('property 6 - the subtract arm is an upsert, not a bare UPDATE', () => {
    // STRUCTURAL IN THIS FILE, and said plainly: every subtract reachable from
    // a test here targets a key row that ALREADY EXISTS, so a bare
    // `UPDATE ... SET tokens = tokens - OLD.tokens` would find its row and
    // behave identically. That includes the netted outcome below - it holds
    // under a bare UPDATE too. What is asserted here is the installed text
    // (SQLite runs a trigger body in written order), not an observed defect.
    //
    // BEHAVIOURAL COVERAGE LIVES NEXT DOOR.
    // `db-token-usage-rollup-trigger-order.test.ts` re-creates migration 15's
    // canonicalizing trigger LAST, which on this build moves it to the front of
    // the firing order (SQLite specifies no order at all - that file says so).
    // In that order the canonicalizing rewrite fires before the rollup has any
    // row for the key, so the nested AFTER UPDATE's subtract reaches a key row
    // that does not exist, and only a signed upsert cancels. Measured on a
    // scratch database with the subtract arm rewritten to a bare UPDATE and the
    // canonicalizer re-created last: 2000 tokens over 2 rows for one
    // 1000-token row, against 1000 over 1 pristine.
    it('subtracts with INSERT ... ON CONFLICT in both subtracting triggers', () => {
      const update = triggerSql(db, 'token_usage_rollup_usage_update');
      const del = triggerSql(db, 'token_usage_rollup_usage_delete');

      expect(countOf(update, 'INSERT INTO token_usage_rollup')).toBe(2);
      expect(countOf(update, 'ON CONFLICT')).toBe(2);
      expect(update).toContain('-OLD.tokens, -1');
      expect(update).toContain('NEW.tokens, 1');

      expect(countOf(del, 'INSERT INTO token_usage_rollup')).toBe(1);
      expect(countOf(del, 'ON CONFLICT')).toBe(1);
      expect(del).toContain('-OLD.tokens, -1');

      // A bare `UPDATE token_usage_rollup SET tokens = tokens - OLD.tokens`
      // would silently no-op on a row that does not exist yet.
      expect(update).not.toContain('UPDATE token_usage_rollup ');
      expect(del).not.toContain('UPDATE token_usage_rollup ');
    });

    it('nets to exactly one counted row when migration 15 rewrites the timestamp', () => {
      // The rewrite fires the rollup's AFTER UPDATE from inside the AFTER
      // INSERT's event. Whichever order SQLite picks, the subtract and the add
      // must cancel: row_count 2 would mean the add ran twice, row_count 0
      // would mean the subtract ran without its add.
      //
      // This runs in whatever order THIS build picks - the test does not force
      // one and cannot tell which it got. The same scenario under the OTHER
      // order is what makes the upsert claim behavioural, and it lives in
      // `db-token-usage-rollup-trigger-order.test.ts`, not here.
      addUsage(db, { tokens: 4_242, occurredAt: '2026-05-05T20:00:00-05:00' });

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.row_count).toBe(1);
      expect(scan[0]?.tokens).toBe(4_242);
    });
  });

  // --- property 7: the prune runs last ---------------------------------------

  describe('property 7 - the prune is the LAST statement of every subtracting body', () => {
    // STRUCTURAL, but narrower than "the prune's position is untested". Two
    // different displacements have to be told apart, and only one of them is
    // invisible:
    //
    //   - Prune moved to the FRONT of the body is BEHAVIOURAL, and already
    //     caught by tests in this file. It then runs before the subtract that
    //     takes a group to 0, so nothing ever removes that group and a
    //     `{tokens: 0, row_count: 0}` ghost survives at OLD's key. Measured on
    //     a scratch database with both subtracting bodies reordered (mutant
    //     m20), against the whole server suite: 16 tests fail across all three
    //     rollup files, the shared assertion reporting the ghost as EXTRA in
    //     rollup. Note which DELETE tests those are - `holds for a DELETE of
    //     one row out of a group` PASSES (the group never reaches 0, so the
    //     misplaced prune has nothing to skip); it is `... of the LAST row of a
    //     group` and the unqualified DELETE that fail, along with the
    //     day-boundary UPDATE, four further property-1 UPDATE tests, property
    //     3, property 5, property 10 twice, the seed suite and three
    //     trigger-order tests. Do not read that list as a promise: it is one
    //     measurement of one displacement, and any new test can change it.
    //   - Prune moved BETWEEN the subtract and the add - which is the exact
    //     claim migration 16's comment makes, "runs LAST so a group that
    //     momentarily reaches 0 is not dropped" - is INVISIBLE. Measured the
    //     same way, all six scenarios produced a byte-identical rollup, because
    //     the add re-creates whatever the prune removed at the same key, and at
    //     a different key the prune finds nothing to remove either way.
    //
    // So the assertion below is what covers the second case, and it covers it
    // by reading the SQL, not by observing a failure. SQLite honours the
    // written order of a trigger body, so the text IS the order - but the text
    // is all this is.
    it('places the DELETE after every INSERT in the update and delete triggers', () => {
      for (const name of ['token_usage_rollup_usage_update', 'token_usage_rollup_usage_delete']) {
        const sql = triggerSql(db, name);
        const lastInsert = sql.lastIndexOf('INSERT INTO token_usage_rollup');
        const deleteAt = sql.indexOf('DELETE FROM token_usage_rollup');
        expect(lastInsert).toBeGreaterThan(-1);
        expect(deleteAt).toBeGreaterThan(lastInsert);
        // Keyed exactly, so it is a primary-key lookup that cannot reach
        // another group, and it fires only at row_count 0.
        expect(sql).toContain('AND row_count = 0;');
        expect(countOf(sql, 'DELETE FROM token_usage_rollup')).toBe(1);
      }
    });

    it('never prunes a group that momentarily passes through zero', () => {
      // One row in its group: the subtract takes row_count to 0 before the add
      // brings it back to 1. The group must survive.
      //
      // Stated honestly, this test does NOT discriminate the prune's position:
      // it passes with the prune moved between the subtract and the add,
      // because the add re-creates the row at the same key. It pins the
      // OUTCOME - a group that passes through zero is present afterwards, at
      // the right tokens and the right count - which is the property a reader
      // cares about; the mechanism behind it is the block comment's business.
      const id = addUsage(db, { tokens: 100, occurredAt: '2026-05-01T01:00:00.000Z' });

      db.prepare('UPDATE token_usage SET tokens = 250 WHERE id = ?').run(id);

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.tokens).toBe(250);
      expect(scan[0]?.row_count).toBe(1);
    });
  });

  // --- property 8: the pricing recompute is a full, idempotent rebuild -------

  describe('property 8 - the pricing recompute is a FULL REBUILD, therefore idempotent', () => {
    it('rebuilds the slice rather than applying a delta', () => {
      for (const name of [
        'token_usage_rollup_pricing_insert',
        'token_usage_rollup_pricing_update',
        'token_usage_rollup_pricing_delete',
      ]) {
        const sql = triggerSql(db, name);
        expect(sql).toContain('DELETE FROM token_usage_rollup WHERE model =');
        expect(sql).toContain('GROUP BY 1, 2, 3, 4, 5');
        // A delta would need ON CONFLICT arithmetic; a rebuild must not.
        expect(countOf(sql, 'ON CONFLICT')).toBe(0);
      }
      expect(countOf(triggerSql(db, 'token_usage_rollup_pricing_update'), 'GROUP BY')).toBe(2);
    });

    it('rewrites the slice, and lands on the same table when applied twice', () => {
      seedRichLedger(db);
      addRate(db, MODEL, 'input', '2026-05-01T12:00:00.000Z', 9);
      const afterSplit = readRollup(db);
      expectRollupMatchesScan(db);

      // The statement below matches EVERY model_pricing row of this model, so
      // its own contribution to total_changes() is that row count - three, not
      // one. An earlier `toBeGreaterThan(1)` here was therefore satisfied by
      // the statement alone. Measured on a scratch copy of this exact fixture
      // with all six rollup triggers dropped immediately before the UPDATE:
      // delta 3 against 36 pristine, `toBeGreaterThan(1)` still true, the table
      // still equal to the scan (the UPDATE changes no value) and still equal
      // to `afterSplit` - the whole test green with nothing whatsoever having
      // happened. The bound has to start ABOVE the statement's own work.
      const statementRows = (
        db.prepare('SELECT COUNT(*) AS n FROM model_pricing WHERE model = ?').get(MODEL) as {
          n: number;
        }
      ).n;
      expect(statementRows).toBeGreaterThan(1); // guard the guard: not a vacuous bound

      // Second, independent proof that the rebuild REWROTE the slice rather
      // than leaving it untouched: plant a row that belongs to the affected
      // (model, bucket) slice and that no scan can produce. The recompute is a
      // DELETE of the whole slice followed by a re-INSERT from `token_usage`,
      // so the plant must be gone afterwards. Nothing else reachable from this
      // test removes it - the usage-side prune is keyed exactly and fires only
      // at row_count = 0, and this row carries 42.
      db.prepare(
        `INSERT INTO token_usage_rollup
           (session_id, model, bucket, day, rate_effective_from, tokens, row_count)
         VALUES (?, ?, 'input', '2001-01-01', '', 999999, 42)`,
      ).run(SESSION, MODEL);
      expect(() => expectRollupMatchesScan(db)).toThrow(/EXTRA in rollup/); // the plant is visible

      const before = totalChanges(db);
      db.prepare('UPDATE model_pricing SET effective_from = effective_from WHERE model = ?').run(
        MODEL,
      );
      // Guard the guard, discriminating version: only TRIGGER work can push the
      // delta past the statement's own matched-row count.
      expect(totalChanges(db) - before).toBeGreaterThan(statementRows);
      // ... and the planted row was rebuilt away, which no no-op can do. Same
      // scratch measurement, plant kept and the six triggers dropped: the plant
      // is still there afterwards and this call throws.
      expectRollupMatchesScan(db);
      expect(readRollup(db)).toEqual(afterSplit);

      db.prepare('UPDATE model_pricing SET effective_from = effective_from WHERE model = ?').run(
        MODEL,
      );
      expectRollupMatchesScan(db);
      expect(readRollup(db)).toEqual(afterSplit);
    });

    /**
     * The pricing UPDATE trigger's body is `recompute(OLD)` followed by
     * `recompute(NEW)`. Every other test in this file updates only
     * `effective_from`, where OLD and NEW address the SAME (model, bucket)
     * slice - so the second recompute is redundant and the branch that is the
     * WHOLE REASON there are two of them is never entered. Renaming a model
     * enters it: OLD and NEW then name two different slices, both of which
     * change meaning, in opposite directions.
     */
    it('rebuilds BOTH slices when an UPDATE moves a rate to another model', () => {
      const FROM_MODEL = 'rollup-rename-from';
      const TO_MODEL = 'rollup-rename-to';
      addRate(db, FROM_MODEL, 'input', '2020-01-01', 5);
      addUsage(db, { tokens: 100, occurredAt: '2026-05-01T01:00:00.000Z', model: FROM_MODEL });
      addUsage(db, { tokens: 200, occurredAt: '2026-05-02T01:00:00.000Z', model: TO_MODEL });

      // Before: the rate belongs to FROM_MODEL, so FROM_MODEL's tokens are
      // priced and TO_MODEL's are not.
      const shape = (): unknown[] =>
        readRollup(db)
          .map((row) => [row.model, row.rate_effective_from, row.tokens, row.row_count])
          .sort();
      expect(shape()).toEqual([
        [FROM_MODEL, '2020-01-01T00:00:00.000Z', 100, 1],
        [TO_MODEL, '', 200, 1],
      ]);

      db.prepare('UPDATE model_pricing SET model = ? WHERE model = ?').run(TO_MODEL, FROM_MODEL);

      // After: exactly the reverse, and BOTH halves are load-bearing. A
      // copy-paste defect that ran `recompute(OLD)` twice would leave
      // TO_MODEL's group unpriced; running `recompute(NEW)` twice would leave
      // FROM_MODEL's group pointing at a rate row that no longer exists.
      const scan = expectRollupMatchesScan(db);
      expect(scanRollupInJs(db)).toEqual(scan);
      expect(shape()).toEqual([
        [FROM_MODEL, '', 100, 1],
        [TO_MODEL, '2020-01-01T00:00:00.000Z', 200, 1],
      ]);
    });

    it('rebuilds only the (model, bucket) slice the changed rate belongs to', () => {
      addRate(db, MODEL, 'input', '2020-01-01', 5);
      addUsage(db, { tokens: 100, occurredAt: '2026-05-01T01:00:00.000Z' });
      addUsage(db, { tokens: 200, occurredAt: '2026-05-01T01:00:00.000Z', bucket: 'output' });
      const outputBefore = readRollup(db).filter((row) => row.bucket === 'output');

      addRate(db, MODEL, 'input', '2026-05-01T00:30:00.000Z', 9);

      expectRollupMatchesScan(db);
      expect(readRollup(db).filter((row) => row.bucket === 'output')).toEqual(outputBefore);
    });
  });

  // --- property 9: the pricing UPDATE trigger is column-scoped ---------------

  describe('property 9 - a usd_per_mtok correction costs nothing', () => {
    it('is scoped OF model, bucket, effective_from', () => {
      expect(triggerSql(db, 'token_usage_rollup_pricing_update')).toContain(
        'AFTER UPDATE OF model, bucket, effective_from ON model_pricing',
      );
    });

    it("leaves the rollup byte-identical across upsertPricingRate's in-place rate update", () => {
      addRate(db, MODEL, 'input', '2020-01-01', 5);
      for (let i = 0; i < 4; i += 1) {
        addUsage(db, { tokens: 100 + i, occurredAt: `2026-05-0${String(i + 1)}T01:00:00.000Z` });
      }
      const before = readRollup(db);
      expect(before.length).toBeGreaterThan(1); // guard the guard

      const changesBefore = totalChanges(db);
      upsertPricingRate(db, {
        model: MODEL,
        bucket: 'input',
        usdPerMtok: 42,
        effectiveFrom: '2020-01-01',
      });

      // Exactly one row changed: the model_pricing UPDATE itself. Any rebuild
      // would have deleted and re-inserted the slice on top of that.
      //
      // KNOWN BRITTLENESS, kept deliberately. `toBe(1)` breaks - turning a
      // CORRECT system red - the day any future migration adds a second trigger
      // that writes on this event: another `AFTER UPDATE ON model_pricing`,
      // an `AFTER UPDATE OF usd_per_mtok`, an audit/history trigger on
      // `model_pricing`, or anything on `token_usage_rollup` itself. It is kept
      // because the claim is "the rollup was NOT rebuilt", and a rebuild's
      // signature is extra row changes - so any looser bound
      // (`toBeLessThan(k)`) would admit exactly the failure being excluded: a
      // slice small enough that its DELETE + re-INSERT fits under the ceiling.
      // The equality is the only formulation that says what the test means.
      // WHEN IT BREAKS, the fix is to re-derive the expected statement-only
      // count for the new schema and assert that - the way the property-8 test
      // above derives `statementRows` - never to relax the comparison. The
      // rollup rows are also asserted byte-equal below, but that alone cannot
      // detect a rebuild: a rebuild reproduces them exactly.
      expect(totalChanges(db) - changesBefore).toBe(1);
      expect(readRollup(db)).toEqual(before);
      expectRollupMatchesScan(db);
      expect(
        (
          db
            .prepare('SELECT usd_per_mtok AS usd FROM model_pricing WHERE model = ? AND bucket = ?')
            .get(MODEL, 'input') as { usd: number }
        ).usd,
      ).toBe(42);
    });
  });

  // --- property 10: retention -------------------------------------------------

  describe('property 10 - retention deletes rows and the rollup follows exactly', () => {
    const policy: RetentionPolicy = {
      ...NO_RETENTION,
      tokenUsage: { maxAgeDays: 30, acknowledgeCostLoss: true },
    };

    it('applies the exact inverse when the real prune removes expired rows', () => {
      addRate(db, MODEL, 'input', '2020-01-01', 5);
      addUsage(db, { tokens: 1_000_000, occurredAt: '2026-01-01T00:00:00.000Z' });
      addUsage(db, { tokens: 2_000, occurredAt: '2026-08-06T00:00:00.000Z' });
      expect(countRows(db, 'token_usage_rollup')).toBe(2);

      const report = prune(db, policy, { now: new Date('2026-08-07T00:00:00.000Z') });
      expect(report.applied).toBe(true); // guard the guard: rows really left

      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe('2026-08-06');
      expect(countRows(db, 'token_usage')).toBe(1);
    });

    it('fires per row even for an unqualified DELETE (no truncate optimization)', () => {
      seedRichLedger(db);
      const rows = countRows(db, 'token_usage');
      expect(rows).toBeGreaterThan(1);

      const changesBefore = totalChanges(db);
      db.prepare('DELETE FROM token_usage').run();

      // Trigger work is counted too, so the delta strictly exceeds the row
      // count - the truncate optimization would have skipped the triggers.
      expect(totalChanges(db) - changesBefore).toBeGreaterThan(rows);
      expectRollupMatchesScan(db);
      expect(countRows(db, 'token_usage_rollup')).toBe(0);
    });
  });

  // --- property 11: WITHOUT ROWID, and order-independent content -------------

  describe('property 11 - WITHOUT ROWID keeps content independent of arrival order', () => {
    it('has no rowid at all', () => {
      const sql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'token_usage_rollup'").get() as {
          sql: string;
        }
      ).sql;
      expect(normalizeSql(sql)).toContain('WITHOUT ROWID');
      expect(() => db.prepare('SELECT rowid FROM token_usage_rollup')).toThrow(
        /no such column: rowid/,
      );
    });

    it('keeps content and natural scan order identical under opposite insertion orders', () => {
      // WHAT CARRIES THE PROPERTY, and what merely decorates it. The byte
      // comparison at the END of this test is the WEAK half, and its weakness
      // is worth naming: both files are `VACUUM INTO` copies, and VACUUM
      // rebuilds every b-tree in key order. That is exactly the normalization
      // whose absence the comparison is trying to demonstrate, so it would
      // succeed on a plain rowid table too, where insertion order IS recorded.
      // It is kept as an end-to-end sanity check on the whole file, not as the
      // evidence for the describe's claim.
      //
      // The claim is carried by the other two assertions: the structural
      // `WITHOUT ROWID` check above (a table that has no rowid has nowhere to
      // record arrival order), and the `naturalA`/`naturalB` comparison below,
      // which reads the two LIVE, un-vacuumed databases in natural scan order -
      // primary-key order on a WITHOUT ROWID table, insertion order on a rowid
      // one - and is therefore the assertion that would actually notice.
      //
      // Both databases are VACUUM INTO copies of ONE migrated base, so the
      // schema cookie (header bytes 40..43, bumped by VACUUM INTO) starts
      // equal - otherwise this comparison fails for a reason that has nothing
      // to do with the rollup.
      const base = createMigratedTempDb();
      try {
        insertSession(base.db, SESSION);
        insertSession(base.db, OTHER_SESSION);
        const pathA = join(base.dir, 'order-a.db');
        const pathB = join(base.dir, 'order-b.db');
        base.db.prepare('VACUUM INTO ?').run(pathA);
        base.db.prepare('VACUUM INTO ?').run(pathB);
        expect(readFileSync(pathA).equals(readFileSync(pathB))).toBe(true); // guard the guard

        const rows: readonly UsageInput[] = [
          { tokens: 10, occurredAt: '2026-05-01T01:00:00.000Z', model: 'zeta-model' },
          { tokens: 20, occurredAt: '2026-05-02T01:00:00.000Z', model: 'alpha-model' },
          {
            tokens: 30,
            occurredAt: '2026-05-03T01:00:00.000Z',
            model: 'mid-model',
            bucket: 'cache_read',
            sessionId: OTHER_SESSION,
          },
          { tokens: 40, occurredAt: '2026-05-01T01:00:00.000Z', model: 'alpha-model' },
          { tokens: 0, occurredAt: null, model: 'alpha-model', bucket: 'output' },
        ];
        const write = (target: SqliteDatabase, order: readonly number[]): void => {
          const statement = target.prepare(
            `INSERT INTO token_usage
               (id, session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
          );
          for (const index of order) {
            const row = rows[index];
            if (row === undefined) {
              throw new Error('bad fixture index');
            }
            statement.run(
              index + 1,
              row.sessionId ?? SESSION,
              `order-msg-${String(index)}`,
              row.model ?? MODEL,
              row.bucket ?? 'input',
              row.tokens,
              row.occurredAt,
            );
          }
        };

        const dbA = openDatabase(pathA);
        const dbB = openDatabase(pathB);
        write(dbA, [0, 1, 2, 3, 4]);
        write(dbB, [4, 3, 2, 1, 0]);
        expectRollupMatchesScan(dbA);
        expectRollupMatchesScan(dbB);

        // Natural (unordered) scan order is primary-key order, so it cannot
        // record which group appeared first.
        const naturalA = dbA.prepare('SELECT * FROM token_usage_rollup').all();
        const naturalB = dbB.prepare('SELECT * FROM token_usage_rollup').all();
        expect(naturalA).toEqual(naturalB);
        expect(naturalA.length).toBeGreaterThan(3); // guard the guard

        const snapA = join(base.dir, 'snap-a.db');
        const snapB = join(base.dir, 'snap-b.db');
        dbA.prepare('VACUUM INTO ?').run(snapA);
        dbB.prepare('VACUUM INTO ?').run(snapB);
        dbA.close();
        dbB.close();
        // Weak by construction - see the note at the top of this test. VACUUM
        // rebuilds b-trees in key order, so this line would also pass on a
        // rowid table that HAD recorded arrival order. The load-bearing
        // assertions are the `WITHOUT ROWID` check and `naturalA`/`naturalB`.
        expect(readFileSync(snapA).equals(readFileSync(snapB))).toBe(true);
      } finally {
        base.cleanup();
      }
    });
  });

  // --- property 12: the COALESCE fallback is unreachable ---------------------

  describe('property 12 - the COALESCE fallback arm', () => {
    /*
     * UNTESTED, AND DELIBERATELY SO. The fallback in migration 16's `at()`
     *
     *     COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', X.occurred_at), X.occurred_at)
     *
     * only takes its second arm when `strftime` returns NULL, i.e. when a
     * non-NULL `occurred_at` is not a date at all. Migration 15's BEFORE
     * INSERT / BEFORE UPDATE OF guards RAISE(ABORT) on exactly those values, so
     * the arm cannot be reached through SQL in a live database. Reaching it
     * would require dropping migration 15's guard triggers - i.e. testing a
     * schema this project does not ship - so this suite does not reach it and
     * does not claim to. What IS asserted here is the premise: the guards do
     * reject every such value, which is what makes the arm unreachable and the
     * NOT NULL columns of the rollup safe.
     */
    const NOT_A_DATE = ['not-a-date', '2026-13-45', '2026-02-30', '2026-05-05T24:00:00Z', ''];

    for (const value of NOT_A_DATE) {
      it(`rejects ${JSON.stringify(value)} before any rollup key is derived`, () => {
        expect(() => addUsage(db, { tokens: 1, occurredAt: value })).toThrow(
          /occurred_at must be NULL, a bare UTC date, or a zoned ISO-8601 instant/,
        );
        expect(countRows(db, 'token_usage')).toBe(0);
        expectRollupMatchesScan(db);
      });
    }

    it('rejects the same values on UPDATE', () => {
      const id = addUsage(db, { tokens: 5, occurredAt: '2026-05-01T00:00:00.000Z' });
      for (const value of NOT_A_DATE) {
        expect(() =>
          db.prepare('UPDATE token_usage SET occurred_at = ? WHERE id = ?').run(value, id),
        ).toThrow(/occurred_at must be NULL, a bare UTC date, or a zoned ISO-8601 instant/);
      }
      const scan = expectRollupMatchesScan(db);
      expect(scan).toHaveLength(1);
      expect(scan[0]?.day).toBe('2026-05-01');
    });
  });

  // --- property 13: the shapes the real writers perform ----------------------

  describe('property 13 - the write shapes production actually performs', () => {
    /*
     * Most of this file writes the ledger with raw SQL, deliberately: the
     * rollup is a property of STORAGE, not of one writer. But three shapes are
     * reachable only through the real exported functions, and one of them -
     * the agent_id-only correction - is the shape the ingest path performs most
     * often. Driving them through `insertTokenUsageRows` / `upsertPricingRate`
     * rather than through hand-written SQL that resembles them is the point:
     * a hand-written imitation can drift away from the writer it imitates.
     */

    it('nets an agent_id-only correction to EXACTLY zero across all five buckets', () => {
      // `token_usage.agent_id IS NOT excluded.agent_id` is its own arm of
      // UPSERT_SQL's WHERE guard (token-usage.ts:184). A re-ingest that only
      // resolves attribution therefore UPDATEs all five bucket rows while
      // leaving all five of the rollup's KEY columns identical - so the AFTER
      // UPDATE trigger fires with OLD and NEW addressing the same row, and the
      // signed subtract and signed add must cancel exactly. If the two arms
      // ever disagreed, the group would fall to row_count 0, be pruned, and
      // vanish from the rollup while its tokens sat untouched in `token_usage`:
      // a silent under-report with no error anywhere.
      const entry: DedupedUsage = {
        messageId: 'agent-arm-1',
        model: MODEL,
        timestamp: '2026-05-01T01:00:00.000Z',
        usage: { input: 100, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 5 },
        agentId: null,
      };
      const first = insertTokenUsageRows(db, SESSION, [entry]);
      expect(first).toEqual({ inserted: 5, corrected: 0, crossSessionCollisions: 0 });
      const before = readRollup(db);
      expect(before).toHaveLength(5); // guard the guard: five bucket groups to keep
      expectRollupMatchesScan(db);

      insertAgent(db, 'agent-arm-node', SESSION);
      const again = insertTokenUsageRows(db, SESSION, [{ ...entry, agentId: 'agent-arm-node' }]);
      // Identical tokens, model and timestamp, so `settles` is false and the
      // token/model/occurred_at arms of the guard cannot have fired: five
      // UPDATEs, driven by attribution alone.
      expect(again).toEqual({ inserted: 0, corrected: 5, crossSessionCollisions: 0 });
      expect(countRows(db, `token_usage WHERE agent_id = 'agent-arm-node'`)).toBe(5);

      expectRollupMatchesScan(db);
      expect(readRollup(db)).toEqual(before);
      expect(countRows(db, 'token_usage_rollup')).toBe(5);
    });

    it('does not move the rollup when the M-12 cross-session guard skips a replay', () => {
      // token-usage.ts:213-219: a resume/fork copies history lines verbatim
      // into a new session file, and the first-ingested session owns the
      // message_id. The replay must not be written - so the rollup must not
      // move either, not by a token and not by a row.
      const entry: DedupedUsage = {
        messageId: 'shared-msg',
        model: MODEL,
        timestamp: '2026-05-01T01:00:00.000Z',
        usage: { input: 100, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        agentId: null,
      };
      insertTokenUsageRows(db, SESSION, [entry]);
      const before = readRollup(db);
      expect(before.length).toBeGreaterThan(1); // guard the guard
      expectRollupMatchesScan(db);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const replay = insertTokenUsageRows(db, OTHER_SESSION, [
          {
            ...entry,
            usage: {
              input: 9_000,
              output: 9_000,
              cacheRead: 9_000,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          },
        ]);
        // Larger token counts on purpose: the MAX convergence rule is a
        // WITHIN-session repair, so a cross-session copy must not win with it.
        expect(replay).toEqual({ inserted: 0, corrected: 0, crossSessionCollisions: 1 });
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }

      expectRollupMatchesScan(db);
      expect(readRollup(db)).toEqual(before);
      expect(countRows(db, `token_usage_rollup WHERE session_id = '${OTHER_SESSION}'`)).toBe(0);
    });

    it("splits a rolled-up day through upsertPricingRate's INSERT arm", () => {
      // The suite otherwise reaches only this function's DO UPDATE arm
      // (property 9). The INSERT arm is the one that fires the pricing INSERT
      // trigger, and it canonicalizes its input BEFORE the statement runs - so
      // the zoned spelling below has to land on the canonical key the rollup
      // stores, or the split falls on the wrong side.
      addUsage(db, { tokens: 1_000, occurredAt: '2026-05-01T01:00:00.000Z', model: SPLIT_MODEL });
      addUsage(db, { tokens: 2_000, occurredAt: '2026-05-01T09:00:00.000Z', model: SPLIT_MODEL });
      expect(readRollup(db).map((row) => row.rate_effective_from)).toEqual(['']); // one group

      upsertPricingRate(db, {
        model: SPLIT_MODEL,
        bucket: 'input',
        usdPerMtok: 3,
        effectiveFrom: '2026-05-01T08:00:00+03:00', // 05:00:00Z
      });
      expect(countRows(db, `model_pricing WHERE model = '${SPLIT_MODEL}'`)).toBe(1); // inserted

      const scan = expectRollupMatchesScan(db);
      expect(scanRollupInJs(db)).toEqual(scan);
      expect(
        scan.map((row) => [row.day, row.rate_effective_from, row.tokens, row.row_count]),
      ).toEqual([
        ['2026-05-01', '', 1_000, 1],
        ['2026-05-01', '2026-05-01T05:00:00.000Z', 2_000, 1],
      ]);
    });
  });
});
