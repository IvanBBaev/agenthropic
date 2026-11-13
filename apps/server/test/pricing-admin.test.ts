/**
 * R15 / DAT-4 operator pricing path (src/db/pricing-admin.ts): dated rates
 * written outside a migration, one append-only audit row per changed rate,
 * a refusal while a server runs, and the read-only list / unpriced / audit
 * reports.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { loadPricing } from '../src/db/pricing';
import {
  findUnpricedUsage,
  listPricing,
  listPricingAudit,
  PRICING_USAGE,
  runPricingCli,
  setPricingRates,
} from '../src/db/pricing-admin';
import { createMigratedTempDb, type TempDb } from './helpers';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const ALL_FIVE = { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 };
const notRunning = (): Promise<boolean> => Promise.resolve(false);

let temp: TempDb | undefined;
let dir: string | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function migrated(): SqliteDatabase {
  temp = createMigratedTempDb();
  return temp.db;
}

function insertUsage(
  db: SqliteDatabase,
  row: {
    model: string;
    bucket: string;
    tokens: number;
    occurredAt: string | null;
    session?: string;
  },
): void {
  const id = `msg-${String(Math.random()).slice(2)}`;
  db.prepare(
    `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?)`,
  ).run(row.session ?? 's-1', id, row.model, row.bucket, row.tokens, row.occurredAt);
}

/** A database file on disk for the CLI, closed so the CLI opens it itself. */
function databaseFile(): string {
  dir = mkdtempSync(join(tmpdir(), 'agenthropic-pricing-cli-'));
  const dbPath = join(dir, 'agenthropic.db');
  const db = openDatabase(dbPath);
  runMigrations(db);
  db.close();
  return dbPath;
}

function auditCount(db: SqliteDatabase): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM pricing_audit').get() as { n: number }).n;
}

describe('setPricingRates', () => {
  it('prices a new model with all five rates and audits each one', () => {
    const db = migrated();
    const result = setPricingRates(
      db,
      {
        model: 'claude-fable-5-2',
        effectiveFrom: '2026-01-01',
        rates: ALL_FIVE,
        note: 'pricing page 2026-11-14',
      },
      NOW,
    );
    expect(result.effectiveFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(result.written).toHaveLength(5);
    expect(result.unchanged).toEqual([]);
    expect(result.written.every((change) => change.previousUsdPerMtok === null)).toBe(true);
    const priced = loadPricing(db).filter((entry) => entry.model === 'claude-fable-5-2');
    expect(priced).toHaveLength(5);
    const audit = listPricingAudit(db);
    expect(audit).toHaveLength(5);
    expect(audit[0]).toMatchObject({
      recordedAt: '2026-11-14T10:00:00.000Z',
      source: 'cli',
      model: 'claude-fable-5-2',
      bucket: 'cache_write_1h',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      usdPerMtok: 6,
      previousUsdPerMtok: null,
      note: 'pricing page 2026-11-14',
    });
  });

  it('refuses a partial rate set for a model with no rates, writing nothing', () => {
    const db = migrated();
    expect(() =>
      setPricingRates(db, {
        model: 'claude-new-1',
        effectiveFrom: '2026-01-01',
        rates: { input: 1 },
      }),
    ).toThrow(/all five are required; missing: output, cache_read, cache_write_5m, cache_write_1h/);
    expect(listPricing(db, 'claude-new-1')).toEqual([]);
    expect(auditCount(db)).toBe(0);
  });

  it('corrects one stored rate in place and records what it replaced', () => {
    const db = migrated();
    const before = listPricing(db, 'claude-sonnet-5-5');
    expect(before).toHaveLength(1);
    const seedInstant = before[0]?.effectiveFrom as string;
    const result = setPricingRates(db, {
      model: 'claude-sonnet-5-5',
      effectiveFrom: seedInstant,
      rates: { output: 12 },
    });
    expect(result.written).toEqual([{ bucket: 'output', usdPerMtok: 12, previousUsdPerMtok: 10 }]);
    expect(listPricing(db, 'claude-sonnet-5-5')[0]?.rates.output).toBe(12);
    expect(listPricingAudit(db)[0]).toMatchObject({ previousUsdPerMtok: 10, note: null });
  });

  it('adds a later dated rate for a priced model without touching the earlier one', () => {
    const db = migrated();
    setPricingRates(db, {
      model: 'claude-sonnet-5-5',
      effectiveFrom: '2026-12-01T00:00:00+02:00',
      rates: { input: 1.5 },
    });
    const table = listPricing(db, 'claude-sonnet-5-5');
    expect(table.map((row) => row.effectiveFrom)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-11-30T22:00:00.000Z',
    ]);
    expect(table[0]?.rates.input).toBe(2);
    expect(table[1]?.rates).toEqual({ input: 1.5 });
  });

  it('treats a re-sent stored rate as a no-op: nothing written, nothing audited', () => {
    const db = migrated();
    const result = setPricingRates(db, {
      model: 'claude-sonnet-5-5',
      effectiveFrom: '2026-01-01',
      rates: { input: 2, output: 11 },
    });
    expect(result.unchanged).toEqual(['input']);
    expect(result.written.map((change) => change.bucket)).toEqual(['output']);
    expect(auditCount(db)).toBe(1);
  });

  it('rolls the whole write back when one rate is unusable', () => {
    const db = migrated();
    expect(() =>
      setPricingRates(db, {
        model: 'claude-fable-5-2',
        effectiveFrom: '2026-01-01',
        rates: { ...ALL_FIVE, cache_write_1h: Number.NaN },
      }),
    ).toThrow(/not a finite, non-negative number/);
    expect(listPricing(db, 'claude-fable-5-2')).toEqual([]);
    expect(auditCount(db)).toBe(0);
  });

  it.each([
    [
      'an empty model id',
      { model: '', effectiveFrom: '2026-01-01', rates: { input: 1 } },
      /is not a model id/,
    ],
    [
      'a model id with a space',
      { model: 'claude opus', effectiveFrom: '2026-01-01', rates: { input: 1 } },
      /is not a model id/,
    ],
    [
      'no rate at all',
      { model: 'claude-sonnet-5-5', effectiveFrom: '2026-01-01', rates: {} },
      /No rate given/,
    ],
    [
      'a zone-less date-time',
      { model: 'claude-sonnet-5-5', effectiveFrom: '2026-01-01T00:00:00', rates: { input: 1 } },
      /not an unambiguous instant/,
    ],
    [
      'an over-long note',
      {
        model: 'claude-sonnet-5-5',
        effectiveFrom: '2026-01-01',
        rates: { input: 1 },
        note: 'x'.repeat(501),
      },
      /at most 500/,
    ],
  ])('refuses %s', (_label, request, message) => {
    const db = migrated();
    expect(() => setPricingRates(db, request)).toThrow(message);
    expect(auditCount(db)).toBe(0);
  });

  it('accepts a [1m]-suffixed model id', () => {
    const db = migrated();
    const result = setPricingRates(db, {
      model: 'claude-opus-4-6[1m]',
      effectiveFrom: '2026-01-01',
      rates: ALL_FIVE,
    });
    expect(result.written).toHaveLength(5);
  });
});

describe('pricing_audit is append-only', () => {
  it('refuses UPDATE and DELETE', () => {
    const db = migrated();
    setPricingRates(db, {
      model: 'claude-fable-5-2',
      effectiveFrom: '2026-01-01',
      rates: ALL_FIVE,
    });
    expect(() => db.prepare("UPDATE pricing_audit SET note = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM pricing_audit').run()).toThrow(/append-only/);
    expect(auditCount(db)).toBe(5);
  });

  it('refuses an unknown bucket and an unknown source', () => {
    const db = migrated();
    const insert = db.prepare(
      `INSERT INTO pricing_audit (recorded_at, source, model, bucket, effective_from, usd_per_mtok)
       VALUES ('2026-11-14T00:00:00.000Z', ?, 'm', ?, '2026-01-01T00:00:00.000Z', 1)`,
    );
    expect(() => insert.run('cli', 'cache_write')).toThrow(/CHECK constraint/);
    expect(() => insert.run('api', 'input')).toThrow(/CHECK constraint/);
  });
});

describe('listPricingAudit', () => {
  it('filters by model and honours the limit, newest first', () => {
    const db = migrated();
    setPricingRates(db, {
      model: 'claude-fable-5-2',
      effectiveFrom: '2026-01-01',
      rates: ALL_FIVE,
    });
    setPricingRates(db, {
      model: 'claude-sonnet-5-5',
      effectiveFrom: '2026-01-01',
      rates: { input: 2.5 },
    });
    expect(listPricingAudit(db, { model: 'claude-sonnet-5-5' }).map((row) => row.bucket)).toEqual([
      'input',
    ]);
    const lastTwo = listPricingAudit(db, { limit: 2 });
    expect(lastTwo.map((row) => row.model)).toEqual(['claude-sonnet-5-5', 'claude-fable-5-2']);
    expect(lastTwo[0]?.id).toBeGreaterThan(lastTwo[1]?.id as number);
  });
});

describe('findUnpricedUsage', () => {
  it('reports a model with no rate, its sessions and its dated span', () => {
    const db = migrated();
    insertUsage(db, {
      model: 'claude-fable-5-2',
      bucket: 'input',
      tokens: 100,
      occurredAt: '2026-11-02T09:00:00.000Z',
    });
    insertUsage(db, {
      model: 'claude-fable-5-2',
      bucket: 'output',
      tokens: 40,
      occurredAt: '2026-11-10T09:00:00.000Z',
      session: 's-2',
    });
    insertUsage(db, {
      model: 'claude-fable-5-2',
      bucket: 'input',
      tokens: 7,
      occurredAt: null,
      session: 's-3',
    });
    insertUsage(db, {
      model: 'claude-sonnet-5-5',
      bucket: 'input',
      tokens: 500,
      occurredAt: '2026-11-02T09:00:00.000Z',
    });
    expect(findUnpricedUsage(db)).toEqual([
      {
        model: 'claude-fable-5-2',
        tokens: { input: 107, output: 40 },
        sessions: 3,
        firstDay: '2026-11-02',
        lastDay: '2026-11-10',
      },
    ]);
  });

  it('clears once a rate reaching back far enough is set', () => {
    const db = migrated();
    insertUsage(db, {
      model: 'claude-fable-5-2',
      bucket: 'input',
      tokens: 100,
      occurredAt: '2026-11-02T09:00:00.000Z',
    });
    setPricingRates(db, {
      model: 'claude-fable-5-2',
      effectiveFrom: '2026-11-05',
      rates: ALL_FIVE,
    });
    // Usage older than the first effective_from stays unpriced, and says so.
    expect(findUnpricedUsage(db).map((row) => row.firstDay)).toEqual(['2026-11-02']);
    setPricingRates(db, {
      model: 'claude-fable-5-2',
      effectiveFrom: '2026-11-01',
      rates: ALL_FIVE,
    });
    expect(findUnpricedUsage(db)).toEqual([]);
  });

  it('reports a span of unknown when no unpriced token is dated', () => {
    const db = migrated();
    insertUsage(db, { model: 'claude-fable-5-2', bucket: 'input', tokens: 5, occurredAt: null });
    expect(findUnpricedUsage(db)[0]).toMatchObject({ firstDay: null, lastDay: null, sessions: 1 });
  });
});

describe('runPricingCli', () => {
  it('prints the usage for no command and for help', async () => {
    const options = { dbPath: '/nonexistent', isServerRunning: notRunning };
    expect(await runPricingCli([], options)).toEqual([...PRICING_USAGE]);
    expect(await runPricingCli(['help'], options)).toEqual([...PRICING_USAGE]);
    expect(await runPricingCli(['--help'], options)).toEqual([...PRICING_USAGE]);
  });

  it('refuses an unknown command with the usage', async () => {
    await expect(
      runPricingCli(['drop'], { dbPath: '/nonexistent', isServerRunning: notRunning }),
    ).rejects.toThrow(/Unknown command "drop"\.\nusage:/);
  });

  it('refuses a missing database and never creates one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-pricing-cli-'));
    const dbPath = join(dir, 'missing.db');
    await expect(runPricingCli(['list'], { dbPath, isServerRunning: notRunning })).rejects.toThrow(
      /No database at/,
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  it('lists rates, filtered by model, and says so when none match', async () => {
    const dbPath = databaseFile();
    const options = { dbPath, isServerRunning: notRunning };
    const all = await runPricingCli(['list'], options);
    expect(all.length).toBeGreaterThan(5);
    expect(await runPricingCli(['list', '--model', 'claude-sonnet-5-5'], options)).toEqual([
      'claude-sonnet-5-5  from 2026-01-01T00:00:00.000Z  input=2 output=10 cache_read=0.1 cache_write_5m=2.5 cache_write_1h=4',
    ]);
    expect(await runPricingCli(['list', '--model', 'nope'], options)).toEqual(['no rates']);
    await expect(runPricingCli(['list', '--bogus'], options)).rejects.toThrow(/Unknown option/);
  });

  it('sets rates, then reports them in the audit, while no server runs', async () => {
    const dbPath = databaseFile();
    const options = { dbPath, isServerRunning: notRunning, now: NOW };
    expect(await runPricingCli(['audit'], options)).toEqual(['no audit rows']);
    const lines = await runPricingCli(
      [
        'set',
        'claude-fable-5-2',
        '--effective-from',
        '2026-01-01',
        '--input',
        '3',
        '--output',
        '15',
        '--cache-read',
        '0.3',
        '--cache-write-5m',
        '3.75',
        '--cache-write-1h',
        '6',
        '--note',
        'pricing page',
      ],
      options,
    );
    expect(lines).toEqual([
      'input: (new) -> 3',
      'output: (new) -> 15',
      'cache_read: (new) -> 0.3',
      'cache_write_5m: (new) -> 3.75',
      'cache_write_1h: (new) -> 6',
      'pricing OK: claude-fable-5-2 from 2026-01-01T00:00:00.000Z, 5 rate(s) written',
    ]);
    const again = await runPricingCli(
      [
        'set',
        'claude-fable-5-2',
        '--effective-from',
        '2026-01-01',
        '--input',
        '3',
        '--output',
        '16',
      ],
      options,
    );
    expect(again).toEqual([
      'output: 15 -> 16',
      'unchanged: input',
      'pricing OK: claude-fable-5-2 from 2026-01-01T00:00:00.000Z, 1 rate(s) written',
    ]);
    const audit = await runPricingCli(
      ['audit', '--model', 'claude-fable-5-2', '--limit', '2'],
      options,
    );
    expect(audit).toEqual([
      '#6 2026-11-14T10:00:00.000Z cli  claude-fable-5-2 output from 2026-01-01T00:00:00.000Z: 15 -> 16',
      '#5 2026-11-14T10:00:00.000Z cli  claude-fable-5-2 cache_write_1h from 2026-01-01T00:00:00.000Z: (new) -> 6  "pricing page"',
    ]);
  });

  it.each([
    [['set', '--effective-from', '2026-01-01', '--input', '1'], /exactly one model id/],
    [['set', 'a', 'b', '--effective-from', '2026-01-01', '--input', '1'], /exactly one model id/],
    [['set', 'claude-sonnet-5-5', '--input', '1'], /needs --effective-from/],
    [
      ['set', 'claude-sonnet-5-5', '--effective-from', '2026-01-01', '--input', '1e3'],
      /--input "1e3" is not a plain decimal/,
    ],
    [
      ['set', 'claude-sonnet-5-5', '--effective-from', '2026-01-01', '--cache-read=-1'],
      /--cache-read "-1" is not a plain decimal/,
    ],
    [['audit', '--limit', '0'], /--limit "0" is not a whole number/],
    [['unpriced', 'extra'], /Unexpected argument/],
  ])('refuses bad arguments: %j', async (argv, message) => {
    const dbPath = databaseFile();
    await expect(runPricingCli(argv, { dbPath, isServerRunning: notRunning })).rejects.toThrow(
      message,
    );
  });

  it('refuses set while a server answers, and writes nothing', async () => {
    const dbPath = databaseFile();
    await expect(
      runPricingCli(
        ['set', 'claude-sonnet-5-5', '--effective-from', '2026-01-01', '--input', '9'],
        {
          dbPath,
          isServerRunning: () => Promise.resolve(true),
        },
      ),
    ).rejects.toThrow(/Stop it first/);
    expect(
      await runPricingCli(['audit'], { dbPath, isServerRunning: () => Promise.resolve(true) }),
    ).toEqual(['no audit rows']);
  });

  it('reports unpriced usage, and the all-clear', async () => {
    const dbPath = databaseFile();
    const options = { dbPath, isServerRunning: notRunning };
    expect(await runPricingCli(['unpriced'], options)).toEqual([
      'every stored token has a dated rate',
    ]);
    const db = openDatabase(dbPath);
    insertUsage(db, {
      model: 'claude-fable-5-2',
      bucket: 'output',
      tokens: 9,
      occurredAt: '2026-11-03T00:00:00.000Z',
    });
    insertUsage(db, { model: 'claude-fable-5-3', bucket: 'output', tokens: 4, occurredAt: null });
    db.close();
    expect(await runPricingCli(['unpriced'], options)).toEqual([
      'claude-fable-5-2  1 session(s)  days 2026-11-03..2026-11-03  tokens input=- output=9 cache_read=- cache_write_5m=- cache_write_1h=-',
      'claude-fable-5-3  1 session(s)  days unknown..unknown  tokens input=- output=4 cache_read=- cache_write_5m=- cache_write_1h=-',
    ]);
  });
});
