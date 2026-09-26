/**
 * M-19 - the standing EQUIVALENCE guard for the cost summary.
 *
 * `getCostSummary` no longer computes anything from the ledger at read time.
 * It reads the persisted `token_usage_rollup` and prices each row from the
 * `model_pricing` row the rollup already resolved, behind a one-entry memo.
 * That is two derivations stacked on top of the ground truth, and either one
 * can turn a wrong number into a confident number. These tests never assert on
 * timing; they assert that the value the server SERVES is the same value the
 * ledger itself says.
 *
 * Two oracles, because after the cutover one is not enough:
 *
 *  - `ledgerOracle` re-derives the entire DTO in JavaScript from `token_usage`
 *    and `model_pricing` alone - never the rollup, never `getCostSummary`,
 *    never the production rate resolver. It is the oracle for the ROLLUP, and
 *    it is compared with exact `toEqual`: every dollar bit, every ordering,
 *    every null slug.
 *  - `uncachedScan` calls `getCostSummary` on a freshly opened handle, which
 *    the `WeakMap`-keyed memo guarantees is cache-cold (proven per call through
 *    the `onScan` probe). Before the cutover this was the independent oracle;
 *    it is not independent any more - it is the function under test reading the
 *    same table - so it is kept for the narrower job it can still do honestly:
 *    proving the MEMO never answers differently from a cold read.
 *
 * A third check, `ledgerSqlAggregate`, transcribes the pre-cutover priced-CTE
 * scan straight into SQL and compares with a tolerance. That is the "no cent
 * drifted in the cutover" proof, and it is deliberately a different question
 * from the exact one above: the two paths sum the same exact integers in
 * different orders, so they may differ in the last representable bit and must
 * not differ by more.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PricingEntry } from '@agenthropic/core';
import { getFixture, type Fixture } from '@agenthropic/test-fixtures';
import type { CostSummaryDto } from '@agenthropic/shared';
import { getCostSummary, type CostSummaryProbe } from '../src/api/queries';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { runCorpusIngest } from '../src/corpus/ingest-corpus';
import { buildServer } from '../src/server';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const SLUG = '-Users-synthetic-equivalence-project';
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;
const TOP_N = 5;

/** Scenario-matrix instants (see `seedScenarioDatabase`). */
const DAY_ONE = '2026-06-01T10:00:00.000Z';
const DAY_TWO = '2026-06-02T10:00:00.000Z';
/** The exact tick a second rate epoch opens - inclusive, per the parser spec. */
const RATE_INSTANT = '2026-06-01T12:00:00.000Z';

/** Fixtures with a bare `<uuid>.jsonl` main transcript — one session each. */
const FIXTURE_NAMES = [
  'flat-tool-use',
  'nested-workflow',
  'depth-2-sync',
  'task-notification-recovery',
] as const;

/** Ingest-side gate: every fixture model must have a price or the session halts. */
const INGEST_PRICING: PricingEntry[] = ['synthetic-model-a', 'synthetic-model-b'].flatMap((model) =>
  BUCKETS.map((bucket) => ({
    model,
    bucket,
    usdPerMtok: 1,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  })),
);

function mainSessionIdOf(fixture: Fixture): string {
  const main = fixture.files.find((f) => !f.relativePath.includes('/'));
  if (main === undefined) {
    throw new Error(`fixture ${fixture.name} has no main transcript; update this test`);
  }
  return main.relativePath.slice(0, -'.jsonl'.length);
}

/** Lay a fixture out on REAL disk the way Claude Code does (main + `<uuid>/`). */
function materializeFixture(corpusRoot: string, fixture: Fixture, sessionId: string): void {
  for (const f of fixture.files) {
    const rel = f.relativePath.includes('/')
      ? join(sessionId, ...f.relativePath.split('/'))
      : f.relativePath;
    const abs = join(corpusRoot, SLUG, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.lines.join('\n') + '\n');
  }
}

function makeProbe(): CostSummaryProbe & { scans: number } {
  return {
    scans: 0,
    onScan(): void {
      this.scans += 1;
    },
  };
}

function insertPrice(
  db: SqliteDatabase,
  model: string,
  usdPerMtok: number,
  effectiveFrom: string,
): void {
  const statement = db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
  );
  for (const bucket of BUCKETS) {
    statement.run(model, bucket, usdPerMtok, effectiveFrom);
  }
}

/**
 * SQLite's BINARY collation, in JavaScript.
 *
 * BINARY compares the UTF-8 bytes; JavaScript `<` compares UTF-16 code units.
 * The two agree for every string in this file - session ids, model names,
 * bucket names, ISO days and ISO instants are all ASCII - and this comparator
 * is only ever used on those. It exists so the oracle can reproduce SQLite's
 * `ORDER BY` and the production tie-breaks without importing either.
 */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface LedgerUsageRow {
  readonly session_id: string;
  readonly model: string;
  readonly bucket: string;
  readonly tokens: number;
  readonly occurred_at: string | null;
}

interface LedgerPriceRow {
  readonly model: string;
  readonly bucket: string;
  readonly usd_per_mtok: number;
  readonly effective_from: string;
}

interface OracleTotals {
  tokens: number;
  costUsd: number;
  unpricedTokens: number;
}

/** One re-derived rollup group: the grain, plus the rate that group resolved. */
interface OracleGroup {
  readonly sessionId: string;
  readonly model: string;
  readonly bucket: string;
  readonly day: string;
  readonly rateEffectiveFrom: string;
  /** `null` means no rate was in force - unpriced, never $0-by-assumption. */
  readonly rate: number | null;
  tokens: number;
}

function addInto(into: Map<string, OracleTotals>, key: string, delta: OracleTotals): void {
  const seen = into.get(key) ?? { tokens: 0, costUsd: 0, unpricedTokens: 0 };
  seen.tokens += delta.tokens;
  seen.costUsd += delta.costUsd;
  seen.unpricedTokens += delta.unpricedTokens;
  into.set(key, seen);
}

/**
 * THE INDEPENDENT ORACLE - the whole cost summary, re-derived in JavaScript
 * from `token_usage` and `model_pricing` and NOTHING else.
 *
 * It never reads `token_usage_rollup`, never calls `getCostSummary`, and never
 * imports the production rate resolver: the dated-rate rule (the newest
 * `effective_from` not after `occurred_at`, for the exact (model, bucket);
 * unresolvable when `occurred_at` is NULL) is re-implemented here from the
 * parser spec, so a bug in the production resolver cannot hide inside the
 * oracle by construction. It is a linear scan against every pricing row on
 * purpose - the slow, obvious shape is the one that is easy to read as
 * correct, and the corpus in this file is tiny.
 *
 * It groups at the rollup GRAIN and sums in the rollup's PRIMARY-KEY ORDER,
 * which is the one thing it takes from the production design. That is
 * deliberate: `getCostSummary` documents that summation order as a chosen
 * property, and an oracle that summed in some other order could only ever be
 * compared with a tolerance - which would let a real cent hide inside the
 * tolerance. Matching the order makes the comparison exact. It does NOT make
 * the oracle trust the rollup table: the groups are computed here from the
 * ledger, so a rollup row that disagreed with the ledger - a missed trigger, a
 * stale rate pointer, a pruned row that should have survived - moves the served
 * value away from this one and fails the assertion.
 *
 * ONE ASSUMPTION IT MAKES, stated so it is not mistaken for coverage: the
 * oracle compares `effective_from` and `occurred_at` as stored strings, while
 * `readRateTable` canonicalizes `effective_from` through strftime first. Those
 * agree only because migrations 14 and 15 keep both columns canonical in every
 * database this suite builds. The divergence when they do NOT is covered
 * separately, by the test that drops the canonicalizing trigger and asserts
 * `readRateTable` throws rather than silently picking a winner.
 */
function ledgerOracle(db: SqliteDatabase, topN = TOP_N): CostSummaryDto {
  const usage = db
    .prepare('SELECT session_id, model, bucket, tokens, occurred_at FROM token_usage')
    .all() as LedgerUsageRow[];
  const prices = db
    .prepare('SELECT model, bucket, usd_per_mtok, effective_from FROM model_pricing')
    .all() as LedgerPriceRow[];

  const groups: OracleGroup[] = [];
  const index = new Map<string, OracleGroup>();
  for (const row of usage) {
    let winner: LedgerPriceRow | undefined;
    for (const price of prices) {
      if (price.model !== row.model || price.bucket !== row.bucket) {
        continue;
      }
      // A NULL timestamp cannot be dated against any rate: unpriced, always.
      if (row.occurred_at === null || price.effective_from > row.occurred_at) {
        continue;
      }
      if (winner === undefined || price.effective_from > winner.effective_from) {
        winner = price;
      }
    }
    const day = row.occurred_at === null ? 'unknown' : row.occurred_at.slice(0, 10);
    // JSON, not a separator character: injective over these tuples with no
    // escaping question to get wrong, and it keeps a raw NUL out of the file.
    const key = JSON.stringify([
      row.session_id,
      row.model,
      row.bucket,
      day,
      winner === undefined ? '' : winner.effective_from,
    ]);
    let group = index.get(key);
    if (group === undefined) {
      group = {
        sessionId: row.session_id,
        model: row.model,
        bucket: row.bucket,
        day,
        rateEffectiveFrom: winner === undefined ? '' : winner.effective_from,
        rate: winner === undefined ? null : winner.usd_per_mtok,
        tokens: 0,
      };
      index.set(key, group);
      groups.push(group);
    }
    group.tokens += row.tokens;
  }
  groups.sort(
    (a, b) =>
      byText(a.sessionId, b.sessionId) ||
      byText(a.model, b.model) ||
      byText(a.bucket, b.bucket) ||
      byText(a.day, b.day) ||
      byText(a.rateEffectiveFrom, b.rateEffectiveFrom),
  );

  const totals: OracleTotals = { tokens: 0, costUsd: 0, unpricedTokens: 0 };
  const byModel = new Map<string, OracleTotals>();
  const byDay = new Map<string, OracleTotals>();
  const bySession = new Map<string, OracleTotals>();
  for (const group of groups) {
    const delta: OracleTotals =
      group.rate === null
        ? { tokens: group.tokens, costUsd: 0, unpricedTokens: group.tokens }
        : {
            tokens: group.tokens,
            costUsd: (group.tokens * group.rate) / 1_000_000,
            unpricedTokens: 0,
          };
    totals.tokens += delta.tokens;
    totals.costUsd += delta.costUsd;
    totals.unpricedTokens += delta.unpricedTokens;
    addInto(byModel, group.model, delta);
    addInto(byDay, group.day, delta);
    addInto(bySession, group.sessionId, delta);
  }

  const perModel = [...byModel]
    .sort(([aKey, a], [bKey, b]) => b.costUsd - a.costUsd || byText(aKey, bKey))
    .map(([model, bucket]) => ({ model, ...bucket }));
  const perDay = [...byDay]
    .sort(
      ([aKey], [bKey]) =>
        Number(aKey === 'unknown') - Number(bKey === 'unknown') || byText(bKey, aKey),
    )
    .map(([day, bucket]) => ({ day, ...bucket }));
  const top = [...bySession]
    .sort(([aKey, a], [bKey, b]) => b.costUsd - a.costUsd || byText(aKey, bKey))
    .slice(0, topN);
  const slugOf = db.prepare('SELECT project_slug FROM sessions WHERE id = ?');
  return {
    totals,
    perModel,
    perDay,
    topSessions: top.map(([sessionId, bucket]) => ({
      sessionId,
      // A session in `token_usage` with no `sessions` row keeps a null slug.
      projectSlug:
        (slugOf.get(sessionId) as { project_slug: string | null } | undefined)?.project_slug ??
        null,
      ...bucket,
    })),
    // The population the slice came from (L1): every session with a ledger
    // row, priced or not - never the slice length.
    sessionCount: bySession.size,
    hasMore: bySession.size > top.length,
  };
}

/**
 * The PRE-CUTOVER read, transcribed - the correlated dated-rate subquery over
 * the whole ledger that `getCostSummary` used to run, written out here so the
 * cutover has something to be compared AGAINST rather than only something to
 * be compared with.
 *
 * `keyExpr` is the grouping column; pass `NULL` for the ungrouped totals. The
 * dollar column is SQLite's own `SUM()` over one term per LEDGER ROW, which is
 * exactly the accumulation order the cutover changed - so this is compared
 * with a tolerance, and only tokens are compared exactly.
 */
interface SqlAggregateRow {
  readonly key: string | null;
  readonly tokens: number | null;
  readonly cost_usd: number | null;
  readonly unpriced_tokens: number | null;
}

/** One served aggregate reduced to the shape the SQL side can be compared with. */
interface KeyedTotals extends OracleTotals {
  readonly key: string;
}

function ledgerSqlAggregate(db: SqliteDatabase, keyExpr: string): SqlAggregateRow[] {
  return db
    .prepare(
      `WITH priced AS (
         SELECT
           tu.session_id AS session_id,
           tu.model AS model,
           tu.tokens AS tokens,
           tu.occurred_at AS occurred_at,
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
       )
       SELECT ${keyExpr} AS key,
              SUM(tokens) AS tokens,
              SUM(CASE WHEN rate IS NOT NULL THEN tokens * rate / 1000000.0 ELSE 0 END) AS cost_usd,
              SUM(CASE WHEN rate IS NULL THEN tokens ELSE 0 END) AS unpriced_tokens
         FROM priced
        GROUP BY ${keyExpr}`,
    )
    .all() as SqlAggregateRow[];
}

describe('cost summary equals an uncached scan (M-19)', () => {
  const dirs: string[] = [];
  const temps: TempDb[] = [];

  afterEach(() => {
    for (const temp of temps.splice(0)) {
      temp.cleanup();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A migrated temp database holding a NON-TRIVIAL cost picture:
   *  - four fixture sessions ingested through the real corpus runner, TWICE
   *    (the double replay: the second pass must be a no-op in dollars);
   *  - hand-seeded rows covering every arm the priced CTE has — a NULL
   *    `occurred_at` (day `unknown`), an unknown model, a timestamp that
   *    predates the earliest rate, and two rate epochs inside one calendar day;
   *  - a `token_usage.session_id` with no `sessions` row, so the top-N slug
   *    lookup has a genuine null to carry.
   */
  function seedRichDatabase(): { readonly temp: TempDb; readonly corpusRoot: string } {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-equivalence-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    const temp = createMigratedTempDb();
    temps.push(temp);

    for (const name of FIXTURE_NAMES) {
      const fixture = getFixture(name);
      materializeFixture(corpusRoot, fixture, mainSessionIdOf(fixture));
    }
    const env = { CLAUDE_PROJECTS_DIR: corpusRoot };
    const first = runCorpusIngest({ db: temp.db, pricing: INGEST_PRICING, env });
    expect(first.sessionsOk).toBe(FIXTURE_NAMES.length);
    // The DOUBLE REPLAY: same bytes, same runner, same database.
    const second = runCorpusIngest({ db: temp.db, pricing: INGEST_PRICING, env });
    expect(second.sessionsOk).toBe(FIXTURE_NAMES.length);

    // Read-side rates. The migration seeds only the real Claude models, so the
    // synthetic ones are priced here; `synthetic-model-b` is deliberately left
    // out so its tokens surface as unpriced rather than as a silent $0.
    insertPrice(temp.db, 'synthetic-model-a', 3, '2020-01-01T00:00:00.000Z');
    insertPrice(temp.db, 'mid-day-model', 1, '2020-01-01T00:00:00.000Z');
    // Second epoch for the SAME model, starting midday — the case that makes a
    // (session, model, day) rollup non-repriceable from tokens alone.
    insertPrice(temp.db, 'mid-day-model', 9, '2026-05-05T12:00:00.000Z');

    const usage = temp.db.prepare(
      `INSERT INTO token_usage
         (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
       VALUES (?, NULL, ?, ?, 'input', ?, ?)`,
    );
    const known = mainSessionIdOf(getFixture('flat-tool-use'));
    usage.run(known, 'eq-null-ts', 'synthetic-model-a', 500, null);
    usage.run(known, 'eq-unknown-model', 'model-nobody-priced', 700, '2026-05-05T09:00:00.000Z');
    usage.run(known, 'eq-before-floor', 'mid-day-model', 900, '2019-01-01T00:00:00.000Z');
    usage.run(known, 'eq-midday-early', 'mid-day-model', 1000, '2026-05-05T08:00:00.000Z');
    usage.run(known, 'eq-midday-late', 'mid-day-model', 1000, '2026-05-05T16:00:00.000Z');
    // A usage row whose session was never persisted: the top-N slug lookup must
    // carry a null slug rather than drop the row.
    usage.run(
      '99999999-0000-4000-8000-000000000000',
      'eq-orphan',
      'synthetic-model-a',
      4_000_000,
      '2026-05-06T10:00:00.000Z',
    );
    return { temp, corpusRoot };
  }

  /**
   * `getCostSummary` on a guaranteed cache-cold handle - the MEMO oracle.
   *
   * Not an oracle for the rollup (see the module docstring): after M-19 this is
   * the same function reading the same table, so it can only prove that the
   * cached answer equals the uncached one. `ledgerOracle` is what proves the
   * uncached one is right.
   */
  function uncachedScan(path: string, topN = TOP_N): CostSummaryDto {
    const cold = openDatabase(path);
    try {
      const probe = makeProbe();
      const summary = getCostSummary(cold, topN, probe);
      // A cold handle that did NOT scan would make this oracle worthless.
      expect(probe.scans).toBe(1);
      return summary;
    } finally {
      cold.close();
    }
  }

  it('serves exactly what a full uncached scan of the same data would say', () => {
    const { temp } = seedRichDatabase();
    const probe = makeProbe();
    const first = getCostSummary(temp.db, TOP_N, probe);
    const second = getCostSummary(temp.db, TOP_N, probe);
    // The second read was served from the cache: this is the value under test.
    expect(probe.scans).toBe(1);
    expect(second).toBe(first);

    expect(second).toEqual(uncachedScan(temp.path));

    // Guard the guard: an all-zero summary would satisfy the equality above
    // while proving nothing. Every arm of the priced CTE must be represented.
    expect(second.totals.tokens).toBeGreaterThan(0);
    expect(second.totals.costUsd).toBeGreaterThan(0);
    expect(second.totals.unpricedTokens).toBeGreaterThan(0);
    expect(second.perModel.length).toBeGreaterThanOrEqual(3);
    expect(second.perDay.map((entry) => entry.day)).toContain('unknown');
    expect(second.perDay.length).toBeGreaterThanOrEqual(3);
    expect(second.topSessions.length).toBeGreaterThanOrEqual(2);
    expect(second.topSessions.some((entry) => entry.projectSlug === null)).toBe(true);
  });

  it('a second replay of the same bytes changes no dollar', () => {
    const { temp, corpusRoot } = seedRichDatabase(); // already replayed twice
    const afterTwo = getCostSummary(temp.db, TOP_N);
    const third = runCorpusIngest({
      db: temp.db,
      pricing: INGEST_PRICING,
      env: { CLAUDE_PROJECTS_DIR: corpusRoot },
    });
    expect(third.sessionsOk).toBe(FIXTURE_NAMES.length);
    // Both the served value and an independent uncached scan must be unmoved.
    expect(getCostSummary(temp.db, TOP_N)).toEqual(afterTwo);
    expect(uncachedScan(temp.path)).toEqual(afterTwo);
  });

  it('no mutation of the summary inputs can make the served value disagree', () => {
    const { temp } = seedRichDatabase();
    const known = mainSessionIdOf(getFixture('flat-tool-use'));
    let previous = getCostSummary(temp.db, TOP_N);
    expect(previous).toEqual(uncachedScan(temp.path));

    // Each mutation is chosen to MOVE the answer, so "cache agrees with a cold
    // scan" cannot pass by the summary simply never changing. The in-place
    // model settle is the important one: it changes attribution while row
    // count, max id and SUM(tokens) all stay put — which is precisely why no
    // cheap read-only detector can replace `total_changes()` here.
    const mutations: Array<[string, () => void]> = [
      [
        'insert a usage row',
        () => {
          temp.db
            .prepare(
              `INSERT INTO token_usage
                 (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
               VALUES (?, NULL, 'eq-mutation', 'synthetic-model-a', 'output', 2000, '2026-05-07T10:00:00.000Z')`,
            )
            .run(known);
        },
      ],
      [
        'raise its token count in place',
        () => {
          temp.db
            .prepare("UPDATE token_usage SET tokens = 8000 WHERE message_id = 'eq-mutation'")
            .run();
        },
      ],
      [
        'settle its model in place (row count, max id and SUM(tokens) all unchanged)',
        () => {
          temp.db
            .prepare(
              "UPDATE token_usage SET model = 'mid-day-model' WHERE message_id = 'eq-mutation'",
            )
            .run();
        },
      ],
      [
        'delete it again',
        () => {
          temp.db.prepare("DELETE FROM token_usage WHERE message_id = 'eq-mutation'").run();
        },
      ],
      [
        'price a previously unpriced model from ANOTHER connection',
        () => {
          const other = openDatabase(temp.path);
          try {
            insertPrice(other, 'synthetic-model-b', 7, '2020-01-01T00:00:00.000Z');
          } finally {
            other.close();
          }
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      mutate();
      const served = getCostSummary(temp.db, TOP_N);
      expect(served, label).toEqual(uncachedScan(temp.path));
      expect(served, label).not.toEqual(previous);
      previous = served;
    }
  });

  it('prices each row at its own dated rate, so one calendar day can span two epochs', () => {
    // The evidence behind the hand-off note on the rollup GRAIN: these two rows
    // share (session, model, bucket, day) yet resolve DIFFERENT rates, so a
    // day-grain rollup storing tokens alone could not reproduce this number.
    const { temp } = seedRichDatabase();
    const summary = getCostSummary(temp.db, TOP_N);
    const midDayOnly = summary.perModel.find((entry) => entry.model === 'mid-day-model');
    // The 900-token row predates every rate: $0, and counted as unpriced rather
    // than silently priced at the earliest rate.
    expect(midDayOnly?.tokens).toBe(2900);
    expect(midDayOnly?.unpricedTokens).toBe(900);
    // 1000 tok before noon at $1/Mtok + 1000 tok after noon at $9/Mtok. Compared
    // with a tolerance because the sum is a float accumulated in SQLite's row
    // order — the same reason a future rollup must be proven in integer
    // micro-dollars rather than by exact float equality.
    expect(midDayOnly?.costUsd).toBeCloseTo((1000 * 1 + 1000 * 9) / 1_000_000, 12);
    // Neither single rate reproduces it — the day grain genuinely loses information.
    expect(midDayOnly?.costUsd).not.toBeCloseTo((2000 * 1) / 1_000_000, 12);
    expect(midDayOnly?.costUsd).not.toBeCloseTo((2000 * 9) / 1_000_000, 12);
  });

  it('equals a re-derivation of the whole summary from the ledger itself', () => {
    // THE cutover assertion. `getCostSummary` reads `token_usage_rollup`; this
    // reads `token_usage`. If a trigger ever misses an insert, mis-resolves a
    // rate, prunes a row it should have kept, or leaves a stale rate pointer
    // behind, the two answers part company here - exactly, not within a
    // tolerance.
    const { temp } = seedRichDatabase();
    const oracle = ledgerOracle(temp.db);
    expect(getCostSummary(temp.db, TOP_N)).toEqual(oracle);

    // Guard the guard: an all-zero summary would satisfy the equality above
    // while proving nothing, so every arm the ledger scan used to handle has to
    // be present in the value being compared.
    expect(oracle.totals.tokens).toBeGreaterThan(0);
    expect(oracle.totals.costUsd).toBeGreaterThan(0);
    expect(oracle.totals.unpricedTokens).toBeGreaterThan(0);
    expect(oracle.perModel.length).toBeGreaterThanOrEqual(3);
    expect(oracle.perDay.map((entry) => entry.day)).toContain('unknown');
    expect(oracle.topSessions.some((entry) => entry.projectSlug === null)).toBe(true);
    // ...and the oracle must be reading a rollup-independent path: the rollup
    // holds strictly fewer rows than the ledger it was built from.
    const counts = temp.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM token_usage) AS ledger,
                (SELECT COUNT(*) FROM token_usage_rollup) AS rollup`,
      )
      .get() as { ledger: number; rollup: number };
    expect(counts.rollup).toBeGreaterThan(0);
    expect(counts.rollup).toBeLessThan(counts.ledger);
  });

  it('still equals the ledger after every mutation the rollup triggers must catch', () => {
    // The equality above is a snapshot. This drives the rollup through each
    // trigger arm and re-proves it from the ledger every time. The pricing
    // mutations are the ones a shadow table gets wrong: they change no usage
    // row at all, yet must re-date rows already summarized.
    const { temp } = seedRichDatabase();
    const known = mainSessionIdOf(getFixture('flat-tool-use'));
    const insert = temp.db.prepare(
      `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
       VALUES (?, NULL, 'eq-rollup', 'mid-day-model', 'output', 3000, '2026-05-05T08:00:00.000Z')`,
    );
    const mutations: Array<[string, () => void]> = [
      [
        'insert a usage row',
        () => {
          insert.run(known);
        },
      ],
      [
        'move it across the mid-day rate boundary',
        () => {
          temp.db
            .prepare(
              `UPDATE token_usage SET occurred_at = '2026-05-05T20:00:00.000Z'
                WHERE message_id = 'eq-rollup'`,
            )
            .run();
        },
      ],
      [
        'blank its timestamp, so it falls into the unknown day',
        () => {
          temp.db
            .prepare("UPDATE token_usage SET occurred_at = NULL WHERE message_id = 'eq-rollup'")
            .run();
        },
      ],
      [
        'introduce a NEW rate epoch that re-dates rows already summarized',
        () => {
          insertPrice(temp.db, 'mid-day-model', 21, '2026-05-05T14:00:00.000Z');
        },
      ],
      [
        'move an existing epoch, so the winning rate for a stored day changes',
        () => {
          temp.db
            .prepare(
              `UPDATE model_pricing SET effective_from = '2026-05-05T02:00:00.000Z'
                WHERE model = 'mid-day-model' AND effective_from = '2026-05-05T12:00:00.000Z'`,
            )
            .run();
        },
      ],
      [
        'delete an epoch entirely',
        () => {
          temp.db
            .prepare(
              `DELETE FROM model_pricing
                WHERE model = 'mid-day-model' AND effective_from = '2026-05-05T14:00:00.000Z'`,
            )
            .run();
        },
      ],
      [
        'unprice a model that had usage, so its tokens must resurface as unpriced',
        () => {
          temp.db.prepare("DELETE FROM model_pricing WHERE model = 'mid-day-model'").run();
        },
      ],
      [
        'delete the usage row again',
        () => {
          temp.db.prepare("DELETE FROM token_usage WHERE message_id = 'eq-rollup'").run();
        },
      ],
    ];

    let previous = getCostSummary(temp.db, TOP_N);
    for (const [label, mutate] of mutations) {
      mutate();
      const served = getCostSummary(temp.db, TOP_N);
      expect(served, label).toEqual(ledgerOracle(temp.db));
      // Each mutation is chosen to MOVE the answer, so the equality cannot pass
      // by the summary simply never changing.
      expect(served, label).not.toEqual(previous);
      previous = served;
    }
  });

  it('agrees with the pre-cutover ledger scan to far better than a cent', () => {
    // The cutover changed the float accumulation order deliberately (one term
    // per rollup GROUP over an exact integer total, instead of one term per
    // ledger row inside SQLite's SUM). This is the proof that the change is
    // last-bit noise and not money: tokens must match EXACTLY, dollars to
    // within a nanodollar.
    const { temp } = seedRichDatabase();
    const sessions = (
      temp.db.prepare('SELECT COUNT(DISTINCT session_id) AS c FROM token_usage').get() as {
        c: number;
      }
    ).c;
    const summary = getCostSummary(temp.db, sessions);

    const [totals] = ledgerSqlAggregate(temp.db, 'NULL');
    expect(totals?.tokens).toBe(summary.totals.tokens);
    expect(totals?.unpriced_tokens).toBe(summary.totals.unpricedTokens);
    expect(totals?.cost_usd).toBeCloseTo(summary.totals.costUsd, 9);
    // Anti-vacuity: a NULL/0 SQL side would satisfy nothing above by accident.
    expect(summary.totals.costUsd).toBeGreaterThan(0);
    expect(summary.totals.unpricedTokens).toBeGreaterThan(0);

    const entryOf = (key: string, totals: OracleTotals): KeyedTotals => ({
      key,
      tokens: totals.tokens,
      costUsd: totals.costUsd,
      unpricedTokens: totals.unpricedTokens,
    });
    const grouped: Array<[string, string, readonly KeyedTotals[]]> = [
      ['perModel', 'model', summary.perModel.map((e) => entryOf(e.model, e))],
      [
        'perDay',
        "CASE WHEN occurred_at IS NULL THEN 'unknown' ELSE substr(occurred_at, 1, 10) END",
        summary.perDay.map((e) => entryOf(e.day, e)),
      ],
      ['topSessions', 'session_id', summary.topSessions.map((e) => entryOf(e.sessionId, e))],
    ];
    for (const [label, keyExpr, served] of grouped) {
      const sql = new Map(ledgerSqlAggregate(temp.db, keyExpr).map((row) => [row.key, row]));
      expect(served.length, label).toBe(sql.size);
      for (const entry of served) {
        const row = sql.get(entry.key);
        expect(row, `${label}/${entry.key}`).toBeDefined();
        expect(row?.tokens, `${label}/${entry.key}`).toBe(entry.tokens);
        expect(row?.unpriced_tokens, `${label}/${entry.key}`).toBe(entry.unpricedTokens);
        expect(row?.cost_usd ?? 0, `${label}/${entry.key}`).toBeCloseTo(entry.costUsd, 9);
      }
    }
  });

  it('splits one calendar day into two rollup rows when the rate changes mid-day', () => {
    // The structural half of the dated-rate test above: the rollup GRAIN, not
    // just the dollar it produces. A (session, model, bucket, day) rollup would
    // hold one row here and could not reproduce the number from it.
    const { temp } = seedRichDatabase();
    const known = mainSessionIdOf(getFixture('flat-tool-use'));
    const rows = temp.db
      .prepare(
        `SELECT rate_effective_from, tokens, row_count FROM token_usage_rollup
          WHERE session_id = ? AND model = 'mid-day-model' AND bucket = 'input'
            AND day = '2026-05-05'
          ORDER BY rate_effective_from`,
      )
      .all(known);
    expect(rows).toEqual([
      { rate_effective_from: '2020-01-01T00:00:00.000Z', tokens: 1000, row_count: 1 },
      { rate_effective_from: '2026-05-05T12:00:00.000Z', tokens: 1000, row_count: 1 },
    ]);
    // The 900-token row that predates every rate is stored with the EMPTY rate
    // pointer - the rollup's encoding of "unpriced", never a $0 guess.
    expect(
      temp.db
        .prepare(
          `SELECT tokens FROM token_usage_rollup
            WHERE session_id = ? AND model = 'mid-day-model' AND rate_effective_from = ''`,
        )
        .all(known),
    ).toEqual([{ tokens: 900 }]);
    expect(getCostSummary(temp.db, TOP_N)).toEqual(ledgerOracle(temp.db));
  });

  it('distinguishes a $0 price from no price at all', () => {
    const { temp } = seedRichDatabase();
    // Usage first, price second, on purpose: the pricing-side triggers have to
    // retro-recompute the slice, or these tokens stay in the unpriced bucket.
    temp.db
      .prepare(
        `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
         VALUES (?, NULL, 'eq-free', 'free-model', 'input', 1234, '2026-05-05T09:00:00.000Z')`,
      )
      .run(mainSessionIdOf(getFixture('flat-tool-use')));
    insertPrice(temp.db, 'free-model', 0, '2020-01-01T00:00:00.000Z');

    const summary = getCostSummary(temp.db, TOP_N);
    // Both cost $0. Only one of them is an ADMISSION that the cost is unknown.
    expect(summary.perModel).toContainEqual({
      model: 'free-model',
      tokens: 1234,
      costUsd: 0,
      unpricedTokens: 0,
    });
    expect(summary.perModel).toContainEqual({
      model: 'model-nobody-priced',
      tokens: 700,
      costUsd: 0,
      unpricedTokens: 700,
    });
    expect(summary).toEqual(ledgerOracle(temp.db));
  });

  it("puts usage with no timestamp in the 'unknown' day, unpriced and sorted last", () => {
    const { temp } = seedRichDatabase();
    const undated = (
      temp.db
        .prepare('SELECT COALESCE(SUM(tokens), 0) AS t FROM token_usage WHERE occurred_at IS NULL')
        .get() as { t: number }
    ).t;
    expect(undated).toBeGreaterThan(0);

    const summary = getCostSummary(temp.db, TOP_N);
    // No date means no rate can be dated against it - unpriceable even though
    // this model IS priced, and disclosed rather than dropped.
    expect(summary.perDay.at(-1)).toEqual({
      day: 'unknown',
      tokens: undated,
      costUsd: 0,
      unpricedTokens: undated,
    });
    expect(summary.perDay.slice(0, -1).map((entry) => entry.day)).not.toContain('unknown');
    // The real days ahead of it are most-recent first.
    const days = summary.perDay.slice(0, -1).map((entry) => entry.day);
    expect(days).toEqual([...days].sort((a, b) => byText(b, a)));
    expect(summary).toEqual(ledgerOracle(temp.db));
  });

  it('keeps a null project slug for a usage session with no sessions row', () => {
    const { temp } = seedRichDatabase();
    const orphan = '99999999-0000-4000-8000-000000000000';
    expect(
      temp.db.prepare('SELECT 1 AS one FROM sessions WHERE id = ?').get(orphan),
    ).toBeUndefined();

    const summary = getCostSummary(temp.db, TOP_N);
    // 4,000,000 tokens at $3/Mtok: the most expensive session in the corpus, so
    // it cannot fall out of the top-N and quietly take the null case with it.
    expect(summary.topSessions[0]).toEqual({
      sessionId: orphan,
      projectSlug: null,
      tokens: 4_000_000,
      costUsd: 12,
      unpricedTokens: 0,
    });
    expect(summary).toEqual(ledgerOracle(temp.db));
  });

  it('truncates topSessions to topN without moving a single total', () => {
    const { temp } = seedRichDatabase();
    const sessions = (
      temp.db.prepare('SELECT COUNT(DISTINCT session_id) AS c FROM token_usage').get() as {
        c: number;
      }
    ).c;
    expect(sessions).toBeGreaterThan(2);
    const full = getCostSummary(temp.db, sessions);
    expect(full.topSessions).toHaveLength(sessions);

    for (const topN of [0, 1, 2, sessions - 1]) {
      const served = getCostSummary(temp.db, topN);
      // The cap is a presentation limit on ONE list; the totals it sits next to
      // are corpus-wide, and a cap that moved them would understate the bill.
      expect(served.topSessions, `topN=${topN}`).toEqual(full.topSessions.slice(0, topN));
      expect(served.totals, `topN=${topN}`).toEqual(full.totals);
      expect(served.perModel, `topN=${topN}`).toEqual(full.perModel);
      expect(served.perDay, `topN=${topN}`).toEqual(full.perDay);
      expect(served, `topN=${topN}`).toEqual(ledgerOracle(temp.db, topN));
    }
  });

  it('reports an empty ledger as zeros, not as a missing answer', () => {
    const temp = createMigratedTempDb();
    temps.push(temp);
    expect(temp.db.prepare('SELECT COUNT(*) AS c FROM token_usage_rollup').get()).toEqual({ c: 0 });

    const summary = getCostSummary(temp.db, TOP_N);
    expect(summary).toEqual({
      totals: { tokens: 0, costUsd: 0, unpricedTokens: 0 },
      perModel: [],
      perDay: [],
      topSessions: [],
      sessionCount: 0,
      hasMore: false,
    });
    expect(summary).toEqual(ledgerOracle(temp.db));
    // A migrated database is NOT empty of prices - so "no rows" here is the
    // ledger being empty, not the pricing read having silently failed.
    expect(
      (temp.db.prepare('SELECT COUNT(*) AS c FROM model_pricing').get() as { c: number }).c,
    ).toBeGreaterThan(0);
  });

  it('refuses to price a rollup row whose model_pricing row has gone missing', () => {
    // The loud guard in `rateFor`. A live database cannot reach this state -
    // the pricing triggers recompute the affected slice on every INSERT,
    // UPDATE and DELETE of a rate - so it is forced here by writing a dangling
    // pointer straight into the rollup, which nothing guards.
    const { temp } = seedRichDatabase();
    expect(getCostSummary(temp.db, TOP_N).totals.costUsd).toBeGreaterThan(0);
    const victim = temp.db
      .prepare(
        `SELECT session_id, model, bucket, day, rate_effective_from FROM token_usage_rollup
          WHERE rate_effective_from <> '' LIMIT 1`,
      )
      .get() as {
      session_id: string;
      model: string;
      bucket: string;
      day: string;
      rate_effective_from: string;
    };
    expect(victim).toBeDefined();
    temp.db
      .prepare(
        `UPDATE token_usage_rollup SET rate_effective_from = '2999-01-01T00:00:00.000Z'
          WHERE session_id = ? AND model = ? AND bucket = ? AND day = ?
            AND rate_effective_from = ?`,
      )
      .run(victim.session_id, victim.model, victim.bucket, victim.day, victim.rate_effective_from);

    // A torn invariant is reported, never smoothed over into $0 or a re-scan.
    expect(() => getCostSummary(temp.db, TOP_N)).toThrow(
      /token_usage_rollup names a model_pricing row that does not exist/,
    );
  });

  it('refuses to report a cost when two pricing rows mean the same instant', () => {
    // The loud guard in `readRateTable`. Migration 14's canonicalizing trigger
    // makes this unreachable through SQL - two spellings of one instant collide
    // on the primary key - so the trigger is dropped first to reach the arm.
    // Left in place, the ambiguity would silently pick one of two rates.
    const { temp } = seedRichDatabase();
    temp.db.exec('DROP TRIGGER model_pricing_effective_from_canonical_insert');
    const insert = temp.db.prepare(
      'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
    );
    insert.run('ambiguous-model', 'input', 2, '2026-01-01T00:00:00.000Z');
    insert.run('ambiguous-model', 'input', 40, '2026-01-01');
    // Two rows, distinct as stored, identical once canonicalized.
    expect(
      (
        temp.db
          .prepare(
            `SELECT COUNT(*) AS c FROM model_pricing WHERE model = 'ambiguous-model'
              AND strftime('%Y-%m-%dT%H:%M:%fZ', effective_from) = '2026-01-01T00:00:00.000Z'`,
          )
          .get() as { c: number }
      ).c,
    ).toBe(2);

    expect(() => getCostSummary(temp.db, TOP_N)).toThrow(/model_pricing holds two rows/);
  });

  /**
   * The SCENARIO MATRIX - a second, hand-built database whose only job is to
   * put one row on each edge of the pricing rule at once, so the equality
   * against the ledger is proved where it is most likely to break rather than
   * only on a broad corpus.
   *
   * Kept separate from `seedRichDatabase` on purpose: those fixtures carry
   * asserted-on totals, and folding these rows into them would have meant
   * rewriting existing expectations to make new ones pass.
   *
   * What each row is here to prove:
   *  - `claude-fable-5` in ALL FIVE buckets, at the five DIFFERENT seeded rates
   *    (10 / 50 / 1 / 12.5 / 20 per Mtok) - a per-bucket rate mix-up cannot
   *    hide behind a single flat rate;
   *  - `edge-model` three times around one rate instant: one millisecond
   *    before, EXACTLY ON it, and one millisecond after - the boundary is
   *    `effective_from <= occurred_at`, so the middle row must take the NEW
   *    rate, and all three share one calendar day;
   *  - `<synthetic>` - a REAL production model id priced $0 by the migration
   *    seed - once inside its epoch ($0 and PRICED) and once before it (no rate
   *    in force, so unpriced), which are the two facts a naive $0 conflates;
   *  - `never-priced-model`, for a model with no pricing row at all;
   *  - a NULL `occurred_at`, for the `unknown` day;
   *  - one session with usage on two different calendar days.
   */
  function seedScenarioDatabase(): TempDb {
    const temp = createMigratedTempDb();
    temps.push(temp);
    temp.db.exec(`
      INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
        ('sc-buckets', 'proj-buckets', '2026-06-01T00:00:00Z', '2026-06-01T23:00:00Z', 'active'),
        ('sc-span', 'proj-span', '2026-06-01T00:00:00Z', '2026-06-02T23:00:00Z', 'active'),
        ('sc-edge', NULL, '2026-06-01T00:00:00Z', '2026-06-01T23:00:00Z', 'active');
    `);
    // Two epochs for one model, the second starting mid-day.
    insertPrice(temp.db, 'edge-model', 2, '2020-01-01T00:00:00.000Z');
    insertPrice(temp.db, 'edge-model', 8, '2026-06-01T12:00:00.000Z');
    insertPrice(temp.db, 'span-model', 4, '2020-01-01T00:00:00.000Z');

    const usage = temp.db.prepare(
      `INSERT INTO token_usage
         (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    );
    for (const bucket of BUCKETS) {
      usage.run('sc-buckets', `sc-five-${bucket}`, 'claude-fable-5', bucket, 1_000_000, DAY_ONE);
    }
    usage.run('sc-buckets', 'sc-no-timestamp', 'claude-fable-5', 'input', 300, null);

    usage.run('sc-edge', 'sc-edge-before', 'edge-model', 'input', 1000, '2026-06-01T11:59:59.999Z');
    usage.run('sc-edge', 'sc-edge-exact', 'edge-model', 'input', 1000, RATE_INSTANT);
    usage.run('sc-edge', 'sc-edge-after', 'edge-model', 'input', 1000, '2026-06-01T12:00:00.001Z');
    usage.run('sc-edge', 'sc-synthetic-priced', '<synthetic>', 'input', 5000, DAY_ONE);
    usage.run(
      'sc-edge',
      'sc-synthetic-early',
      '<synthetic>',
      'input',
      700,
      '2025-12-31T23:59:59.999Z',
    );
    usage.run('sc-edge', 'sc-unpriced', 'never-priced-model', 'input', 400, DAY_ONE);

    usage.run('sc-span', 'sc-span-day-one', 'span-model', 'input', 1_000_000, DAY_ONE);
    usage.run('sc-span', 'sc-span-day-two', 'span-model', 'output', 500_000, DAY_TWO);
    return temp;
  }

  /** `GET /api/cost/summary` on a real server over the given database. */
  async function servedSummary(db: SqliteDatabase, topN = TOP_N): Promise<unknown> {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/cost/summary?topN=${topN}`,
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    } finally {
      await app.close();
    }
  }

  it('serves the scenario matrix over HTTP exactly as the ledger says', async () => {
    // The end-to-end form of the cutover assertion: not `getCostSummary`'s
    // return value but the BYTES the client receives, compared to a summary
    // re-derived from `token_usage` alone. Response serialization is inside the
    // comparison, so a schema that rounded or dropped a field would fail here.
    const temp = seedScenarioDatabase();
    const oracle = ledgerOracle(temp.db);
    expect(await servedSummary(temp.db)).toEqual(oracle);
    expect(getCostSummary(temp.db, TOP_N)).toEqual(oracle);

    // Guard the guard: the matrix must actually contain every edge it claims.
    expect(oracle.totals.tokens).toBe(6_509_400);
    expect(oracle.totals.unpricedTokens).toBe(1400);
    // $93.50 for the five fable buckets + $6 for the two-day session + $0.018
    // for the three rows around the rate instant; `<synthetic>` adds a real $0.
    expect(oracle.totals.costUsd).toBeCloseTo(93.5 + 6 + 0.018, 9);
    expect(oracle.perDay.map((entry) => entry.day)).toEqual([
      DAY_TWO.slice(0, 10),
      DAY_ONE.slice(0, 10),
      '2025-12-31',
      'unknown',
    ]);
    expect(oracle.perModel.map((entry) => entry.model)).toEqual([
      'claude-fable-5',
      'span-model',
      'edge-model',
      '<synthetic>',
      'never-priced-model',
    ]);
    expect(oracle.topSessions.map((entry) => entry.sessionId)).toEqual([
      'sc-buckets',
      'sc-span',
      'sc-edge',
    ]);
  });

  it('prices a row landing exactly on the rate instant at the NEW rate', async () => {
    // `effective_from <= occurred_at`: the instant belongs to the epoch it
    // opens. Off by one here and the row silently keeps the OLD rate, which no
    // total-level assertion would notice on a corpus without a row on the tick.
    const temp = seedScenarioDatabase();
    expect(
      temp.db
        .prepare(
          `SELECT rate_effective_from, tokens, row_count FROM token_usage_rollup
            WHERE session_id = 'sc-edge' AND model = 'edge-model' AND bucket = 'input'
              AND day = '2026-06-01'
            ORDER BY rate_effective_from`,
        )
        .all(),
    ).toEqual([
      // Only the millisecond BEFORE the instant stays on the old epoch.
      { rate_effective_from: '2020-01-01T00:00:00.000Z', tokens: 1000, row_count: 1 },
      // The row ON the instant joins the row after it, at the new rate.
      { rate_effective_from: RATE_INSTANT, tokens: 2000, row_count: 2 },
    ]);

    const summary = getCostSummary(temp.db, TOP_N);
    const edge = summary.perModel.find((entry) => entry.model === 'edge-model');
    expect(edge?.tokens).toBe(3000);
    expect(edge?.unpricedTokens).toBe(0);
    expect(edge?.costUsd).toBeCloseTo((1000 * 2 + 2000 * 8) / 1_000_000, 15);
    // Had the boundary been exclusive, the tick row would have cost $2/Mtok.
    expect(edge?.costUsd).not.toBeCloseTo((2000 * 2 + 1000 * 8) / 1_000_000, 15);
    expect(summary).toEqual(ledgerOracle(temp.db));
    expect(await servedSummary(temp.db)).toEqual(summary);
  });

  it('prices every one of the five buckets at its own rate', async () => {
    // The seeded `claude-fable-5` rates are all different (10 / 50 / 1 / 12.5 /
    // 20 per Mtok), so a bucket read from the wrong column, or a rate applied
    // per model instead of per bucket, moves this total.
    const temp = seedScenarioDatabase();
    const perBucket = temp.db
      .prepare(
        `SELECT bucket, tokens, rate_effective_from FROM token_usage_rollup
          WHERE session_id = 'sc-buckets' AND model = 'claude-fable-5' AND day = '2026-06-01'
          ORDER BY bucket`,
      )
      .all();
    expect(perBucket).toEqual(
      [...BUCKETS].sort(byText).map((bucket) => ({
        bucket,
        tokens: 1_000_000,
        rate_effective_from: '2026-01-01T00:00:00.000Z',
      })),
    );

    const summary = getCostSummary(temp.db, TOP_N);
    const fable = summary.perModel.find((entry) => entry.model === 'claude-fable-5');
    // 1M tokens in each bucket: input $10 + output $50 + cache_read $1 +
    // cache_write_5m $12.50 + cache_write_1h $20.
    expect(fable?.costUsd).toBeCloseTo(93.5, 9);
    expect(fable?.tokens).toBe(5_000_300);
    // The 300 undated tokens are this model's too, and stay disclosed.
    expect(fable?.unpricedTokens).toBe(300);
    // No single flat rate reproduces the figure - the per-bucket rates are load-bearing.
    for (const flat of [10, 50, 1, 12.5, 20]) {
      expect(fable?.costUsd).not.toBeCloseTo((5 * 1_000_000 * flat) / 1_000_000, 6);
    }
    expect(summary).toEqual(ledgerOracle(temp.db));
    expect(await servedSummary(temp.db)).toEqual(summary);
  });

  it('separates a $0 production model from usage before its epoch', async () => {
    // `<synthetic>` is a real model id the parser emits, priced $0 for every
    // bucket from 2026-01-01. Inside the epoch its tokens are PRICED and cost
    // nothing; before it, no rate is in force and the same $0 would be a guess,
    // so the tokens surface as unpriced instead.
    const temp = seedScenarioDatabase();
    const summary = getCostSummary(temp.db, TOP_N);
    expect(summary.perModel).toContainEqual({
      model: '<synthetic>',
      tokens: 5700,
      costUsd: 0,
      unpricedTokens: 700,
    });
    // The pre-epoch row is alone on its day, so the distinction is visible
    // there too rather than only in an aggregate that mixes it with others.
    expect(summary.perDay).toContainEqual({
      day: '2025-12-31',
      tokens: 700,
      costUsd: 0,
      unpricedTokens: 700,
    });
    // ...and the rollup stores the two rows under different rate pointers: the
    // seeded epoch, and the empty string that means "no rate was in force".
    expect(
      temp.db
        .prepare(
          `SELECT day, rate_effective_from, tokens FROM token_usage_rollup
            WHERE model = '<synthetic>' ORDER BY day`,
        )
        .all(),
    ).toEqual([
      { day: '2025-12-31', rate_effective_from: '', tokens: 700 },
      { day: '2026-06-01', rate_effective_from: '2026-01-01T00:00:00.000Z', tokens: 5000 },
    ]);
    expect(summary).toEqual(ledgerOracle(temp.db));
    expect(await servedSummary(temp.db)).toEqual(summary);
  });

  it('reports one session spanning two days as one session and two days', async () => {
    // A session is not a day. `sc-span` must appear once in `topSessions` with
    // both days summed, and its tokens must be split across `perDay` - the two
    // groupings are independent partitions of the same rows.
    const temp = seedScenarioDatabase();
    const summary = getCostSummary(temp.db, TOP_N);
    expect(summary.topSessions.filter((entry) => entry.sessionId === 'sc-span')).toEqual([
      {
        sessionId: 'sc-span',
        projectSlug: 'proj-span',
        tokens: 1_500_000,
        // 1M input at $4/Mtok on day one + 0.5M output at $4/Mtok on day two.
        costUsd: 6,
        unpricedTokens: 0,
      },
    ]);
    const dayTwo = summary.perDay.find((entry) => entry.day === DAY_TWO.slice(0, 10));
    // Day two holds this session and nothing else in the whole matrix.
    expect(dayTwo).toEqual({
      day: '2026-06-02',
      tokens: 500_000,
      costUsd: 2,
      unpricedTokens: 0,
    });
    expect(summary).toEqual(ledgerOracle(temp.db));
    expect(await servedSummary(temp.db)).toEqual(summary);
  });

  it('still matches the ledger over HTTP after an UPDATE and a DELETE', async () => {
    // The seeded rollup and the trigger-maintained rollup are different code
    // paths in migration 16. Everything above proves the seeded one; this
    // drives the ledger through an in-place UPDATE and a DELETE afterwards and
    // re-proves the served bytes against a fresh ledger re-derivation each
    // time, so a trigger that forgot to subtract cannot pass.
    const temp = seedScenarioDatabase();
    let previous = await servedSummary(temp.db);
    expect(previous).toEqual(ledgerOracle(temp.db));

    const steps: Array<[string, () => void]> = [
      [
        'update tokens in place on the row sitting exactly on the rate instant',
        () => {
          temp.db
            .prepare("UPDATE token_usage SET tokens = 7000 WHERE message_id = 'sc-edge-exact'")
            .run();
        },
      ],
      [
        'move that same row back across the rate boundary',
        () => {
          temp.db
            .prepare(
              `UPDATE token_usage SET occurred_at = '2026-06-01T00:30:00.000Z'
                WHERE message_id = 'sc-edge-exact'`,
            )
            .run();
        },
      ],
      [
        'delete one of the five buckets outright',
        () => {
          temp.db.prepare("DELETE FROM token_usage WHERE message_id = 'sc-five-output'").run();
        },
      ],
      [
        'delete the whole of the two-day session',
        () => {
          temp.db.prepare("DELETE FROM token_usage WHERE session_id = 'sc-span'").run();
        },
      ],
    ];

    for (const [label, mutate] of steps) {
      mutate();
      const served = await servedSummary(temp.db);
      expect(served, label).toEqual(ledgerOracle(temp.db));
      // Each step is chosen to MOVE the answer, so the equality cannot pass by
      // the summary simply never changing.
      expect(served, label).not.toEqual(previous);
      previous = served;
    }

    // The deletes must have PRUNED, not zeroed: migration 16 removes a rollup
    // row once its `row_count` reaches 0, and a stale zero row would still be
    // counted into `perModel` / `perDay` as a $0 entry that the ledger denies.
    expect(
      temp.db
        .prepare("SELECT COUNT(*) AS c FROM token_usage_rollup WHERE session_id = 'sc-span'")
        .get(),
    ).toEqual({ c: 0 });
  });

  /**
   * THE FALSIFIABILITY AUDIT.
   *
   * Everything above asserts that the served value EQUALS a re-derivation from
   * the ledger. An equality assertion is only worth what it costs to break, so
   * this block does the opposite job: it tampers with `token_usage_rollup`
   * directly - the one table nothing in the schema guards - and requires the
   * audited assertion to FAIL. A tamper the assertion does not notice is
   * recorded here as VACUOUS with the reason, rather than left to look like
   * coverage.
   *
   * Every verdict in the catalogue below was RUN, not reasoned about. Two of
   * them are the findings worth carrying out of this file:
   *
   *  - `row_count` is invisible to the cost read (it never selects the column),
   *    so no assertion in this file can falsify a `row_count` corruption. That
   *    is proven in `db-token-usage-rollup-equivalence.test.ts` instead.
   *  - a rate pointer moved to a REAL but WRONG `model_pricing` row is a
   *    SILENTLY wrong dollar: `rateFor`'s loud guard fires on a pointer that
   *    resolves to nothing, and only on that. See the dedicated test below,
   *    which measures the wrong number rather than describing it.
   */
  describe('falsifiability - the equivalence assertions can actually fail', () => {
    /**
     * Run an assertion and report its FAILURE rather than its success: the
     * message when it failed, `null` when it held. This is how one test proves
     * another test's assertion is not vacuous - tamper, then require non-null.
     */
    function assertionFailure(assert: () => void): string | null {
      try {
        assert();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return null;
    }

    interface RollupKey {
      readonly session_id: string;
      readonly model: string;
      readonly bucket: string;
      readonly day: string;
      readonly rate_effective_from: string;
      readonly tokens: number;
    }

    /**
     * The largest PRICED rollup group - the one whose corruption moves the most
     * dollars, so a tamper that this row cannot make visible is genuinely
     * invisible rather than merely small.
     */
    function pricedVictim(db: SqliteDatabase): RollupKey {
      const row = db
        .prepare(
          `SELECT session_id, model, bucket, day, rate_effective_from, tokens
             FROM token_usage_rollup
            WHERE rate_effective_from <> ''
            ORDER BY tokens DESC, session_id, model, bucket, day
            LIMIT 1`,
        )
        .get() as RollupKey | undefined;
      if (row === undefined) {
        throw new Error('the fixture holds no priced rollup row to tamper with');
      }
      return row;
    }

    /** Run `sql` against exactly the one rollup row `victim` names. */
    function atKey(db: SqliteDatabase, sql: string, victim: RollupKey): void {
      const info = db
        .prepare(
          `${sql} WHERE session_id = ? AND model = ? AND bucket = ? AND day = ?
             AND rate_effective_from = ?`,
        )
        .run(
          victim.session_id,
          victim.model,
          victim.bucket,
          victim.day,
          victim.rate_effective_from,
        );
      // A tamper that matched nothing would make the whole audit pass vacuously
      // in the other direction: the assertion would "hold" because nothing was
      // ever broken.
      expect(info.changes).toBe(1);
    }

    /**
     * What the cost read is MEASURED to do about one tamper.
     *
     *  - `ledger-oracle-catches-it` - the served value moves AND parts company
     *    with `ledgerOracle`, so the assertion above bites.
     *  - `loud-throw` - `getCostSummary` refuses to answer at all.
     *  - `invisible-to-the-cost-read` - VACUOUS: the served value is unmoved,
     *    with the reason recorded on the entry.
     */
    interface TamperShape {
      readonly label: string;
      readonly apply: (db: SqliteDatabase, victim: RollupKey) => void;
    }

    type RollupTamper =
      | (TamperShape & {
          readonly verdict: 'ledger-oracle-catches-it';
          /**
           * MEASURED: whether the served dollars MOVE when this tamper lands.
           *
           * `false` is the more alarming answer and it really happens - a
           * dropped trigger leaves the rollup frozen while the ledger grows, so
           * the bill silently keeps its old, too-small value. Recorded per
           * entry because "the served value changed" is not the property being
           * proven; "the served value disagrees with the ledger" is.
           */
          readonly servedMoves: boolean;
        })
      | (TamperShape & { readonly verdict: 'loud-throw' })
      | (TamperShape & { readonly verdict: 'invisible-to-the-cost-read' });

    const TAMPERS: readonly RollupTamper[] = [
      {
        label: 'add one token to a priced group',
        verdict: 'ledger-oracle-catches-it',
        servedMoves: true,
        apply: (db, victim) => {
          atKey(db, 'UPDATE token_usage_rollup SET tokens = tokens + 1', victim);
        },
      },
      {
        label: 'zero the tokens of a priced group',
        verdict: 'ledger-oracle-catches-it',
        servedMoves: true,
        apply: (db, victim) => {
          atKey(db, 'UPDATE token_usage_rollup SET tokens = 0', victim);
        },
      },
      {
        label: 'delete a priced group outright',
        verdict: 'ledger-oracle-catches-it',
        servedMoves: true,
        apply: (db, victim) => {
          atKey(db, 'DELETE FROM token_usage_rollup', victim);
        },
      },
      {
        label: 'invent a group the ledger has no rows for',
        verdict: 'ledger-oracle-catches-it',
        servedMoves: true,
        apply: (db, victim) => {
          db.prepare(
            `INSERT INTO token_usage_rollup
               (session_id, model, bucket, day, rate_effective_from, tokens, row_count)
             VALUES (?, ?, ?, '2026-05-30', ?, 8000000, 1)`,
          ).run(victim.session_id, victim.model, victim.bucket, victim.rate_effective_from);
        },
      },
      {
        label: 'move a group to a different calendar day',
        verdict: 'ledger-oracle-catches-it',
        servedMoves: true,
        apply: (db, victim) => {
          atKey(db, "UPDATE token_usage_rollup SET day = '2026-05-09'", victim);
        },
      },
      {
        label: 'move a group to a different session',
        verdict: 'ledger-oracle-catches-it',
        servedMoves: true,
        apply: (db, victim) => {
          atKey(
            db,
            "UPDATE token_usage_rollup SET session_id = '11111111-0000-4000-8000-000000000000'",
            victim,
          );
        },
      },
      {
        label: 'blank the rate pointer, so priced tokens masquerade as unpriced',
        verdict: 'ledger-oracle-catches-it',
        servedMoves: true,
        apply: (db, victim) => {
          atKey(db, "UPDATE token_usage_rollup SET rate_effective_from = ''", victim);
        },
      },
      {
        label: 'point the rate at an instant no pricing row names',
        verdict: 'loud-throw',
        apply: (db, victim) => {
          atKey(
            db,
            "UPDATE token_usage_rollup SET rate_effective_from = '2999-01-01T00:00:00.000Z'",
            victim,
          );
        },
      },
      {
        label: 'point the rate at a REAL but WRONG pricing epoch',
        verdict: 'ledger-oracle-catches-it',
        servedMoves: true,
        apply: (db, victim) => {
          // Seeded EARLIER than the epoch the victim resolved, so the pricing
          // triggers' rebuild of the slice leaves the victim key intact - the
          // new row loses the dated-rate race it triggers.
          insertPrice(db, victim.model, 111, '2019-06-01T00:00:00.000Z');
          atKey(
            db,
            "UPDATE token_usage_rollup SET rate_effective_from = '2019-06-01T00:00:00.000Z'",
            victim,
          );
        },
      },
      {
        label: 'rewrite row_count',
        verdict: 'invisible-to-the-cost-read',
        apply: (db, victim) => {
          atKey(db, 'UPDATE token_usage_rollup SET row_count = 999', victim);
        },
      },
      {
        label: 'drop the insert-side rollup trigger, then write a ledger row',
        verdict: 'ledger-oracle-catches-it',
        // MEASURED: the served total does NOT move. The ledger grew by 250,000
        // tokens and the bill did not notice - tokens vanish silently, and only
        // the ledger comparison objects.
        servedMoves: false,
        apply: (db) => {
          db.exec('DROP TRIGGER token_usage_rollup_usage_insert');
          db.prepare(
            `INSERT INTO token_usage
               (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
             VALUES (?, NULL, 'fals-missed-insert', 'synthetic-model-a', 'input', 250000,
                     '2026-05-08T10:00:00.000Z')`,
          ).run(mainSessionIdOf(getFixture('flat-tool-use')));
        },
      },
      {
        label: 'drop the pricing-update rollup trigger, then move a rate epoch',
        // MEASURED, and better than expected: moving an epoch out from under a
        // rollup row that still points at the old instant leaves a DANGLING
        // pointer, so `rateFor` refuses outright. This is the rate-miss path
        // reached WITHOUT writing to `token_usage_rollup` at all - the closest
        // thing to a realistic corruption (a half-applied migration) that this
        // audit found.
        verdict: 'loud-throw',
        apply: (db) => {
          db.exec('DROP TRIGGER token_usage_rollup_pricing_update');
          db.prepare(
            `UPDATE model_pricing SET effective_from = '2026-05-05T02:00:00.000Z'
              WHERE model = 'mid-day-model' AND effective_from = '2026-05-05T12:00:00.000Z'`,
          ).run();
        },
      },
    ];

    for (const tamper of TAMPERS) {
      it(`${tamper.verdict}: ${tamper.label}`, () => {
        const { temp } = seedRichDatabase();
        const before = getCostSummary(temp.db, TOP_N);
        // The audited assertion HOLDS before the tamper - otherwise "it failed
        // after the tamper" would prove nothing about the tamper.
        expect(
          assertionFailure(() => {
            expect(before).toEqual(ledgerOracle(temp.db));
          }),
        ).toBeNull();

        tamper.apply(temp.db, pricedVictim(temp.db));

        if (tamper.verdict === 'loud-throw') {
          expect(() => getCostSummary(temp.db, TOP_N)).toThrow(
            /token_usage_rollup names a model_pricing row that does not exist/,
          );
          return;
        }

        const served = getCostSummary(temp.db, TOP_N);
        const failure = assertionFailure(() => {
          expect(served).toEqual(ledgerOracle(temp.db));
        });
        if (tamper.verdict === 'invisible-to-the-cost-read') {
          // MEASURED: `getCostSummary` never selects `row_count`, so no
          // assertion in this file can falsify a `row_count` corruption. It is
          // recorded as vacuous HERE and proven elsewhere, rather than left to
          // look like coverage it is not.
          expect(failure).toBeNull();
          expect(served).toEqual(before);
          return;
        }
        // The assertion bites...
        expect(failure).not.toBeNull();
        // ...and the entry's own MEASURED note about the served value holds.
        // A tamper recorded as `servedMoves: true` that quietly stopped moving
        // the bill would mean the memo had begun masking it; one recorded as
        // `false` that started moving would mean the trigger it drops is no
        // longer the one doing the work.
        if (tamper.servedMoves) {
          expect(served).not.toEqual(before);
        } else {
          expect(served).toEqual(before);
        }
      });
    }

    it('never lets the one-entry memo mask a rollup written behind its back', () => {
      // The tampers above are only evidence if the memo cannot swallow them.
      // `costSummaryStateKey` leans on `total_changes()`; this measures that a
      // direct write to `token_usage_rollup` - a table no other assertion in
      // this file writes - really does move it on THIS connection.
      const { temp } = seedRichDatabase();
      const changesOf = (): number =>
        (temp.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      const first = getCostSummary(temp.db, TOP_N);
      // Served twice with nothing in between: this is a genuine cache hit.
      expect(getCostSummary(temp.db, TOP_N)).toBe(first);

      const changesBefore = changesOf();
      temp.db.prepare('UPDATE token_usage_rollup SET tokens = tokens + 1').run();
      expect(changesOf()).toBeGreaterThan(changesBefore);

      const after = getCostSummary(temp.db, TOP_N);
      expect(after).not.toBe(first);
      expect(after.totals.tokens).toBeGreaterThan(first.totals.tokens);
    });

    it('serves an answer computed inside a ROLLED BACK transaction', () => {
      // A DEFECT FOUND BY THIS AUDIT, recorded as measurement rather than as a
      // property to rely on. The docstring on `costSummaryStateKey` says a
      // rolled-back write "merely recomputes" because `total_changes()` counts
      // it too, and that "the design errs only in the never-stale direction".
      // The first half is true; the second is FALSE, and the two facts are the
      // same fact: `total_changes()` is NOT rewound by a rollback, so the key
      // computed INSIDE an aborted transaction is byte-identical to the key
      // after it, and the memo hands the aborted answer back for real.
      //
      // Reachability, measured: `getCostSummary` has exactly one call site in
      // `apps/server/src` (`routes.ts:337`, a route handler) and that call site
      // is not inside any `db.transaction(...)`. better-sqlite3 is synchronous
      // and Node is single-threaded, so no HTTP read can interleave into an
      // ingest transaction. This is a landmine, not a live bug: it arms the
      // moment any future code reads the cost summary inside a transaction that
      // can roll back. It is also NOT caused by the rollup cutover - the memo
      // predates it - but the cutover does not fix it either.
      const temp = createMigratedTempDb();
      temps.push(temp);
      temp.db
        .prepare(
          `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
           VALUES ('memo-rollback', 'proj-rollback', '2026-06-01T00:00:00Z',
                   '2026-06-01T23:00:00Z', 'active')`,
        )
        .run();
      insertPrice(temp.db, 'rollback-model', 10, '2020-01-01T00:00:00.000Z');
      temp.db
        .prepare(
          `INSERT INTO token_usage
             (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
           VALUES ('memo-rollback', NULL, 'rb-1', 'rollback-model', 'input',
                   1000000, '2026-06-01T09:00:00.000Z')`,
        )
        .run();
      const changesOf = (): number =>
        (temp.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      const rollupTokens = (): number =>
        (
          temp.db.prepare('SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage_rollup').get() as {
            n: number;
          }
        ).n;

      expect(getCostSummary(temp.db, TOP_N).totals).toEqual({
        tokens: 1_000_000,
        costUsd: 10,
        unpricedTokens: 0,
      });
      const changesBefore = changesOf();

      temp.db.exec('SAVEPOINT memo_rollback_probe');
      temp.db.prepare('DELETE FROM token_usage_rollup').run();
      const inside = getCostSummary(temp.db, TOP_N);
      expect(inside.totals).toEqual({ tokens: 0, costUsd: 0, unpricedTokens: 0 });
      const changesInside = changesOf();
      expect(changesInside).toBeGreaterThan(changesBefore);
      temp.db.exec('ROLLBACK TO memo_rollback_probe');
      temp.db.exec('RELEASE memo_rollback_probe');

      // The table is back...
      expect(rollupTokens()).toBe(1_000_000);
      // ...but the counter the state key is built from is not rewound...
      expect(changesOf()).toBe(changesInside);
      // ...so this is a cache HIT on the aborted answer: same object identity,
      // and a bill of $0 over a rollup that holds a million tokens.
      const after = getCostSummary(temp.db, TOP_N);
      expect(after).toBe(inside);
      expect(after.totals.costUsd).toBe(0);
      // The ledger disagrees, which is what makes this a wrong dollar and not
      // merely a stale one.
      expect(
        assertionFailure(() => {
          expect(after).toEqual(ledgerOracle(temp.db));
        }),
      ).not.toBeNull();

      // It is a stale READ, not lost data: the next write on this connection
      // moves the key and the correct bill comes back.
      temp.db.prepare(`UPDATE sessions SET status = 'active' WHERE id = 'memo-rollback'`).run();
      expect(getCostSummary(temp.db, TOP_N).totals).toEqual({
        tokens: 1_000_000,
        costUsd: 10,
        unpricedTokens: 0,
      });
    });

    it('prices a rate pointer that names a REAL but WRONG epoch with no complaint at all', () => {
      // THE SILENT CLASS, measured rather than described. `rateFor` throws when
      // the stored pointer resolves to NOTHING; a pointer that resolves to the
      // WRONG row resolves fine, and the dollar it produces is wrong with
      // nothing in the response or the log to say so. Only a comparison against
      // the ledger - which production never runs - can see it.
      //
      // A hand-built database, so the wrong number is exact and reproducible.
      const temp = createMigratedTempDb();
      temps.push(temp);
      temp.db
        .prepare(
          `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
           VALUES ('fals-silent', 'proj-silent', '2026-06-01T00:00:00Z',
                   '2026-06-01T23:00:00Z', 'active')`,
        )
        .run();
      insertPrice(temp.db, 'silent-model', 10, '2020-01-01T00:00:00.000Z');
      temp.db
        .prepare(
          `INSERT INTO token_usage
             (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
           VALUES ('fals-silent', NULL, 'fals-silent-1', 'silent-model', 'input', 1000000,
                   '2026-06-01T10:00:00.000Z')`,
        )
        .run();
      const honest = getCostSummary(temp.db, TOP_N);
      expect(honest.totals).toEqual({ tokens: 1_000_000, costUsd: 10, unpricedTokens: 0 });
      expect(honest).toEqual(ledgerOracle(temp.db));

      // A second, much dearer epoch that LOSES the dated-rate race, so the
      // rollup keeps pointing at the $10 row and the slice rebuild leaves it be.
      insertPrice(temp.db, 'silent-model', 9999, '2019-01-01T00:00:00.000Z');
      expect(getCostSummary(temp.db, TOP_N).totals.costUsd).toBe(10);
      const moved = temp.db
        .prepare(
          `UPDATE token_usage_rollup SET rate_effective_from = '2019-01-01T00:00:00.000Z'
            WHERE rate_effective_from = '2020-01-01T00:00:00.000Z'`,
        )
        .run();
      expect(moved.changes).toBe(1);

      // MEASURED: no throw, the token count is untouched, nothing surfaces as
      // unpriced - and the bill is 999.9x the truth.
      const wrong = getCostSummary(temp.db, TOP_N);
      expect(wrong.totals).toEqual({ tokens: 1_000_000, costUsd: 9999, unpricedTokens: 0 });
      expect(ledgerOracle(temp.db).totals.costUsd).toBe(10);
      // The ledger comparison is the ONLY thing that objects.
      expect(
        assertionFailure(() => {
          expect(wrong).toEqual(ledgerOracle(temp.db));
        }),
      ).not.toBeNull();
    });

    it('goes stale when the ledger is written from ANOTHER connection', () => {
      // THE MEMO'S BLIND SPOT, measured rather than argued.
      //
      // `costSummaryStateKey` mixes `total_changes()`, which counts only THIS
      // connection's writes, with the full content of `model_pricing`, which is
      // read fresh. So a `model_pricing` write from a second connection moves
      // the key (that is the documented operator path, and the suite above
      // exercises it), while a `token_usage` write from a second connection
      // does not - even though the rollup on disk has already followed it.
      //
      // This is the single-writer assumption `getCostSummary` states in prose,
      // pinned here as a measurement so that a future change which quietly
      // widens or narrows it is noticed. It is NOT a cutover regression: the
      // memo and this key predate the rollup read (git: `costSummaryStateKey`
      // arrives in 71f6878, `token_usage_rollup` appears in this file only in
      // the uncommitted cutover), and the pre-cutover read was memoized behind
      // the identical key. The pre-cutover code is not in the tree, so that
      // last clause is read from history, not run.
      const { temp } = seedRichDatabase();
      const before = getCostSummary(temp.db, TOP_N);

      const other = openDatabase(temp.path);
      try {
        other
          .prepare(
            `INSERT INTO token_usage
               (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
             VALUES (?, NULL, 'fals-cross-conn', 'synthetic-model-a', 'input', 3000000,
                     '2026-05-08T10:00:00.000Z')`,
          )
          .run(mainSessionIdOf(getFixture('flat-tool-use')));
      } finally {
        other.close();
      }

      // The rollup DID follow the write - the triggers ran on that connection,
      // and this connection can see the row.
      expect(
        temp.db
          .prepare(
            `SELECT tokens FROM token_usage_rollup
              WHERE day = '2026-05-08' AND model = 'synthetic-model-a'`,
          )
          .all(),
      ).toEqual([{ tokens: 3_000_000 }]);
      // ...and the served value is STALE anyway: the memo answered.
      expect(getCostSummary(temp.db, TOP_N)).toBe(before);
      // A fresh handle - no memo - reads the truth, so the staleness is the
      // cache and not the rollup.
      expect(uncachedScan(temp.path).totals.tokens).toBe(before.totals.tokens + 3_000_000);
      // Any write on THIS connection resyncs it.
      temp.db.prepare("DELETE FROM token_usage WHERE message_id = 'fals-cross-conn'").run();
      expect(getCostSummary(temp.db, TOP_N)).toEqual(ledgerOracle(temp.db));
    });

    it('fails the HTTP request outright on a rate miss, never serving a smaller bill', async () => {
      // THE RATE-MISS PATH, at the boundary the operator actually sees. The
      // throw is only worth anything if it reaches the wire as a failure: a
      // handler that swallowed it, or a serializer that emitted the fields it
      // had, would turn a torn invariant into a cheaper-looking invoice.
      const temp = seedScenarioDatabase();
      const honest = await servedSummary(temp.db);
      expect(honest).toEqual(ledgerOracle(temp.db));

      // Reached WITHOUT touching `token_usage_rollup`: drop the pricing-side
      // DELETE trigger, then remove the rate the rollup points at. This is the
      // shape a half-applied migration or a hand-edited database leaves behind.
      temp.db.exec('DROP TRIGGER token_usage_rollup_pricing_delete');
      const removed = temp.db
        .prepare(
          `DELETE FROM model_pricing
            WHERE model = 'edge-model' AND effective_from = '2026-06-01T12:00:00.000Z'`,
        )
        .run();
      expect(removed.changes).toBe(BUCKETS.length);

      const app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
      try {
        const response = await app.inject({
          method: 'GET',
          url: `/api/cost/summary?topN=${TOP_N}`,
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        });
        // 500, not 200. There is no partial answer and no $0 arm.
        expect(response.statusCode).toBe(500);
        const body: unknown = response.json();
        expect(JSON.stringify(body)).not.toContain('totals');
      } finally {
        await app.close();
      }

      // The in-process error names the model, the bucket and the instant, so
      // the operator can repair the row rather than guess at it.
      expect(() => getCostSummary(temp.db, TOP_N)).toThrow(
        /model=edge-model bucket=input effective_from=2026-06-01T12:00:00\.000Z/,
      );
      // And the refusal is TOTAL: the priced tokens of the intact rows are not
      // quietly served without the broken one.
      const intact = (
        temp.db
          .prepare("SELECT SUM(tokens) AS t FROM token_usage WHERE model <> 'edge-model'")
          .get() as { t: number }
      ).t;
      expect(intact).toBeGreaterThan(0);
      expect(() => getCostSummary(temp.db, 0)).toThrow();
    });

    /**
     * ONE session, ONE model, ONE bucket, ONE calendar day - three ledger rows
     * straddling a mid-day rate change. The token counts are integers and the
     * rates are powers of two over 1e6, so every dollar below is exactly
     * representable and can be compared with `toBe` rather than a tolerance.
     */
    function seedGrainDatabase(): TempDb {
      const temp = createMigratedTempDb();
      temps.push(temp);
      temp.db
        .prepare(
          `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
           VALUES ('grain', 'proj-grain', '2026-06-01T00:00:00Z',
                   '2026-06-01T23:00:00Z', 'active')`,
        )
        .run();
      insertPrice(temp.db, 'grain-model', 2, '2020-01-01T00:00:00.000Z');
      insertPrice(temp.db, 'grain-model', 8, '2026-06-01T12:00:00.000Z');
      const usage = temp.db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
         VALUES ('grain', NULL, ?, 'grain-model', 'input', ?, ?)`,
      );
      usage.run('grain-early-a', 1_000_000, '2026-06-01T09:00:00.000Z');
      usage.run('grain-early-b', 500_000, '2026-06-01T11:00:00.000Z');
      usage.run('grain-late', 2_000_000, '2026-06-01T20:00:00.000Z');
      return temp;
    }

    it('neither doubles nor drops a dollar when one day spans two rate epochs', () => {
      // THE GRAIN, proven on the case the key was widened for. One session, one
      // model, one bucket, ONE calendar day, three ledger rows straddling a
      // mid-day rate change. Every number below is exact: the token counts are
      // integers and the dollars are chosen to be exactly representable.
      const temp = seedGrainDatabase();

      // TWO rollup rows for ONE (session, model, bucket, day) - and their token
      // totals partition the ledger exactly: nothing counted twice, nothing
      // left out.
      const split = temp.db
        .prepare(
          `SELECT rate_effective_from, tokens, row_count FROM token_usage_rollup
            WHERE session_id = 'grain' AND day = '2026-06-01'
            ORDER BY rate_effective_from`,
        )
        .all();
      expect(split).toEqual([
        { rate_effective_from: '2020-01-01T00:00:00.000Z', tokens: 1_500_000, row_count: 2 },
        { rate_effective_from: '2026-06-01T12:00:00.000Z', tokens: 2_000_000, row_count: 1 },
      ]);
      const ledgerTokens = (
        temp.db.prepare('SELECT SUM(tokens) AS t FROM token_usage').get() as { t: number }
      ).t;
      const rollupTokens = (
        temp.db.prepare('SELECT SUM(tokens) AS t FROM token_usage_rollup').get() as { t: number }
      ).t;
      expect(rollupTokens).toBe(ledgerTokens);
      expect(rollupTokens).toBe(3_500_000);

      // The bill: 1.5 Mtok at $2 + 2 Mtok at $8 = $19, on ONE day line.
      const summary = getCostSummary(temp.db, TOP_N);
      expect(summary.perDay).toEqual([
        { day: '2026-06-01', tokens: 3_500_000, costUsd: 19, unpricedTokens: 0 },
      ]);
      expect(summary.totals).toEqual({ tokens: 3_500_000, costUsd: 19, unpricedTokens: 0 });
      expect(summary).toEqual(ledgerOracle(temp.db));
      // Neither single rate reproduces $19, so the day grain genuinely lost
      // information that this key keeps: a rollup that had merged the two rows
      // could only ever have reported $7 or $28.
      expect((3_500_000 * 2) / 1_000_000).not.toBe(19);
      expect((3_500_000 * 8) / 1_000_000).not.toBe(19);

      // BOTH split rows are load-bearing: deleting either one drops exactly its
      // own tokens and its own dollars, so neither is a duplicate of the other.
      for (const [rate, tokens, cost] of [
        ['2020-01-01T00:00:00.000Z', 1_500_000, 3],
        ['2026-06-01T12:00:00.000Z', 2_000_000, 16],
      ] as const) {
        // A FRESH database per probe, not a savepoint: a read taken inside a
        // transaction that is later rolled back poisons the memo for the rest
        // of the connection (measured - see the defect test below), which would
        // have made this loop prove the opposite of what it claims.
        const probe = seedGrainDatabase();
        probe.db.prepare('DELETE FROM token_usage_rollup WHERE rate_effective_from = ?').run(rate);
        const after = getCostSummary(probe.db, TOP_N);
        expect(after.totals.tokens, rate).toBe(3_500_000 - tokens);
        expect(after.totals.costUsd, rate).toBe(19 - cost);
        // ...and the ledger notices, which is what makes the split provable.
        expect(
          assertionFailure(() => {
            expect(after).toEqual(ledgerOracle(probe.db));
          }),
          rate,
        ).not.toBeNull();
      }
      // The database under test was never touched by the probes.
      expect(getCostSummary(temp.db, TOP_N)).toEqual(summary);

      // MERGING BACK. Delete the mid-day epoch and the two rows collapse into
      // one: the tokens are conserved through the merge and the whole day
      // reprices at the surviving rate.
      temp.db
        .prepare("DELETE FROM model_pricing WHERE effective_from = '2026-06-01T12:00:00.000Z'")
        .run();
      expect(
        temp.db
          .prepare(
            `SELECT rate_effective_from, tokens, row_count FROM token_usage_rollup
              WHERE session_id = 'grain'`,
          )
          .all(),
      ).toEqual([
        { rate_effective_from: '2020-01-01T00:00:00.000Z', tokens: 3_500_000, row_count: 3 },
      ]);
      const merged = getCostSummary(temp.db, TOP_N);
      expect(merged.totals).toEqual({ tokens: 3_500_000, costUsd: 7, unpricedTokens: 0 });
      expect(merged).toEqual(ledgerOracle(temp.db));

      // ...and SPLITTING AGAIN, into THREE epochs this time, still conserves
      // every token.
      insertPrice(temp.db, 'grain-model', 8, '2026-06-01T10:00:00.000Z');
      insertPrice(temp.db, 'grain-model', 20, '2026-06-01T12:00:00.000Z');
      expect(
        temp.db
          .prepare(
            `SELECT rate_effective_from, tokens, row_count FROM token_usage_rollup
              WHERE session_id = 'grain' ORDER BY rate_effective_from`,
          )
          .all(),
      ).toEqual([
        { rate_effective_from: '2020-01-01T00:00:00.000Z', tokens: 1_000_000, row_count: 1 },
        { rate_effective_from: '2026-06-01T10:00:00.000Z', tokens: 500_000, row_count: 1 },
        { rate_effective_from: '2026-06-01T12:00:00.000Z', tokens: 2_000_000, row_count: 1 },
      ]);
      const three = getCostSummary(temp.db, TOP_N);
      // 1 Mtok at $2 + 0.5 Mtok at $8 + 2 Mtok at $20 = $46.
      expect(three.totals).toEqual({ tokens: 3_500_000, costUsd: 46, unpricedTokens: 0 });
      expect(three).toEqual(ledgerOracle(temp.db));
    });

    it('serves a NEGATIVE bill over HTTP even though the schema says minimum 0', async () => {
      // `CostTotalsSchema` declares `minimum: 0` on tokens, costUsd and
      // unpricedTokens. Response serialization is fast-json-stringify, which
      // SERIALIZES to the schema rather than validating against it, so the
      // bound is documentation, not a guard. Measured here end to end: a
      // negative rollup row (the shape migration 16's subtract arm creates on
      // purpose - see db-token-usage-rollup-trigger-order.test.ts) leaves the
      // process as a 200 carrying a negative dollar figure.
      const temp = createMigratedTempDb();
      temps.push(temp);
      temp.db
        .prepare(
          `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
           VALUES ('neg', 'proj-neg', '2026-06-01T00:00:00Z',
                   '2026-06-01T23:00:00Z', 'active')`,
        )
        .run();
      insertPrice(temp.db, 'neg-model', 10, '2020-01-01T00:00:00.000Z');
      temp.db
        .prepare(
          `INSERT INTO token_usage
             (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
           VALUES ('neg', NULL, 'neg-1', 'neg-model', 'input',
                   1000000, '2026-06-01T09:00:00.000Z')`,
        )
        .run();
      expect(await servedSummary(temp.db)).toMatchObject({
        totals: { tokens: 1_000_000, costUsd: 10, unpricedTokens: 0 },
      });

      // Flip the one row negative directly - the same arithmetic state the
      // subtract arm reaches, reached in one statement.
      const flipped = temp.db.prepare('UPDATE token_usage_rollup SET tokens = -tokens').run();
      expect(flipped.changes).toBe(1);

      // Status 200 (servedSummary asserts it), and the body carries -$10.
      expect(await servedSummary(temp.db)).toMatchObject({
        totals: { tokens: -1_000_000, costUsd: -10, unpricedTokens: 0 },
      });
    });
  });
});
