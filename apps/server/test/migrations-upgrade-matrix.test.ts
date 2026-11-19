/**
 * QA-10 — historical-database upgrade matrix.
 *
 * The per-migration tests in migrations.test.ts prove each data-carrying
 * migration on the rows it targets, and the generic upgrade test goes from an
 * EMPTY old schema to head. Neither proves the claim an operator relies on:
 * "a database written by any earlier build, holding real rows, upgrades to a
 * database indistinguishable from one the current build wrote". This file does,
 * for EVERY schema prefix a database can be at on disk (1..head-1; 16 is the
 * 0.3.0 release).
 *
 * For each prefix N the test builds two databases from the same logical seed:
 *
 *  - HISTORICAL: migrations 1..N, then the seed written the way a build at
 *    schema N wrote it (bare-date pricing floors and non-canonical usage
 *    timestamps before migrations 14/15, NULL main-agent attribution before
 *    migration 8), then upgraded to head by `runMigrations`.
 *  - FRESH: all migrations, then the same logical seed written the way the
 *    current build writes it, restricted to the tables and columns that
 *    existed at N, so both databases hold the same facts.
 *
 * It then asserts that the two agree on the schema, on every row of every data
 * table, on Σ tokens per bucket (against the seed itself, an independent
 * oracle), and on the cost summary the dashboard serves, whose Σ $ must also
 * equal the dollars priced straight from the ledger.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCostSummary, pricedCte } from '../src/api/queries';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { currentSchemaVersion, migrations, runMigrations } from '../src/db/migrations';

const HEAD = migrations[migrations.length - 1]!.id;
const RELEASE_0_3_0_SCHEMA = 16;

/** Tables whose content is bookkeeping, not data: compared through other means or not at all. */
const BOOKKEEPING = new Set(['schema_version', 'sqlite_sequence', 'ingest_clock']);

/**
 * Columns stamped from a write-order clock (migration 22). The historical
 * database gets them from the backfill, the fresh one from its triggers, so
 * they legitimately differ; their own migration test pins the backfill.
 */
const CLOCK_COLUMNS: Record<string, readonly string[]> = { sessions: ['ingest_seq'] };

type Row = Record<string, unknown>;

/** How the seed is spelled: as a build at the historical schema wrote it, or as head writes it. */
interface Writer {
  /** Schema the seed is written against (decides spellings and attribution). */
  readonly schema: number;
  /** Tables (and their columns) that exist at the historical prefix. */
  readonly shape: Map<string, Set<string>>;
}

/** Usage seed: one logical message per entry, expanded to bucket rows. */
interface UsageSeed {
  readonly session: string;
  /** `null` = a usage row whose agent could not be attributed (no main agent recorded). */
  readonly agent: string | null;
  /** Written as NULL by builds before migration 8, which then backfills it. */
  readonly legacyNullAgent?: boolean;
  readonly messageId: string;
  readonly model: string;
  /** Canonical instant, or null for a record that carried no timestamp. */
  readonly at: string | null;
  /** How a build before migration 15 spelled `at` (default: canonical). */
  readonly historicalAt?: string;
  readonly baseline?: boolean;
  readonly tokens: Partial<Record<Bucket, number>>;
}

type Bucket = 'input' | 'output' | 'cache_read' | 'cache_write_5m' | 'cache_write_1h';
const BUCKETS: readonly Bucket[] = [
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
];

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

const USAGE: readonly UsageSeed[] = [
  {
    session: S1,
    agent: S1,
    messageId: 'msg_opus_1',
    model: 'claude-opus-4-8',
    at: '2026-09-01T10:00:00.000Z',
    historicalAt: '2026-09-01T10:00:00Z',
    tokens: { input: 1200, output: 340, cache_read: 50_000, cache_write_5m: 2000 },
  },
  {
    // The operator's 2026-10-01 rate (seeded below) applies to this one.
    session: S1,
    agent: 'agent-sub-1',
    messageId: 'msg_opus_2',
    model: 'claude-opus-4-8',
    at: '2026-10-05T07:30:00.000Z',
    historicalAt: '2026-10-05T09:30:00+02:00',
    tokens: { input: 800, output: 120, cache_write_1h: 9000 },
  },
  {
    session: S1,
    agent: S1,
    legacyNullAgent: true,
    messageId: 'msg_sonnet_1',
    model: 'claude-sonnet-5',
    at: '2026-09-02T23:59:59.999Z',
    historicalAt: '2026-09-03T00:59:59.999+01:00',
    tokens: { input: 5000, output: 2500, cache_read: 100_000 },
  },
  {
    // Compaction baseline: stored, never double counted by the readers.
    session: S1,
    agent: 'agent-sub-2',
    messageId: 'msg_sonnet_2',
    model: 'claude-sonnet-5',
    at: '2026-09-03T00:00:00.000Z',
    historicalAt: '2026-09-02T19:00:00-05:00',
    baseline: true,
    tokens: { input: 42, output: 7 },
  },
  {
    // A model a later migration started pricing: unpriced on the historical
    // database until the upgrade, priced on both afterwards.
    session: S2,
    agent: S2,
    messageId: 'msg_opus55_1',
    model: 'claude-opus-5-5',
    at: '2026-11-10T12:00:00.000Z',
    tokens: { input: 3000, output: 900, cache_read: 7000, cache_write_5m: 400 },
  },
  {
    // Never priced by any migration: must surface as unpriced, not as $0 cost.
    session: S2,
    agent: S2,
    messageId: 'msg_unknown_1',
    model: 'claude-never-priced',
    at: '2026-11-11T08:00:00.000Z',
    tokens: { input: 10, output: 20 },
  },
  {
    // No timestamp: no rate can be resolved for it.
    session: S3,
    agent: null,
    messageId: 'msg_untimed_1',
    model: 'claude-opus-4-8',
    at: null,
    tokens: { input: 99, output: 1 },
  },
];

/** The operator's own pricing row, typed before migration 14 as a bare date. */
const OPERATOR_RATE = {
  model: 'claude-opus-4-8',
  bucket: 'input',
  usd_per_mtok: 6,
  canonical: '2026-10-01T00:00:00.000Z',
  historical: '2026-10-01',
};

function logicalRows(w: Writer): Array<[table: string, row: Row]> {
  const historical = w.schema < HEAD;
  const rows: Array<[string, Row]> = [
    [
      'events_raw',
      {
        id: 1,
        idempotency_key: 'k1',
        source: 'jsonl',
        event_type: 'assistant',
        payload: '{}',
        received_at: '2026-09-01T10:00:01.000Z',
      },
    ],
    [
      'events_raw',
      {
        id: 2,
        idempotency_key: 'k2',
        source: 'hook',
        event_type: 'SubagentStart',
        payload: '{"a":1}',
        received_at: '2026-09-01T10:00:02.000Z',
      },
    ],
    [
      'events_raw',
      {
        id: 3,
        idempotency_key: 'k3',
        source: 'hook',
        event_type: 'SubagentStop',
        payload: '{"a":2}',
        received_at: '2026-09-01T10:05:00.000Z',
      },
    ],
    [
      'sessions',
      {
        id: S1,
        project_slug: 'proj-a',
        started_at: '2026-09-01T09:59:00.000Z',
        last_activity_at: '2026-10-05T07:30:00.000Z',
        status: 'completed',
        partial_reason: 'main-transcript-oversize',
        partial_skipped_bytes: 4096,
        usage_records_dropped: 2,
        claude_code_versions: '["2.1.0"]',
        format_census: '{"malformedLines":3}',
      },
    ],
    [
      'sessions',
      {
        id: S2,
        project_slug: 'proj-b',
        started_at: '2026-11-10T11:59:00.000Z',
        last_activity_at: '2026-11-11T08:00:00.000Z',
        status: 'working',
        usage_records_dropped: 0,
      },
    ],
    [
      'sessions',
      {
        id: S3,
        project_slug: 'proj-a',
        started_at: null,
        last_activity_at: null,
        status: null,
        usage_records_dropped: 0,
      },
    ],
    [
      'events',
      {
        id: 1,
        raw_event_id: 1,
        session_id: S1,
        agent_id: S1,
        event_type: 'assistant',
        occurred_at: '2026-09-01T10:00:00.000Z',
      },
    ],
    [
      'events',
      {
        id: 2,
        raw_event_id: 2,
        session_id: S1,
        agent_id: 'agent-sub-1',
        event_type: 'SubagentStart',
        occurred_at: '2026-09-01T10:00:02.000Z',
      },
    ],
    [
      'events',
      {
        id: 3,
        raw_event_id: 3,
        session_id: S1,
        agent_id: 'agent-sub-1',
        event_type: 'SubagentStop',
        occurred_at: '2026-09-01T10:05:00.000Z',
      },
    ],
    [
      'agents',
      {
        id: S1,
        session_id: S1,
        type: 'main',
        subagent_type: null,
        status: 'completed',
        parent_agent_id: null,
        first_seen_at: '2026-09-01T09:59:00.000Z',
        last_seen_at: '2026-10-05T07:30:00.000Z',
      },
    ],
    [
      'agents',
      {
        id: 'agent-sub-1',
        session_id: S1,
        type: 'subagent',
        subagent_type: 'Explore',
        status: 'completed',
        parent_agent_id: S1,
        first_seen_at: '2026-09-01T10:00:02.000Z',
        last_seen_at: '2026-09-01T10:05:00.000Z',
      },
    ],
    [
      'agents',
      {
        id: 'agent-sub-2',
        session_id: S1,
        type: 'subagent',
        subagent_type: 'general-purpose',
        status: 'error',
        parent_agent_id: 'agent-sub-1',
        first_seen_at: '2026-09-02T00:00:00.000Z',
        last_seen_at: '2026-09-03T00:00:00.000Z',
        outcome_cause: 'concurrency_limit',
      },
    ],
    [
      'agents',
      {
        id: S2,
        session_id: S2,
        type: 'main',
        subagent_type: null,
        status: 'working',
        parent_agent_id: null,
        first_seen_at: '2026-11-10T11:59:00.000Z',
        last_seen_at: null,
      },
    ],
    [
      'orchestration_edges',
      {
        id: 1,
        session_id: S1,
        parent_agent_id: S1,
        child_agent_id: 'agent-sub-1',
        source: 'tool_use',
        instance: 'default',
        host_id: 'host-1',
        created_at: '2026-09-01T10:00:02.000Z',
      },
    ],
    [
      'orchestration_edges',
      {
        id: 2,
        session_id: S1,
        parent_agent_id: 'agent-sub-1',
        child_agent_id: 'agent-sub-2',
        source: 'directory',
        instance: 'default',
        host_id: 'host-1',
        created_at: null,
      },
    ],
    [
      'ingest_checkpoints',
      {
        scope: 'session',
        session_id: S1,
        fingerprint: 'fp-1',
        ingest_revision: 3,
        recorded_at: '2026-10-05T07:31:00.000Z',
      },
    ],
    [
      'pricing_audit',
      {
        id: 1,
        recorded_at: '2026-10-01T08:00:00.000Z',
        source: 'cli',
        model: OPERATOR_RATE.model,
        bucket: OPERATOR_RATE.bucket,
        effective_from: OPERATOR_RATE.canonical,
        usd_per_mtok: OPERATOR_RATE.usd_per_mtok,
        previous_usd_per_mtok: 5,
        note: 'operator rate',
      },
    ],
  ];
  rows.push([
    'model_pricing',
    {
      model: OPERATOR_RATE.model,
      bucket: OPERATOR_RATE.bucket,
      usd_per_mtok: OPERATOR_RATE.usd_per_mtok,
      effective_from:
        historical && w.schema < 14 ? OPERATOR_RATE.historical : OPERATOR_RATE.canonical,
    },
  ]);
  let usageId = 0;
  for (const u of USAGE) {
    for (const bucket of BUCKETS) {
      const tokens = u.tokens[bucket];
      if (tokens === undefined) {
        continue;
      }
      usageId += 1;
      rows.push([
        'token_usage',
        {
          id: usageId,
          session_id: u.session,
          agent_id: historical && w.schema < 8 && u.legacyNullAgent === true ? null : u.agent,
          message_id: u.messageId,
          model: u.model,
          bucket,
          tokens,
          is_compaction_baseline: u.baseline === true ? 1 : 0,
          occurred_at: historical && w.schema < 15 ? (u.historicalAt ?? u.at) : u.at,
        },
      ]);
    }
  }
  return rows;
}

/** Write the seed, keeping only the tables and columns that exist at the historical prefix. */
function seed(db: SqliteDatabase, w: Writer): void {
  db.transaction(() => {
    for (const [table, row] of logicalRows(w)) {
      const columns = w.shape.get(table);
      if (columns === undefined) {
        continue;
      }
      const keys = Object.keys(row).filter((k) => columns.has(k));
      db.prepare(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      ).run(...keys.map((k) => row[k]));
    }
  })();
}

function shapeOf(db: SqliteDatabase): Map<string, Set<string>> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .pluck()
    .all() as string[];
  return new Map(
    tables.map((t) => [
      t,
      new Set(db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(t) as string[]),
    ]),
  );
}

function dumpSchema(db: SqliteDatabase): unknown[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();
}

/** Every data table's rows, minus clock-stamped columns, in a total order. */
function dumpData(db: SqliteDatabase): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const [table, columns] of shapeOf(db)) {
    if (BOOKKEEPING.has(table)) {
      continue;
    }
    const kept = [...columns].filter((c) => !(CLOCK_COLUMNS[table] ?? []).includes(c));
    out[table] = db
      .prepare(`SELECT ${kept.join(', ')} FROM ${table} ORDER BY ${kept.join(', ')}`)
      .all() as Row[];
  }
  return out;
}

function tokensPerBucket(db: SqliteDatabase): Record<string, number> {
  const rows = db
    .prepare('SELECT bucket, SUM(tokens) AS tokens FROM token_usage GROUP BY bucket')
    .all() as Array<{ bucket: string; tokens: number }>;
  return Object.fromEntries(rows.map((r) => [r.bucket, r.tokens]));
}

/** Σ $ priced straight from the ledger, bypassing the rollup the summary reads. */
function ledgerUsd(db: SqliteDatabase): number {
  const row = db
    .prepare(
      `WITH ${pricedCte()}
       SELECT SUM(CASE WHEN rate IS NOT NULL THEN tokens * rate / 1000000.0 ELSE 0 END) AS usd
       FROM priced`,
    )
    .get() as { usd: number | null };
  return row.usd ?? 0;
}

const EXPECTED_TOKENS: Record<string, number> = (() => {
  const sums: Record<string, number> = {};
  for (const u of USAGE) {
    for (const bucket of BUCKETS) {
      const tokens = u.tokens[bucket];
      if (tokens !== undefined) {
        sums[bucket] = (sums[bucket] ?? 0) + tokens;
      }
    }
  }
  return sums;
})();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb(name: string): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), `agenthropic-qa10-${name}-`));
  dirs.push(dir);
  return openDatabase(join(dir, 'test.db'));
}

const PREFIXES = migrations.map((m) => m.id).filter((id) => id < HEAD);

describe('historical-database upgrade matrix (QA-10)', () => {
  it('covers every on-disk schema from 1 to head-1, including the 0.3.0 release', () => {
    expect(PREFIXES).toEqual(Array.from({ length: HEAD - 1 }, (_, i) => i + 1));
    expect(PREFIXES).toContain(RELEASE_0_3_0_SCHEMA);
  });

  it.each(PREFIXES)(
    'a schema-%i database with data upgrades to the same database head writes',
    (prefix) => {
      const historical = tempDb(`hist-${String(prefix)}`);
      const fresh = tempDb(`fresh-${String(prefix)}`);
      try {
        runMigrations(
          historical,
          migrations.filter((m) => m.id <= prefix),
        );
        const shape = shapeOf(historical);
        seed(historical, { schema: prefix, shape });

        const upgraded = runMigrations(historical);
        expect(upgraded.appliedIds).toEqual(
          migrations.filter((m) => m.id > prefix).map((m) => m.id),
        );
        expect(currentSchemaVersion(historical)).toBe(HEAD);

        runMigrations(fresh);
        seed(fresh, { schema: HEAD, shape });

        expect(dumpSchema(historical)).toEqual(dumpSchema(fresh));
        expect(dumpData(historical)).toEqual(dumpData(fresh));

        if (shape.has('token_usage')) {
          // Σ tokens against the seed itself, not just against the other database.
          expect(tokensPerBucket(historical)).toEqual(EXPECTED_TOKENS);
          const summary = getCostSummary(historical, 10);
          expect(summary).toEqual(getCostSummary(fresh, 10));
          // Σ $ from the rollup the summary reads equals Σ $ from the raw ledger.
          expect(summary.totals.costUsd).toBeCloseTo(ledgerUsd(historical), 9);
          expect(summary.totals.costUsd).toBeGreaterThan(0);
          expect(summary.totals.unpricedTokens).toBeGreaterThan(0);
        }
      } finally {
        historical.close();
        fresh.close();
      }
    },
  );
});
