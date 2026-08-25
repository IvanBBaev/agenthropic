/**
 * M-19 — the standing EQUIVALENCE guard for the cost-summary cache.
 *
 * The cache in `api/queries.ts` is a memo, and a memo that can answer
 * differently from the data is not a performance win, it is a fabricated
 * dollar figure. These tests therefore never assert on timing; they assert
 * that the value the server SERVES is identical to a full uncached scan of the
 * same database.
 *
 * The uncached oracle is exact and needs no production seam: the cache is a
 * `WeakMap` keyed on the connection HANDLE, so a freshly opened second
 * connection to the same file is guaranteed cache-cold. Its `getCostSummary`
 * is a real, full, priced scan — verified per call through the `onScan` probe,
 * so "the oracle actually scanned" is proven rather than assumed.
 *
 * Scope note (honesty, not scope creep): none of this makes the read BOUNDED.
 * See the M-19 comment in `getCostSummary` — the asymptotic fix is a persisted
 * ingest-side rollup, which is a schema + ingest change. These tests exist so
 * that whatever replaces the cache has to keep proving the same equality.
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
import { createMigratedTempDb, type TempDb } from './helpers';

const SLUG = '-Users-synthetic-equivalence-project';
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;
const TOP_N = 5;

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

  /** `getCostSummary` on a guaranteed cache-cold handle — the uncached oracle. */
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
});
