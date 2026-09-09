/**
 * Migration 16 "Step 1" - the BACKFILL SEED, run against a database that
 * already held a ledger.
 *
 * WHY THIS FILE EXISTS. `test/helpers.ts::createMigratedTempDb()` opens a brand
 * new EMPTY file and then runs every migration, so migration 16's seed scan
 * always executes over zero rows and the rollup that every other test inspects
 * was built entirely by the SIX TRIGGERS. The seed is therefore the one code
 * path in migration 16 that no test in this repository reached until this file -
 * and it is the only one that runs on a real operator upgrade, where
 * `token_usage` is already full. The gap was confirmed empirically before this
 * file was written: corrupting the seed to write `day = 'MUTANT-SEED'`,
 * `SUM(tokens) * 7 + 1` and `COUNT(*) + 99` left the whole suite as it then
 * stood green. Every test below therefore builds its database by hand -
 * prefix-migrate, write data, then apply 16 - and none of them may use
 * `createMigratedTempDb()`.
 *
 * WHAT PROVES THE SEED RAN. The last `runMigrations` call must report
 * `appliedIds === [16]`. Nothing else in the file distinguishes a rollup the
 * seed wrote from one the triggers wrote, so that assertion is load-bearing:
 * if 16 had already been applied, the rows would be trigger output and the
 * file would be testing the same thing every other file tests. That call is
 * prefix-scoped to `m.id <= 16`, in the same idiom as the two stages of
 * `buildPre16Ledger` below, so the assertion keeps saying "16 ran HERE" as
 * migrations are appended after it rather than accreting their ids.
 *
 * THE ORACLE IS LOCAL AND NON-SQL, ON PURPOSE. `scanRollupInJs` below rebuilds
 * the expected grouping in JavaScript, resolving dated rates by `Date.parse`
 * epoch comparison. It is a deliberate re-derivation rather than an import from
 * `db-token-usage-rollup-equivalence.test.ts`: the seed is a single SQL
 * statement, so an oracle written in SQL risks sharing SQLite's own date
 * semantics with the thing it is checking. It is NOT the same code object as
 * the equivalence suite's comparator and this file does not claim to reuse it.
 *
 * NON-VACUITY. The oracle alone cannot catch a seed that is uniformly wrong in
 * the same way the oracle is, so Test 1 additionally pins the ENTIRE expected
 * rollup as a hardcoded table of ten tuples, computed by hand from the fixture,
 * plus a conservation check against the raw ledger. A scaling bug of the
 * `SUM(...) * 7 + 1` shape has nowhere to hide behind those.
 *
 * WHAT THIS FILE DOES *NOT* PROVE - the seed's `strftime` wrapping on raw text.
 * Migration 16's key expressions wrap `occurred_at` in
 * `strftime('%Y-%m-%dT%H:%M:%fZ', ...)`. That wrapping CANNOT be exercised on
 * non-canonical stored text through any upgrade path this project ships, and
 * the fixture below demonstrates why rather than pretending otherwise: the
 * legacy row is written at prefix <= 14 (before migration 15 exists) in the
 * offset spelling `2026-05-05T20:00:00-05:00`, and migration 15's own Step 1
 * rewrites it to `2026-05-06T01:00:00.000Z` on the way past - so by the time
 * migration 16's seed reads the column, the text is already canonical. Both
 * halves are asserted below. The seed's `strftime` and its `COALESCE` fallback
 * are therefore UNPROVEN by this file; they are defensive code against a state
 * the shipped migration order makes unreachable, and this file reaches neither.
 * What IS proven end to end is that the legacy row lands on the CANONICAL day
 * (2026-05-06, not the 2026-05-05 an operator typed), which is the property the
 * upgrade path owes its user.
 *
 * That gap is measured, not merely suspected. Mutant m18 - `strftime` removed
 * from BOTH of the seed's own key derivations, triggers untouched - was run
 * against the entire server suite and SURVIVED: 77 files / 1045 tests still
 * passed, so nothing anywhere in this repository covers it. The cause is the
 * same one described above (migration 15 canonicalizes the column before the
 * seed reads it), compounded by this file's JS oracle deriving `day` with
 * `slice(0, 10)` of that same stored text, which makes raw-text and `strftime`
 * derivation indistinguishable from every state the migrations can reach. Do
 * not "fix" this by loosening the oracle; the only real fix is a pre-16
 * database carrying non-canonical `occurred_at` that migration 15 did not
 * rewrite, which the shipped migration order does not permit to exist.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCostSummary } from '../src/api/queries';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { migrations, runMigrations } from '../src/db/migrations';
import { insertSession } from './helpers';

/** One rollup group, in the column spelling the table itself uses. */
interface RollupRow {
  readonly session_id: string;
  readonly model: string;
  readonly bucket: string;
  readonly day: string;
  readonly rate_effective_from: string;
  readonly tokens: number;
  readonly row_count: number;
}

// --- temp databases ----------------------------------------------------------

const opened: Array<{ db: SqliteDatabase; dir: string }> = [];

/** A brand new EMPTY database file with no migration applied to it yet. */
function openTempDatabase(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'agenthropic-rollup-seed-'));
  const db = openDatabase(join(dir, 'x.db'));
  opened.push({ db, dir });
  return db;
}

afterEach(() => {
  for (const entry of opened.splice(0)) {
    try {
      entry.db.close();
    } catch {
      // already closed by the test
    }
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

// --- the oracle --------------------------------------------------------------

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

function sortKey(row: RollupRow): readonly string[] {
  return [row.session_id, row.model, row.bucket, row.day, row.rate_effective_from];
}

/**
 * What the rollup MUST contain, rebuilt in JavaScript from the raw ledger.
 *
 * Rate resolution is done by epoch milliseconds rather than by text ordering,
 * so it does not inherit migration 16's assumption that the stored spelling
 * sorts chronologically. Sorted with plain string comparison, which matches
 * SQLite's BINARY collation for the ASCII-only values these fixtures use.
 */
function scanRollupInJs(db: SqliteDatabase): RollupRow[] {
  const usage = db
    .prepare('SELECT session_id, model, bucket, tokens, occurred_at FROM token_usage')
    .all() as UsageRowShape[];
  const rates = db
    .prepare('SELECT model, bucket, effective_from FROM model_pricing')
    .all() as RateRowShape[];

  const groups = new Map<string, RollupRow>();
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
    const mapKey = [row.session_id, row.model, row.bucket, day, rate].join('\u0000');
    const existing = groups.get(mapKey);
    groups.set(mapKey, {
      session_id: row.session_id,
      model: row.model,
      bucket: row.bucket,
      day,
      rate_effective_from: rate,
      tokens: (existing?.tokens ?? 0) + row.tokens,
      row_count: (existing?.row_count ?? 0) + 1,
    });
  }

  return [...groups.values()].sort((a, b) => {
    const left = sortKey(a);
    const right = sortKey(b);
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
  return sortKey(row)
    .map((part) => (part === '' ? '<empty>' : part))
    .join(' | ');
}

/** A readable list of divergences, each naming the key it happened at. */
function diffRollup(expected: readonly RollupRow[], stored: readonly RollupRow[]): string[] {
  const diffs: string[] = [];
  const storedByKey = new Map(stored.map((row) => [keyOf(row), row]));
  for (const want of expected) {
    const key = keyOf(want);
    const got = storedByKey.get(key);
    if (got === undefined) {
      diffs.push(
        `MISSING from rollup: ${key} (the ledger says tokens=${String(want.tokens)}, ` +
          `row_count=${String(want.row_count)})`,
      );
      continue;
    }
    if (got.tokens !== want.tokens) {
      diffs.push(
        `tokens differ at ${key}: rollup=${String(got.tokens)}, ledger=${String(want.tokens)}`,
      );
    }
    if (got.row_count !== want.row_count) {
      diffs.push(
        `row_count differs at ${key}: rollup=${String(got.row_count)}, ` +
          `ledger=${String(want.row_count)}`,
      );
    }
  }
  const wantedKeys = new Set(expected.map(keyOf));
  for (const got of stored) {
    const key = keyOf(got);
    if (!wantedKeys.has(key)) {
      diffs.push(
        `EXTRA in rollup: ${key} (rollup says tokens=${String(got.tokens)}, ` +
          `row_count=${String(got.row_count)}; the ledger produces no such group)`,
      );
    }
  }
  return diffs.sort();
}

/**
 * THE shared assertion: the stored rollup equals the JavaScript reconstruction
 * of a direct grouped scan. Thrown rather than matched so the divergent keys
 * survive into the failure message.
 */
function expectRollupMatchesScan(db: SqliteDatabase): RollupRow[] {
  const expected = scanRollupInJs(db);
  const diffs = diffRollup(expected, readRollup(db));
  if (diffs.length > 0) {
    throw new Error(
      `token_usage_rollup diverges from the direct grouped scan:\n  ${diffs.join('\n  ')}`,
    );
  }
  return expected;
}

// --- the pre-16 fixture ------------------------------------------------------

const SESSION_A = 's-seed-a';
const SESSION_B = 's-seed-b';
/** Priced in `input` and `output` only - `cache_read` stays on the '' sentinel. */
const PRICED = 'seed-priced-model';
/** Deliberately carries NO `model_pricing` row in any bucket. */
const UNPRICED = 'seed-unpriced-model';
/** Used only by Test 2, to reach a key the seed never wrote. */
const FRESH = 'seed-fresh-model';

const BASE_RATE_FROM = '2020-01-01T00:00:00.000Z';
/** Falls BETWEEN two of 2026-05-01's usage rows: that day must split in two. */
const MID_DAY_RATE_FROM = '2026-05-01T12:00:00.000Z';

interface RateFixture {
  readonly model: string;
  readonly bucket: string;
  readonly usd: number;
  /** As typed by whoever wrote the row, not necessarily canonical. */
  readonly effectiveFrom: string;
}

const RATES: readonly RateFixture[] = [
  // Bare-date spellings, the form migration 7's seed used and an operator at
  // the sqlite3 CLI types. Migration 14's canonicalizer rewrites them on write.
  { model: PRICED, bucket: 'input', usd: 5, effectiveFrom: '2020-01-01' },
  { model: PRICED, bucket: 'output', usd: 25, effectiveFrom: '2020-01-01' },
  { model: PRICED, bucket: 'input', usd: 9, effectiveFrom: MID_DAY_RATE_FROM },
];

interface UsageFixture {
  readonly messageId: string;
  readonly session: string;
  readonly model: string;
  readonly bucket: string;
  readonly tokens: number;
  readonly occurredAt: string | null;
}

/**
 * The legacy row, written at prefix <= 14 - i.e. before migration 15 installs
 * the guard and canonicalizing triggers that would rewrite it on arrival.
 * `2026-05-05T20:00:00-05:00` is `2026-05-06T01:00:00Z`: the raw text and the
 * true instant fall on DIFFERENT calendar days, so a day derived from the
 * stored spelling would file this spend under a day nothing happened on.
 */
const LEGACY_SPELLING = '2026-05-05T20:00:00-05:00';
const LEGACY_CANONICAL = '2026-05-06T01:00:00.000Z';
const LEGACY_ROW: UsageFixture = {
  messageId: 'seed-legacy',
  session: SESSION_A,
  model: PRICED,
  bucket: 'input',
  tokens: 1_234,
  occurredAt: LEGACY_SPELLING,
};

/** Written at prefix <= 15, where migration 15's guards are already live. */
const CANONICAL_ROWS: readonly UsageFixture[] = [
  // Two sides of the mid-day rate boundary, same session/model/bucket/day.
  { ...LEGACY_ROW, messageId: 'seed-u1', tokens: 1_000, occurredAt: '2026-05-01T01:00:00.000Z' },
  { ...LEGACY_ROW, messageId: 'seed-u2', tokens: 2_000, occurredAt: '2026-05-01T11:59:59.999Z' },
  // `effective_from <= occurred_at`, so the instant of the change itself is
  // already on the new rate.
  { ...LEGACY_ROW, messageId: 'seed-u3', tokens: 4_000, occurredAt: MID_DAY_RATE_FROM },
  { ...LEGACY_ROW, messageId: 'seed-u4', tokens: 500, occurredAt: '2026-05-01T23:00:00.000Z' },
  // A second calendar day, a second bucket, and a bucket with no rate at all.
  {
    ...LEGACY_ROW,
    messageId: 'seed-u5',
    bucket: 'output',
    tokens: 700,
    occurredAt: '2026-05-02T08:00:00.000Z',
  },
  {
    ...LEGACY_ROW,
    messageId: 'seed-u6',
    bucket: 'cache_read',
    tokens: 0,
    occurredAt: '2026-05-02T08:00:00.000Z',
  },
  // The 'unknown' day sentinel.
  { ...LEGACY_ROW, messageId: 'seed-u7', tokens: 7, occurredAt: null },
  // A second session, and a model with no pricing row anywhere.
  {
    ...LEGACY_ROW,
    messageId: 'seed-u8',
    session: SESSION_B,
    model: UNPRICED,
    tokens: 500,
    occurredAt: '2026-05-03T10:00:00.000Z',
  },
  {
    ...LEGACY_ROW,
    messageId: 'seed-u9',
    session: SESSION_B,
    model: UNPRICED,
    bucket: 'output',
    tokens: 250,
    occurredAt: '2026-05-03T11:00:00.000Z',
  },
  {
    ...LEGACY_ROW,
    messageId: 'seed-u10',
    session: SESSION_B,
    tokens: 60,
    occurredAt: '2026-05-01T13:00:00.000Z',
  },
  {
    ...LEGACY_ROW,
    messageId: 'seed-u11',
    session: SESSION_B,
    model: UNPRICED,
    bucket: 'cache_write_5m',
    tokens: 0,
    occurredAt: null,
  },
];

const LEDGER_ROWS = CANONICAL_ROWS.length + 1;
const LEDGER_TOKENS = 10_251;

/**
 * The whole answer, computed by hand from the fixture above and hardcoded so a
 * uniformly-scaled seed cannot pass a shape-only comparison. Ordered the way
 * `readRollup` orders (SQLite BINARY collation on the five key columns).
 */
const EXPECTED_SEED: readonly RollupRow[] = [
  {
    session_id: SESSION_A,
    model: PRICED,
    bucket: 'cache_read',
    day: '2026-05-02',
    rate_effective_from: '',
    tokens: 0,
    row_count: 1,
  },
  // The mid-day split: ONE calendar day, TWO rollup rows, one per rate epoch.
  {
    session_id: SESSION_A,
    model: PRICED,
    bucket: 'input',
    day: '2026-05-01',
    rate_effective_from: BASE_RATE_FROM,
    tokens: 3_000,
    row_count: 2,
  },
  {
    session_id: SESSION_A,
    model: PRICED,
    bucket: 'input',
    day: '2026-05-01',
    rate_effective_from: MID_DAY_RATE_FROM,
    tokens: 4_500,
    row_count: 2,
  },
  // The legacy offset row, filed under the CANONICAL day.
  {
    session_id: SESSION_A,
    model: PRICED,
    bucket: 'input',
    day: '2026-05-06',
    rate_effective_from: MID_DAY_RATE_FROM,
    tokens: 1_234,
    row_count: 1,
  },
  {
    session_id: SESSION_A,
    model: PRICED,
    bucket: 'input',
    day: 'unknown',
    rate_effective_from: '',
    tokens: 7,
    row_count: 1,
  },
  {
    session_id: SESSION_A,
    model: PRICED,
    bucket: 'output',
    day: '2026-05-02',
    rate_effective_from: BASE_RATE_FROM,
    tokens: 700,
    row_count: 1,
  },
  {
    session_id: SESSION_B,
    model: PRICED,
    bucket: 'input',
    day: '2026-05-01',
    rate_effective_from: MID_DAY_RATE_FROM,
    tokens: 60,
    row_count: 1,
  },
  {
    session_id: SESSION_B,
    model: UNPRICED,
    bucket: 'cache_write_5m',
    day: 'unknown',
    rate_effective_from: '',
    tokens: 0,
    row_count: 1,
  },
  {
    session_id: SESSION_B,
    model: UNPRICED,
    bucket: 'input',
    day: '2026-05-03',
    rate_effective_from: '',
    tokens: 500,
    row_count: 1,
  },
  {
    session_id: SESSION_B,
    model: UNPRICED,
    bucket: 'output',
    day: '2026-05-03',
    rate_effective_from: '',
    tokens: 250,
    row_count: 1,
  },
];

// --- fixture writers ---------------------------------------------------------

function insertUsage(db: SqliteDatabase, row: UsageFixture): void {
  db.prepare(
    `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?)`,
  ).run(row.session, row.messageId, row.model, row.bucket, row.tokens, row.occurredAt);
}

function insertRate(db: SqliteDatabase, rate: RateFixture): void {
  db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
  ).run(rate.model, rate.bucket, rate.usd, rate.effectiveFrom);
}

function occurredAtOf(db: SqliteDatabase, messageId: string): string | null {
  return (
    db.prepare('SELECT occurred_at AS at FROM token_usage WHERE message_id = ?').get(messageId) as {
      at: string | null;
    }
  ).at;
}

function idOf(db: SqliteDatabase, messageId: string): number {
  return (
    db.prepare('SELECT id FROM token_usage WHERE message_id = ?').get(messageId) as { id: number }
  ).id;
}

function groupAt(
  db: SqliteDatabase,
  key: Pick<RollupRow, 'session_id' | 'model' | 'bucket' | 'day' | 'rate_effective_from'>,
): { tokens: number; row_count: number } | undefined {
  return db
    .prepare(
      `SELECT tokens, row_count FROM token_usage_rollup
        WHERE session_id = ? AND model = ? AND bucket = ? AND day = ? AND rate_effective_from = ?`,
    )
    .get(key.session_id, key.model, key.bucket, key.day, key.rate_effective_from) as
    { tokens: number; row_count: number } | undefined;
}

/**
 * Build the pre-16 database an operator would be upgrading FROM, in two
 * prefix-migration stages.
 *
 * Stage A stops at 14 so the legacy row can be stored in its raw offset
 * spelling: at prefix <= 15 migration 15's AFTER INSERT canonicalizer would
 * rewrite it before the row ever settles, which is a different fixture than
 * "text that has been sitting in the file since before migration 15 shipped".
 * Stage B then applies 15 alone and asserts what it did to that row.
 */
function buildPre16Ledger(db: SqliteDatabase): void {
  const toFourteen = runMigrations(
    db,
    migrations.filter((m) => m.id <= 14),
  );
  expect(toFourteen.appliedIds).toEqual(migrations.filter((m) => m.id <= 14).map((m) => m.id));

  insertSession(db, SESSION_A);
  insertSession(db, SESSION_B);
  for (const rate of RATES) {
    insertRate(db, rate);
  }
  insertUsage(db, LEGACY_ROW);
  // Guard the guard: the legacy row really is non-canonical IN STORAGE here.
  expect(occurredAtOf(db, LEGACY_ROW.messageId)).toBe(LEGACY_SPELLING);

  const toFifteen = runMigrations(
    db,
    migrations.filter((m) => m.id <= 15),
  );
  expect(toFifteen.appliedIds).toEqual([15]);
  // ...and migration 15's own Step 1 has already canonicalized it, which is
  // exactly why migration 16's seed can never observe raw text on any shipped
  // upgrade path. See the file docstring: the seed's strftime wrapping is
  // UNPROVEN here, not proven by this row.
  expect(occurredAtOf(db, LEGACY_ROW.messageId)).toBe(LEGACY_CANONICAL);
  // Migration 14's canonicalizer did the same for the bare-date rates.
  expect(
    db
      .prepare('SELECT effective_from AS f FROM model_pricing WHERE model = ? AND bucket = ?')
      .pluck()
      .all(PRICED, 'output'),
  ).toEqual([BASE_RATE_FROM]);

  for (const row of CANONICAL_ROWS) {
    insertUsage(db, row);
  }
  // Guard the guard: migration 16 has NOT run, so no rollup exists to be right.
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'token_usage_rollup'").get(),
  ).toBeUndefined();
}

/** Apply migration 16 to a loaded pre-16 database and prove the SEED ran. */
function applyMigrationSixteen(db: SqliteDatabase): void {
  // Stage C, scoped to 16 exactly as stages A and B are scoped to 14 and 15.
  // An unscoped call would also apply everything appended after 16 - which is
  // schema this file has no business carrying and, worse, would turn the
  // assertion below into a list that grows with every future migration, so a
  // reader could no longer tell "16 ran here" from "16 was already applied and
  // something else ran". Nothing after 16 touches `token_usage` or
  // `token_usage_rollup`, so the fixture loses no coverage by stopping here.
  const applied = runMigrations(
    db,
    migrations.filter((m) => m.id <= 16),
  );
  // The whole file rests on this: [16] means the rows in `token_usage_rollup`
  // were produced by Step 1's grouped scan over data that was already there,
  // not by the triggers reacting to writes.
  expect(applied.appliedIds).toEqual([16]);
}

function seededDatabase(): SqliteDatabase {
  const db = openTempDatabase();
  buildPre16Ledger(db);
  applyMigrationSixteen(db);
  return db;
}

// --- Test 1 ------------------------------------------------------------------

describe('migration 16 Step 1 - the backfill seed of an existing ledger', () => {
  it('seeds an existing ledger to exactly the direct grouped scan', () => {
    const db = seededDatabase();

    // (a) the rollup equals an independent reconstruction of the same grain.
    const scan = expectRollupMatchesScan(db);

    // (b) non-vacuous cardinality: an empty rollup would satisfy nothing here.
    expect(scan).toHaveLength(EXPECTED_SEED.length);
    expect(readRollup(db)).toHaveLength(EXPECTED_SEED.length);

    // (c) the exact table, tuple by tuple - including the mid-day split pair,
    // where one calendar day is carried as two rows with different rates.
    expect(readRollup(db)).toEqual(EXPECTED_SEED);
    expect(
      readRollup(db)
        .filter((row) => row.bucket === 'input' && row.day === '2026-05-01')
        .map((row) => [row.session_id, row.rate_effective_from, row.tokens, row.row_count]),
    ).toEqual([
      [SESSION_A, BASE_RATE_FROM, 3_000, 2],
      [SESSION_A, MID_DAY_RATE_FROM, 4_500, 2],
      [SESSION_B, MID_DAY_RATE_FROM, 60, 1],
    ]);

    // (d) conservation against the raw ledger.
    const totals = db
      .prepare(
        `SELECT (SELECT SUM(tokens) FROM token_usage_rollup)    AS rollupTokens,
                (SELECT SUM(row_count) FROM token_usage_rollup) AS rollupRows,
                (SELECT SUM(tokens) FROM token_usage)           AS ledgerTokens,
                (SELECT COUNT(*) FROM token_usage)              AS ledgerRows`,
      )
      .get() as {
      rollupTokens: number;
      rollupRows: number;
      ledgerTokens: number;
      ledgerRows: number;
    };
    expect(totals.ledgerRows).toBe(LEDGER_ROWS); // guard the guard
    expect(totals.ledgerTokens).toBe(LEDGER_TOKENS);
    expect(totals.rollupTokens).toBe(totals.ledgerTokens);
    expect(totals.rollupRows).toBe(totals.ledgerRows);
  });

  it('files the legacy offset-spelled row under its canonical day, not the typed one', () => {
    const db = seededDatabase();

    // The operator wrote '2026-05-05T20:00:00-05:00'. The instant is on the
    // 6th, and that is the day the seed must charge - the same answer the
    // triggers give for the same spelling.
    expect(
      groupAt(db, {
        session_id: SESSION_A,
        model: PRICED,
        bucket: 'input',
        day: '2026-05-06',
        rate_effective_from: MID_DAY_RATE_FROM,
      }),
    ).toEqual({ tokens: 1_234, row_count: 1 });
    expect(readRollup(db).some((row) => row.day === '2026-05-05')).toBe(false);
  });

  it('FAILS when a seeded group is scaled, so the comparison is not decoration', () => {
    // Anti-vacuity for THIS file's comparator: the same corruption shape the
    // surviving seed mutation used (tokens * 7 + 1, row_count + 99) must be
    // reported, and the hardcoded table must reject it too.
    const db = seededDatabase();
    expectRollupMatchesScan(db);

    db.prepare(
      'UPDATE token_usage_rollup SET tokens = tokens * 7 + 1, row_count = row_count + 99',
    ).run();

    expect(() => expectRollupMatchesScan(db)).toThrow(/tokens differ at/);
    expect(readRollup(db)).not.toEqual(EXPECTED_SEED);
  });

  it("FAILS when a seeded group's day key is replaced", () => {
    const db = seededDatabase();

    // Only one group is corrupted, not all of them: `day` is part of a WITHOUT
    // ROWID primary key, and rewriting every row to one literal would collide
    // (the two 2026-05-01 / 2026-05-06 input groups share their other four key
    // columns) and fail as a constraint error instead of as a divergence.
    db.prepare(
      `UPDATE token_usage_rollup SET day = 'MUTANT-SEED'
        WHERE session_id = ? AND model = ? AND bucket = 'output'`,
    ).run(SESSION_A, PRICED);

    expect(() => expectRollupMatchesScan(db)).toThrow(/MISSING from rollup/);
    expect(() => expectRollupMatchesScan(db)).toThrow(/EXTRA in rollup/);
  });
});

// --- Test 2 ------------------------------------------------------------------

/**
 * The seed and the triggers must derive the SAME key from the same row, or the
 * first write after an upgrade silently forks a group in two.
 *
 * Test 1 pins the seed's keys against an oracle and the equivalence suite pins
 * the triggers' against the same grain, so in principle agreement follows from
 * the two. These tests do not rely on that inference: they mutate the ledger of
 * an already-seeded database, so a trigger has to actually land on - or
 * correctly miss - a row the SEED wrote, and the `toHaveLength` assertions see
 * a forked group directly rather than deducing its absence.
 */
describe('migration 16 - a seeded rollup and the triggers agree on the same grain', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = seededDatabase();
  });

  it('merges an INSERT into the group the seed already wrote', () => {
    insertUsage(db, {
      messageId: 'seed-hit',
      session: SESSION_A,
      model: PRICED,
      bucket: 'input',
      tokens: 111,
      occurredAt: '2026-05-01T02:00:00.000Z',
    });

    expectRollupMatchesScan(db);
    // The sharp assertion: had the seed spelled the key even slightly
    // differently, the trigger's ON CONFLICT would have missed it and left an
    // ELEVENTH row beside the seeded one instead of merging into it.
    expect(readRollup(db)).toHaveLength(EXPECTED_SEED.length);
    expect(
      groupAt(db, {
        session_id: SESSION_A,
        model: PRICED,
        bucket: 'input',
        day: '2026-05-01',
        rate_effective_from: BASE_RATE_FROM,
      }),
    ).toEqual({ tokens: 3_111, row_count: 3 });
  });

  it('opens a brand-new group beside the seeded ones', () => {
    insertUsage(db, {
      messageId: 'seed-new-key',
      session: SESSION_B,
      model: FRESH,
      bucket: 'cache_write_1h',
      tokens: 42,
      occurredAt: '2026-07-04T09:00:00.000Z',
    });

    expectRollupMatchesScan(db);
    expect(readRollup(db)).toHaveLength(EXPECTED_SEED.length + 1);
    expect(
      groupAt(db, {
        session_id: SESSION_B,
        model: FRESH,
        bucket: 'cache_write_1h',
        day: '2026-07-04',
        rate_effective_from: '',
      }),
    ).toEqual({ tokens: 42, row_count: 1 });
  });

  it('moves a seeded row across a day boundary AND a rate slice at once', () => {
    // seed-u1 sits on 2026-05-01 under the base rate; 2026-05-02T13:00Z is a
    // different day AND falls after the mid-day rate change, so both the
    // subtract (against a seeded row) and the add (into a key no row holds) are
    // exercised in one statement.
    db.prepare('UPDATE token_usage SET occurred_at = ? WHERE id = ?').run(
      '2026-05-02T13:00:00.000Z',
      idOf(db, 'seed-u1'),
    );

    expectRollupMatchesScan(db);
    expect(
      groupAt(db, {
        session_id: SESSION_A,
        model: PRICED,
        bucket: 'input',
        day: '2026-05-01',
        rate_effective_from: BASE_RATE_FROM,
      }),
    ).toEqual({ tokens: 2_000, row_count: 1 });
    expect(
      groupAt(db, {
        session_id: SESSION_A,
        model: PRICED,
        bucket: 'input',
        day: '2026-05-02',
        rate_effective_from: MID_DAY_RATE_FROM,
      }),
    ).toEqual({ tokens: 1_000, row_count: 1 });
    expect(readRollup(db)).toHaveLength(EXPECTED_SEED.length + 1);
  });

  it('removes a seeded group when its last ledger row is deleted', () => {
    // seed-u5 is the only row of its group, and that group exists ONLY because
    // the seed wrote it. The subtract has to find it and the prune has to drop
    // it; a drifted key would instead leave a ghost at tokens 700, row_count 1
    // plus a second row at -700, -1.
    db.prepare('DELETE FROM token_usage WHERE id = ?').run(idOf(db, 'seed-u5'));

    expectRollupMatchesScan(db);
    expect(
      groupAt(db, {
        session_id: SESSION_A,
        model: PRICED,
        bucket: 'output',
        day: '2026-05-02',
        rate_effective_from: BASE_RATE_FROM,
      }),
    ).toBeUndefined();
    expect(readRollup(db)).toHaveLength(EXPECTED_SEED.length - 1);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM token_usage_rollup WHERE tokens < 0 OR row_count < 0')
        .get(),
    ).toEqual({ n: 0 });
  });
});

// --- Test 3 ------------------------------------------------------------------

describe('migration 16 - the seed and the triggers produce the same table', () => {
  it('matches a database that built the same ledger entirely through triggers', () => {
    const upgraded = seededDatabase();

    // The same writes, in the same order, against a database where migration 16
    // was already installed - so every rollup row here is trigger output.
    const fresh = openTempDatabase();
    expect(runMigrations(fresh).appliedIds).toEqual(migrations.map((m) => m.id));
    insertSession(fresh, SESSION_A);
    insertSession(fresh, SESSION_B);
    for (const rate of RATES) {
      insertRate(fresh, rate);
    }
    // NOTE ON TRIGGER ORDER. On the fresh database this row fires migration
    // 15's canonicalizer AND migration 16's rollup trigger on one INSERT event,
    // and SQLite does NOT specify which runs first. The rollup key is derived
    // through the same canonicalizing function in either order, so the outcome
    // asserted below must hold whichever order this build happens to pick. This
    // test does not observe the order and does not claim to pin it.
    insertUsage(fresh, LEGACY_ROW);
    for (const row of CANONICAL_ROWS) {
      insertUsage(fresh, row);
    }

    // Guard the guard: the two ledgers really are the same data.
    const ledger = (db: SqliteDatabase): unknown[] =>
      db
        .prepare(
          `SELECT session_id, message_id, model, bucket, tokens, occurred_at
             FROM token_usage ORDER BY message_id`,
        )
        .all();
    expect(ledger(fresh)).toEqual(ledger(upgraded));

    expectRollupMatchesScan(fresh);
    expect(readRollup(fresh)).toEqual(EXPECTED_SEED);
    expect(readRollup(fresh)).toEqual(readRollup(upgraded));
  });

  /**
   * THE DOLLAR AT THE UPGRADE BOUNDARY. Every assertion above is about the
   * rollup TABLE. `getCostSummary` was switched to read its dollars from that
   * table, so the operator-visible question is narrower and this file is the
   * only place it can be asked: does the bill shown right after an upgrade
   * equal the bill the same ledger would have produced had it been ingested
   * after migration 16? The backfill seed and the six triggers are different
   * code, and only the seed runs on a real upgrade.
   */
  it('bills a backfilled ledger exactly as it bills a trigger-built one', () => {
    const upgraded = seededDatabase();
    const fresh = openTempDatabase();
    runMigrations(fresh);
    insertSession(fresh, SESSION_A);
    insertSession(fresh, SESSION_B);
    for (const rate of RATES) {
      insertRate(fresh, rate);
    }
    insertUsage(fresh, LEGACY_ROW);
    for (const row of CANONICAL_ROWS) {
      insertUsage(fresh, row);
    }

    const seededBill = getCostSummary(upgraded, 5);
    expect(seededBill).toEqual(getCostSummary(fresh, 5));

    // Non-vacuity, part 1: the bill is a real number over real tokens, not the
    // empty summary two empty databases would also agree on.
    expect(seededBill.totals.tokens).toBe(
      (upgraded.prepare('SELECT SUM(tokens) AS n FROM token_usage').get() as { n: number }).n,
    );
    expect(seededBill.totals.costUsd).toBeGreaterThan(0);

    // Non-vacuity, part 2: the mid-day split is PRICED as two rates on one day,
    // which is the whole reason rate_effective_from is in the key. Computed
    // from the fixture by hand: 3000 tokens at $5/Mtok and 4500 at $9/Mtok for
    // SESSION_A, plus SESSION_B's 60 at $9/Mtok, on 2026-05-01.
    const dayOne = seededBill.perDay.find((row) => row.day === '2026-05-01');
    expect(dayOne?.tokens).toBe(7_560);
    expect(dayOne?.costUsd).toBeCloseTo(
      (3_000 * 5 + 4_500 * 9 + 60 * 9) / 1_000_000,
      // 12 decimals: the value is ~0.056, so this is far tighter than the
      // difference a single-rate day would produce (0.0378 or 0.068).
      12,
    );

    // Non-vacuity, part 3: the equality above can fail. One token added to one
    // seeded group and the two bills part company.
    const scaled = upgraded
      .prepare(
        `UPDATE token_usage_rollup SET tokens = tokens + 1
          WHERE bucket = 'input' AND day = '2026-05-01'
            AND rate_effective_from = ?`,
      )
      .run(MID_DAY_RATE_FROM);
    expect(scaled.changes).toBeGreaterThan(0);
    expect(getCostSummary(upgraded, 5)).not.toEqual(getCostSummary(fresh, 5));
  });
});
