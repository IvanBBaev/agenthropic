/**
 * R15 / DAT-4 - the operator pricing path:
 * `pnpm --filter @agenthropic/server pricing <command>`.
 *
 * Before this module a rate could only change by shipping a migration, so a
 * new model id meant a release (four reactive pricing migrations, m18-m20 and
 * m24, in two months). Owner decision D3 (2026-10-30) chose a CLI with an
 * audit row over an admin endpoint: nothing new listens on the HTTP surface,
 * and the operator who can run the CLI can already write the database file.
 * Migrations keep the seed; the CLI covers everything after it.
 *
 * Commands:
 *   list      the dated rate table (read-only)
 *   unpriced  stored tokens no dated rate covers, per model (read-only)
 *   audit     the CLI's write history, newest first (read-only)
 *   set       write dated rates for one model, one audit row per changed rate
 *
 * `set` refuses while a dashboard server answers on the configured port. Every
 * write to `model_pricing` fires migration 16's rollup triggers, which rebuild
 * the (model, bucket) slice of `token_usage_rollup` by scanning `token_usage`
 * - on a large store that holds the write lock long enough to push the
 * server's own writes past its `busy_timeout`. Rates change rarely; a stopped
 * server for the few seconds it takes is the cheap side of that trade. The
 * running server would pick the change up without a restart (the watcher
 * re-reads pricing every pass, and the API caches key on the table's content),
 * so the refusal is about lock time, not about staleness.
 *
 * Every rate goes through `upsertPricingRate`, so the canonical-instant rule
 * (M-21) and the finite non-negative rule apply exactly as for migrations.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { TokenBucket } from '@agenthropic/shared';
import { openDatabase, type SqliteDatabase } from './connection';
import { runMigrations } from './migrations';
import { canonicalizeEffectiveFrom, upsertPricingRate } from './pricing';

/** The five buckets, in the order the CLI prints and requires them. */
export const PRICING_BUCKETS: readonly TokenBucket[] = [
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
];

/**
 * A model id as Claude Code writes it (`claude-opus-5-5`,
 * `claude-sonnet-4-5-20250929`, a `[1m]` suffix). Narrow on purpose: a typo
 * with a space or a quote would create a row no transcript ever matches.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/;

/** A plain decimal, so `1e3`, `0x10`, `Infinity` and `''` are typos, not rates. */
const DECIMAL = /^\d+(\.\d+)?$/;

const MAX_NOTE_LENGTH = 500;
const DEFAULT_AUDIT_LIMIT = 50;

export interface SetRatesRequest {
  readonly model: string;
  /** Any spelling `canonicalizeEffectiveFrom` accepts; stored canonical. */
  readonly effectiveFrom: string;
  /** USD per million tokens, per bucket. At least one; all five for a new model. */
  readonly rates: Partial<Record<TokenBucket, number>>;
  readonly note?: string | null;
}

export interface RateChange {
  readonly bucket: TokenBucket;
  readonly usdPerMtok: number;
  /** The rate this write replaced at the same instant, or null for a new row. */
  readonly previousUsdPerMtok: number | null;
}

export interface SetRatesResult {
  readonly model: string;
  /** The canonical stored instant. */
  readonly effectiveFrom: string;
  readonly written: readonly RateChange[];
  /** Buckets given with the rate already stored; nothing written, nothing audited. */
  readonly unchanged: readonly TokenBucket[];
}

function assertModelId(model: string): void {
  if (!MODEL_ID.test(model)) {
    throw new Error(
      `Model id ${JSON.stringify(model)} is not a model id: letters, digits and . _ : @ / [ ] - ` +
        'only, starting with a letter or digit, at most 200 characters.',
    );
  }
}

/**
 * Write dated rates for one model in one transaction, with one
 * `pricing_audit` row per rate that actually changed.
 *
 * A model with no row at all must be given all five rates: a partly priced
 * model would leave whole buckets as unpriced tokens with nothing to say why.
 * Re-sending a stored rate is a no-op, so a repeated command leaves no noise
 * in the trail.
 */
export function setPricingRates(
  db: SqliteDatabase,
  request: SetRatesRequest,
  now: Date = new Date(),
): SetRatesResult {
  const { model } = request;
  assertModelId(model);
  const buckets = PRICING_BUCKETS.filter((bucket) => request.rates[bucket] !== undefined);
  if (buckets.length === 0) {
    throw new Error('No rate given. Pass at least one of the five bucket rates.');
  }
  const note = request.note ?? null;
  if (note !== null && note.length > MAX_NOTE_LENGTH) {
    throw new Error(
      `The note is ${String(note.length)} characters; at most ${String(MAX_NOTE_LENGTH)}.`,
    );
  }
  const effectiveFrom = canonicalizeEffectiveFrom(request.effectiveFrom);
  const recordedAt = now.toISOString();

  const known = db.prepare('SELECT 1 FROM model_pricing WHERE model = ? LIMIT 1');
  const current = db.prepare(
    'SELECT usd_per_mtok FROM model_pricing WHERE model = ? AND bucket = ? AND effective_from = ?',
  );
  const audit = db.prepare(
    `INSERT INTO pricing_audit
       (recorded_at, source, model, bucket, effective_from, usd_per_mtok, previous_usd_per_mtok, note)
     VALUES (?, 'cli', ?, ?, ?, ?, ?, ?)`,
  );

  return db.transaction((): SetRatesResult => {
    if (known.get(model) === undefined) {
      const missing = PRICING_BUCKETS.filter((bucket) => !buckets.includes(bucket));
      if (missing.length > 0) {
        throw new Error(
          `${model} has no rates yet, so all five are required; missing: ${missing.join(', ')}.`,
        );
      }
    }
    const written: RateChange[] = [];
    const unchanged: TokenBucket[] = [];
    for (const bucket of buckets) {
      const usdPerMtok = request.rates[bucket] as number;
      const row = current.get(model, bucket, effectiveFrom) as { usd_per_mtok: number } | undefined;
      const previousUsdPerMtok = row === undefined ? null : row.usd_per_mtok;
      if (previousUsdPerMtok === usdPerMtok) {
        unchanged.push(bucket);
        continue;
      }
      upsertPricingRate(db, { model, bucket, usdPerMtok, effectiveFrom });
      audit.run(recordedAt, model, bucket, effectiveFrom, usdPerMtok, previousUsdPerMtok, note);
      written.push({ bucket, usdPerMtok, previousUsdPerMtok });
    }
    return { model, effectiveFrom, written, unchanged };
  })();
}

export interface PricingTableRow {
  readonly model: string;
  readonly effectiveFrom: string;
  readonly rates: Partial<Record<TokenBucket, number>>;
}

/** The dated rate table, one entry per (model, effective_from). */
export function listPricing(db: SqliteDatabase, model?: string): PricingTableRow[] {
  const rows = db
    .prepare(
      `SELECT model, bucket, usd_per_mtok, effective_from
         FROM model_pricing
        WHERE ? IS NULL OR model = ?
        ORDER BY model, effective_from`,
    )
    .all(model ?? null, model ?? null) as {
    model: string;
    bucket: TokenBucket;
    usd_per_mtok: number;
    effective_from: string;
  }[];
  const table: {
    model: string;
    effectiveFrom: string;
    rates: Partial<Record<TokenBucket, number>>;
  }[] = [];
  for (const row of rows) {
    let last = table.at(-1);
    if (last?.model !== row.model || last.effectiveFrom !== row.effective_from) {
      last = { model: row.model, effectiveFrom: row.effective_from, rates: {} };
      table.push(last);
    }
    last.rates[row.bucket] = row.usd_per_mtok;
  }
  return table;
}

export interface PricingAuditRow {
  readonly id: number;
  readonly recordedAt: string;
  readonly source: string;
  readonly model: string;
  readonly bucket: TokenBucket;
  readonly effectiveFrom: string;
  readonly usdPerMtok: number;
  readonly previousUsdPerMtok: number | null;
  readonly note: string | null;
}

/** The CLI's write history, newest first. */
export function listPricingAudit(
  db: SqliteDatabase,
  options: { readonly model?: string; readonly limit?: number } = {},
): PricingAuditRow[] {
  return db
    .prepare(
      `SELECT id, recorded_at AS recordedAt, source, model, bucket,
              effective_from AS effectiveFrom, usd_per_mtok AS usdPerMtok,
              previous_usd_per_mtok AS previousUsdPerMtok, note
         FROM pricing_audit
        WHERE ? IS NULL OR model = ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(
      options.model ?? null,
      options.model ?? null,
      options.limit ?? DEFAULT_AUDIT_LIMIT,
    ) as PricingAuditRow[];
}

export interface UnpricedModel {
  readonly model: string;
  readonly tokens: Partial<Record<TokenBucket, number>>;
  readonly sessions: number;
  /** Earliest dated day with unpriced tokens; the floor a new rate must reach back to. */
  readonly firstDay: string | null;
  readonly lastDay: string | null;
}

/**
 * Stored tokens that no dated rate covers, per model: a model with no row, or
 * usage older than the model's first `effective_from`. Read from
 * `token_usage_rollup`, where `rate_effective_from = ''` is exactly the priced
 * CTE's NULL rate (migration 16), so this agrees with `unpricedTokens` in the
 * API by construction.
 */
export function findUnpricedUsage(db: SqliteDatabase): UnpricedModel[] {
  const rows = db
    .prepare(
      `SELECT model, bucket, SUM(tokens) AS tokens
         FROM token_usage_rollup
        WHERE rate_effective_from = '' AND tokens > 0
        GROUP BY model, bucket
        ORDER BY model`,
    )
    .all() as { model: string; bucket: TokenBucket; tokens: number }[];
  const spans = db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS sessions,
            MIN(CASE WHEN day <> 'unknown' THEN day END) AS firstDay,
            MAX(CASE WHEN day <> 'unknown' THEN day END) AS lastDay
       FROM token_usage_rollup
      WHERE rate_effective_from = '' AND tokens > 0 AND model = ?`,
  );
  const byModel = new Map<string, Partial<Record<TokenBucket, number>>>();
  for (const row of rows) {
    const tokens = byModel.get(row.model) ?? {};
    tokens[row.bucket] = row.tokens;
    byModel.set(row.model, tokens);
  }
  return [...byModel].map(([model, tokens]) => {
    const span = spans.get(model) as {
      sessions: number;
      firstDay: string | null;
      lastDay: string | null;
    };
    return { model, tokens, ...span };
  });
}

// ---------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------

export const PRICING_USAGE: readonly string[] = [
  'usage: pnpm --filter @agenthropic/server pricing <command>',
  '  list     [--model <id>]                 dated rates, USD per million tokens',
  '  unpriced                                stored tokens no dated rate covers',
  '  audit    [--model <id>] [--limit <n>]   rates written by this command, newest first',
  '  set <model> --effective-from <date> [--input <usd>] [--output <usd>] [--cache-read <usd>]',
  '           [--cache-write-5m <usd>] [--cache-write-1h <usd>] [--note <text>]',
  '           write rates (all five for a model with none); the server must be stopped',
];

type RateFlag = 'input' | 'output' | 'cache-read' | 'cache-write-5m' | 'cache-write-1h';

const RATE_FLAGS: readonly (readonly [RateFlag, TokenBucket])[] = [
  ['input', 'input'],
  ['output', 'output'],
  ['cache-read', 'cache_read'],
  ['cache-write-5m', 'cache_write_5m'],
  ['cache-write-1h', 'cache_write_1h'],
];

export interface PricingCliOptions {
  /** The database the server runs on. Must exist: the command never creates one. */
  readonly dbPath: string;
  /** Resolves true while a dashboard server answers; `set` then refuses. */
  readonly isServerRunning: () => Promise<boolean>;
  readonly now?: Date;
}

function parseRate(flag: string, raw: string): number {
  if (!DECIMAL.test(raw)) {
    throw new Error(`--${flag} ${JSON.stringify(raw)} is not a plain decimal USD rate.`);
  }
  return Number(raw);
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_AUDIT_LIMIT;
  }
  if (!/^[1-9]\d{0,5}$/.test(raw)) {
    throw new Error(`--limit ${JSON.stringify(raw)} is not a whole number from 1 to 999999.`);
  }
  return Number(raw);
}

function rateCells(rates: Partial<Record<TokenBucket, number>>): string {
  return PRICING_BUCKETS.map((bucket) => `${bucket}=${String(rates[bucket] ?? '-')}`).join(' ');
}

function withDatabase<T>(dbPath: string, use: (db: SqliteDatabase) => T): T {
  if (!existsSync(dbPath)) {
    throw new Error(
      `No database at ${dbPath}. Point DASHBOARD_DB_PATH at the database the server runs on.`,
    );
  }
  const db = openDatabase(dbPath);
  try {
    // Same as a server boot: a database the new code has not opened yet gains
    // pricing_audit here. A current schema applies nothing.
    runMigrations(db);
    return use(db);
  } finally {
    db.close();
  }
}

/**
 * Run one CLI command and return the lines to print. Throws an Error whose
 * message is the whole user-facing complaint on any refusal or bad input.
 */
export async function runPricingCli(
  argv: readonly string[],
  options: PricingCliOptions,
): Promise<string[]> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      return [...PRICING_USAGE];
    case 'list': {
      const { values } = parseArgs({
        args: rest,
        options: { model: { type: 'string' } },
        strict: true,
      });
      const table = withDatabase(options.dbPath, (db) => listPricing(db, values.model));
      if (table.length === 0) {
        return ['no rates'];
      }
      return table.map((row) => `${row.model}  from ${row.effectiveFrom}  ${rateCells(row.rates)}`);
    }
    case 'unpriced': {
      parseArgs({ args: rest, options: {}, strict: true });
      const models = withDatabase(options.dbPath, findUnpricedUsage);
      if (models.length === 0) {
        return ['every stored token has a dated rate'];
      }
      return models.map(
        (row) =>
          `${row.model}  ${String(row.sessions)} session(s)  days ${row.firstDay ?? 'unknown'}..` +
          `${row.lastDay ?? 'unknown'}  tokens ${rateCells(row.tokens)}`,
      );
    }
    case 'audit': {
      const { values } = parseArgs({
        args: rest,
        options: { model: { type: 'string' }, limit: { type: 'string' } },
        strict: true,
      });
      const limit = parseLimit(values.limit);
      const rows = withDatabase(options.dbPath, (db) =>
        listPricingAudit(db, { model: values.model, limit }),
      );
      if (rows.length === 0) {
        return ['no audit rows'];
      }
      return rows.map(
        (row) =>
          `#${String(row.id)} ${row.recordedAt} ${row.source}  ${row.model} ${row.bucket} ` +
          `from ${row.effectiveFrom}: ${String(row.previousUsdPerMtok ?? '(new)')} -> ` +
          `${String(row.usdPerMtok)}${row.note === null ? '' : `  "${row.note}"`}`,
      );
    }
    case 'set': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          'effective-from': { type: 'string' },
          note: { type: 'string' },
          input: { type: 'string' },
          output: { type: 'string' },
          'cache-read': { type: 'string' },
          'cache-write-5m': { type: 'string' },
          'cache-write-1h': { type: 'string' },
        },
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length !== 1) {
        throw new Error('set takes exactly one model id.');
      }
      const effectiveFrom = values['effective-from'];
      if (effectiveFrom === undefined) {
        throw new Error('set needs --effective-from <date>: a rate is always dated.');
      }
      const rates: Partial<Record<TokenBucket, number>> = {};
      for (const [flag, bucket] of RATE_FLAGS) {
        const raw = values[flag];
        if (raw !== undefined) {
          rates[bucket] = parseRate(flag, raw);
        }
      }
      if (await options.isServerRunning()) {
        throw new Error(
          'A dashboard server is answering on the configured port. Stop it first: a rate ' +
            'change rebuilds the cost rollup and would hold the write lock past the ' +
            "server's busy timeout.",
        );
      }
      const result = withDatabase(options.dbPath, (db) =>
        setPricingRates(
          db,
          { model: positionals[0] as string, effectiveFrom, rates, note: values.note ?? null },
          options.now,
        ),
      );
      const lines = result.written.map(
        (change) =>
          `${change.bucket}: ${String(change.previousUsdPerMtok ?? '(new)')} -> ` +
          String(change.usdPerMtok),
      );
      if (result.unchanged.length > 0) {
        lines.push(`unchanged: ${result.unchanged.join(', ')}`);
      }
      lines.push(
        `pricing OK: ${result.model} from ${result.effectiveFrom}, ` +
          `${String(result.written.length)} rate(s) written`,
      );
      return lines;
    }
    default:
      throw new Error([`Unknown command ${JSON.stringify(command)}.`, ...PRICING_USAGE].join('\n'));
  }
}
