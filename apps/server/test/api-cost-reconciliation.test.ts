/**
 * DAT-10 - GET /api/cost/reconciliation, the advisory pricing drift alarm,
 * against a real migrated temp-file database.
 *
 * Seeded sonnet-5 rates (migration 20, from 2026-01-01): input $2, output
 * $10, cache read $0.2, 5m write $2.5, 1h write $4 per Mtok. A stored model
 * entry of 1 Mtok in + 1 Mtok out therefore prices at exactly $12, which is
 * the figure every in-band fixture below reports.
 *
 * The scope counters matter as much as the verdicts: a session the read
 * could not reconcile is counted under the reason it was skipped, so the
 * aggregate never silently covers an unstated subset.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CostStateModelUsage, ParsedCostState, SessionSubstrate } from '@agenthropic/core';
import { CostReconciliationSchema, MAX_RECONCILIATION_SAMPLE } from '@agenthropic/shared';
import { Value } from '@sinclair/typebox/value';
import { getCostReconciliation } from '../src/api/cost-reconciliation';
import { ingestSession, loadPricing } from '../src/index';
import { buildServer } from '../src/server';
import {
  createMigratedTempDb,
  insertAgent,
  insertSession,
  TEST_TOKEN,
  type TempDb,
} from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const URL = '/api/cost/reconciliation';

let temp: TempDb;

beforeEach(() => {
  temp = createMigratedTempDb();
});

afterEach(() => {
  temp.cleanup();
});

function sonnet(overrides: Partial<CostStateModelUsage> = {}): CostStateModelUsage {
  return {
    model: 'claude-sonnet-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 12,
    ...overrides,
  };
}

function costState(
  models: CostStateModelUsage[] = [sonnet()],
  overrides: Partial<ParsedCostState> = {},
): ParsedCostState {
  return {
    records: 1,
    malformedRecords: 0,
    latest: {
      totalCostUsd: models.reduce((sum, model) => sum + model.costUsd, 0),
      hasUnknownModelCost: false,
      models,
    },
    ...overrides,
  };
}

/** A session row holding `value` verbatim in `cost_state` (a string is stored raw). */
function store(id: string, value: unknown): void {
  insertSession(temp.db, id);
  temp.db
    .prepare('UPDATE sessions SET cost_state = ? WHERE id = ?')
    .run(typeof value === 'string' ? value : JSON.stringify(value), id);
}

function read(): ReturnType<typeof getCostReconciliation> {
  return getCostReconciliation(temp.db, loadPricing(temp.db));
}

const EMPTY = {
  isAdvisory: true,
  tolerance: 1e-6,
  sessionsWithCostState: 0,
  sessionsReconciled: 0,
  skipped: { noValidRecord: 0, noSpan: 0, unreadable: 0 },
  verdicts: { drift: 0, unpriced: 0, unverifiable: 0, inBand: 0 },
  reportedUsd: 0,
  malformedRecords: 0,
  sessions: [],
};

describe('getCostReconciliation()', () => {
  it('answers an all-zero, schema-valid report on an empty database', () => {
    const report = read();
    expect(report).toEqual(EMPTY);
    expect(Value.Check(CostReconciliationSchema, report)).toBe(true);
  });

  it('ignores sessions that never carried a cost-state record', () => {
    insertSession(temp.db, 'legacy');
    expect(read()).toEqual(EMPTY);
  });

  it("reconciles an in-band session and reports our ledger's figure beside it", () => {
    store('s-in', costState());
    insertAgent(temp.db, 'a-1', 's-in');
    temp.db
      .prepare(
        `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
         VALUES ('s-in', 'a-1', 'msg-1', 'claude-sonnet-5', 'output', 1000000, '2026-07-11T00:00:00Z')`,
      )
      .run();

    const report = read();
    expect(report).toEqual({
      ...EMPTY,
      sessionsWithCostState: 1,
      sessionsReconciled: 1,
      verdicts: { ...EMPTY.verdicts, inBand: 1 },
      reportedUsd: 12,
      sessions: [
        {
          sessionId: 's-in',
          verdict: 'in-band',
          reason: null,
          reportedUsd: 12,
          ledgerUsd: 10,
          models: [
            {
              model: 'claude-sonnet-5',
              verdict: 'in-band',
              reason: null,
              reportedUsd: 12,
              computedLowUsd: 12,
              computedHighUsd: 12,
            },
          ],
        },
      ],
    });
    expect(Value.Check(CostReconciliationSchema, report)).toBe(true);
  });

  it('counts each verdict and reads a session with no usage rows at a $0 ledger', () => {
    store('s-drift', costState([sonnet({ costUsd: 15 })]));
    store('s-unpriced', costState([sonnet({ model: 'claude-unknown-9' })]));
    store('s-search', costState([sonnet({ webSearchRequests: 2, costUsd: 12.02 })]));
    store('s-flag', {
      ...costState(),
      latest: { ...costState().latest, hasUnknownModelCost: true },
    });
    store('s-in', costState());

    const report = read();
    expect(report.verdicts).toEqual({ drift: 1, unpriced: 1, unverifiable: 2, inBand: 1 });
    expect(report.sessionsReconciled).toBe(5);
    expect(report.reportedUsd).toBeCloseTo(15 + 12 + 12.02 + 12 + 12, 9);
    expect(report.sessions.map((s) => [s.sessionId, s.verdict, s.reason])).toEqual([
      ['s-drift', 'drift', null],
      ['s-unpriced', 'unpriced', null],
      ['s-search', 'unverifiable', null],
      ['s-flag', 'unverifiable', 'unknown-model-cost'],
      ['s-in', 'in-band', null],
    ]);
    // A per-model cause stays on the model; only Claude Code's own flag is session-wide.
    expect(report.sessions[2]?.models[0]?.reason).toBe('web-search-requests');
    expect(report.sessions.every((s) => s.ledgerUsd === 0)).toBe(true);
    expect(Value.Check(CostReconciliationSchema, report)).toBe(true);
  });

  it('re-prices at request time, so a corrected rate changes the verdict at once', () => {
    store('s-1', costState([sonnet({ costUsd: 14 })]));
    expect(read().verdicts.drift).toBe(1);
    temp.db
      .prepare(
        `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
         VALUES ('claude-sonnet-5', 'input', 4, '2026-06-01T00:00:00.000Z')`,
      )
      .run();
    expect(read().verdicts).toEqual({ drift: 0, unpriced: 0, unverifiable: 0, inBand: 1 });
  });

  it('skips a stored state with no valid record and still sums its malformed count', () => {
    store('s-none', { records: 0, malformedRecords: 3, latest: null });
    store('s-in', costState(undefined, { malformedRecords: 1 }));
    const report = read();
    expect(report.skipped).toEqual({ noValidRecord: 1, noSpan: 0, unreadable: 0 });
    expect(report.malformedRecords).toBe(4);
    expect(report.sessionsWithCostState).toBe(2);
    expect(report.sessionsReconciled).toBe(1);
  });

  it.each([
    ['a null start', 'started_at = NULL'],
    ['a null last activity', 'last_activity_at = NULL'],
    ['an unparsable start', "started_at = 'not a date'"],
    ['an inverted span', "started_at = '2026-07-12T00:00:00Z'"],
  ])('skips a session with %s as noSpan', (_label, assignment) => {
    store('s-1', costState());
    temp.db.prepare(`UPDATE sessions SET ${assignment} WHERE id = 's-1'`).run();
    const report = read();
    expect(report.skipped).toEqual({ noValidRecord: 0, noSpan: 1, unreadable: 0 });
    expect(report.sessions).toEqual([]);
  });

  const sound = costState();
  it.each([
    ['a JSON array', []],
    ['a missing malformedRecords', { records: 1, latest: sound.latest }],
    ['a fractional malformedRecords', { ...sound, malformedRecords: 0.5 }],
    ['a non-object latest', { ...sound, latest: 'x' }],
    ['a missing total', { ...sound, latest: { ...sound.latest, totalCostUsd: undefined } }],
    [
      'a string unknown-cost flag',
      { ...sound, latest: { ...sound.latest, hasUnknownModelCost: 'no' } },
    ],
    ['a non-array models', { ...sound, latest: { ...sound.latest, models: {} } }],
    ['a non-object model entry', costState([42 as unknown as CostStateModelUsage])],
    ['a missing model id', costState([{ ...sonnet(), model: undefined as unknown as string }])],
    ['a negative cost', costState([sonnet({ costUsd: -1 })])],
    ['a fractional count', costState([sonnet({ outputTokens: 1.5 })])],
    [
      'a bad 5m split',
      costState([sonnet({ cacheCreation5mInputTokens: 'x' as unknown as number })]),
    ],
    ['a bad 1h split', costState([sonnet({ cacheCreation1hInputTokens: -1 })])],
  ])('skips a stored state with %s as unreadable', (_label, value) => {
    store('s-1', value);
    const report = read();
    expect(report.skipped).toEqual({ noValidRecord: 0, noSpan: 0, unreadable: 1 });
    expect(report.malformedRecords).toBe(0);
  });

  it('skips text that is not JSON at all (past the column CHECK) as unreadable', () => {
    insertSession(temp.db, 's-torn');
    temp.db.pragma('ignore_check_constraints = ON');
    temp.db.prepare("UPDATE sessions SET cost_state = '{torn' WHERE id = 's-torn'").run();
    temp.db.pragma('ignore_check_constraints = OFF');
    expect(read().skipped.unreadable).toBe(1);
  });

  it('accepts unsplit cache writes (null 5m/1h) as a readable state', () => {
    const unsplit = sonnet({
      cacheCreationInputTokens: 1_000_000,
      cacheCreation5mInputTokens: null,
      cacheCreation1hInputTokens: null,
      costUsd: 15,
    });
    store('s-1', costState([unsplit]));
    expect(read().sessions[0]?.models[0]).toMatchObject({
      verdict: 'in-band',
      computedLowUsd: 14.5,
      computedHighUsd: 16,
    });
  });

  it('orders the sample worst verdict first, then dearest, then by id, capped', () => {
    const total = MAX_RECONCILIATION_SAMPLE + 3;
    for (let i = 0; i < total; i += 1) {
      store(`s-${String(i).padStart(3, '0')}`, costState());
    }
    store('z-drift', costState([sonnet({ costUsd: 1 })]));
    store('z-dear', costState([sonnet({ inputTokens: 2_000_000, costUsd: 14 })]));

    const report = read();
    expect(report.sessionsReconciled).toBe(total + 2);
    expect(report.verdicts.inBand).toBe(total + 1);
    expect(report.sessions).toHaveLength(MAX_RECONCILIATION_SAMPLE);
    const ids = report.sessions.map((s) => s.sessionId);
    expect(ids.slice(0, 4)).toEqual(['z-drift', 'z-dear', 's-000', 's-001']);
    expect(ids.at(-1)).toBe(`s-${String(MAX_RECONCILIATION_SAMPLE - 3).padStart(3, '0')}`);
  });
});

describe('GET /api/cost/reconciliation', () => {
  async function get(headers: Record<string, string> = AUTH) {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 29, db: temp.db });
    await app.ready();
    try {
      return await app.inject({ method: 'GET', url: URL, headers });
    } finally {
      await app.close();
    }
  }

  it('rejects a request without a token or with a wrong one', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }] as Record<string, string>[]) {
      const response = await get(headers);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Unauthorized.' });
    }
  });

  it('serves the advisory report', async () => {
    store('s-in', costState());
    const response = await get();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Value.Check(CostReconciliationSchema, body)).toBe(true);
    expect(body).toMatchObject({ isAdvisory: true, verdicts: { inBand: 1 }, reportedUsd: 12 });
  });

  it('replies 422 on a malformed price table, like the ledger does', async () => {
    store('s-in', costState());
    temp.db
      .prepare(
        `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
         VALUES ('claude-sonnet-5', 'input', -1, '2026-02-01T00:00:00.000Z')`,
      )
      .run();
    const response = await get();
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: expect.any(String) });
  });

  it('replies 500 on any other failure', async () => {
    temp.db.exec('ALTER TABLE sessions RENAME TO sessions_gone');
    const response = await get();
    expect(response.statusCode).toBe(500);
  });
});

describe('ingest persists the cost state (end to end)', () => {
  const SESSION = 'dddddddd-1111-4222-8333-444444444444';

  function substrate(): SessionSubstrate {
    const line = (record: Record<string, unknown>): string => JSON.stringify(record);
    return {
      files: [
        {
          relativePath: `${SESSION}.jsonl`,
          lines: [
            line({ sessionId: SESSION, type: 'user', timestamp: '2026-11-08T00:00:00.000Z' }),
            line({
              sessionId: SESSION,
              type: 'assistant',
              timestamp: '2026-11-08T00:00:01.000Z',
              message: {
                id: 'msg_1',
                model: 'claude-sonnet-5',
                role: 'assistant',
                content: [],
                usage: { input_tokens: 1_000_000, output_tokens: 0 },
              },
            }),
            line({
              type: 'cost-state',
              sessionId: SESSION,
              totalCostUSD: 12,
              hasUnknownModelCost: false,
              modelUsage: {
                'claude-sonnet-5': {
                  inputTokens: 1_000_000,
                  outputTokens: 1_000_000,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                  webSearchRequests: 0,
                  costUSD: 12,
                },
              },
            }),
          ],
        },
      ],
    };
  }

  it('stores the latest cost state and the route reconciles it', () => {
    const outcome = ingestSession(substrate(), {
      db: temp.db,
      pricing: loadPricing(temp.db),
      instance: 'local',
      hostId: 'test-host',
      projectSlug: 'test-slug',
      now: () => '2026-11-08T00:00:02.000Z',
    });
    expect(outcome.error).toBeNull();

    const row = temp.db.prepare('SELECT cost_state FROM sessions WHERE id = ?').get(SESSION) as {
      cost_state: string;
    };
    expect(JSON.parse(row.cost_state)).toMatchObject({ records: 1, malformedRecords: 0 });

    const report = read();
    expect(report.verdicts.inBand).toBe(1);
    expect(report.sessions[0]).toMatchObject({ sessionId: SESSION, reportedUsd: 12, ledgerUsd: 2 });
  });
});
