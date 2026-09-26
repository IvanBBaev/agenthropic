/**
 * What `coverage.sessionsExcluded` actually means for a session that used to
 * ingest and then stopped.
 *
 * `api/routes.ts` attaches the coverage disclosure with the comment "by
 * construction, a session that failed to ingest left none behind", and the
 * client repeats the same claim to the reader in words: "a quarantined session
 * never reaches the read API". Both rest on the halt gate - `ingestSession`
 * prices BEFORE opening its transaction, so a pass that cannot price a
 * substrate writes nothing at all.
 *
 * That argument is sound, and it covers exactly one case: a session that has
 * NEVER ingested. It says nothing about the case these tests pin, which the
 * corpus produces on its own without anybody doing anything wrong:
 *
 *   1. a session ingests cleanly and its rows commit;
 *   2. the transcript - which is append-only - gains lines naming a model with
 *      no price row (a new model shipping ahead of its price is the commonest
 *      halt-gate refusal there is);
 *   3. every later pass halts on the price gate before the transaction, so the
 *      committed rows from step 1 are neither updated nor removed;
 *   4. the retry budget runs out and the session is quarantined.
 *
 * Quarantine lives in the watcher's in-memory `attempts` map. No column, no
 * row, nothing the read API can join against - so the read API cannot know,
 * and it goes on serving step 1's rows. The session is therefore counted in
 * `sessionsExcluded` and `sessionsQuarantined` WHILE its own (now frozen,
 * now partial) figures are inside the totals that coverage qualifies.
 *
 * These tests do not argue about the wording; they establish the fact the
 * wording has to survive. The direction of the error is the point: a reader
 * told "N sessions are missing from this number" will read the number as a
 * lower bound and reason about what is absent, when the truth for such a
 * session is that it is PRESENT and stale.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PricingEntry } from '@agenthropic/core';
import { buildServer } from '../src/server';
import {
  MAX_INGEST_ATTEMPTS,
  createCorpusWatcher,
  type CorpusWatcherDeps,
} from '../src/ingest/corpus-watcher';
import type { SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-quarantine-project';
const SESSION_ID = '99999999-8888-4777-8666-555555555555';
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const THRESHOLD_MS = 10 * 60_000;
const NOW_MS = Date.parse('2026-07-12T00:00:00Z');

/** Priced in the seed below; the model the healthy first pass runs on. */
const PRICED_MODEL = 'synthetic-model-a';
/** Deliberately absent from pricing: the halt gate's whole reason to exist. */
const UNPRICED_MODEL = 'synthetic-model-shipped-early';

const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;
const PRICING: readonly PricingEntry[] = BUCKETS.map((bucket) => ({
  model: PRICED_MODEL,
  bucket,
  usdPerMtok: 1,
  effectiveFrom: '2020-01-01',
}));

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

/** The healthy day-1 transcript: one prompt, one priced assistant reply. */
const DAY_ONE_LINES = [
  jsonLine({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/synthetic/project',
    sessionId: SESSION_ID,
    version: '2.0.0',
    type: 'user',
    message: { role: 'user', content: 'Synthetic prompt: summarize the widgets.' },
    uuid: 'cccccccc-0000-4000-8000-000000000001',
    timestamp: '2026-07-10T10:00:00.000Z',
  }),
  jsonLine({
    parentUuid: 'cccccccc-0000-4000-8000-000000000001',
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_quarantine_0001',
      type: 'message',
      role: 'assistant',
      model: PRICED_MODEL,
      content: [{ type: 'text', text: 'Synthetic reply: 7 widgets.' }],
      usage: {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
    uuid: 'cccccccc-0000-4000-8000-000000000002',
    timestamp: '2026-07-10T10:00:05.000Z',
  }),
];

/** The day-2 append: one more reply, on a model no price row covers. */
const DAY_TWO_LINE = jsonLine({
  parentUuid: 'cccccccc-0000-4000-8000-000000000002',
  isSidechain: false,
  sessionId: SESSION_ID,
  type: 'assistant',
  message: {
    id: 'msg_synth_quarantine_0002',
    type: 'message',
    role: 'assistant',
    model: UNPRICED_MODEL,
    content: [{ type: 'text', text: 'Synthetic reply from a model that shipped early.' }],
    usage: {
      input_tokens: 2_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
  },
  uuid: 'cccccccc-0000-4000-8000-000000000003',
  timestamp: '2026-07-11T10:00:00.000Z',
});

/** The read queries price from `model_pricing`, not from the watcher's table. */
function seedPricing(db: SqliteDatabase): void {
  const insert = db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
  );
  for (const entry of PRICING) {
    insert.run(entry.model, entry.bucket, entry.usdPerMtok, entry.effectiveFrom);
  }
}

describe('a session that ingested, then began failing, then was quarantined', () => {
  let temp: TempDb;
  let slugTree: Record<string, NodeSpec>;
  let deps: CorpusWatcherDeps;

  beforeEach(() => {
    temp = createMigratedTempDb();
    seedPricing(temp.db);
    slugTree = {
      [`${SESSION_ID}.jsonl`]: file(DAY_ONE_LINES.join('\n') + '\n', { size: 100, mtimeMs: 1 }),
    };
    deps = {
      db: temp.db,
      pricing: PRICING,
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      intervalMs: 1000,
      watchdogThresholdMs: THRESHOLD_MS,
      fs: makeFakeCorpusFs(ROOT, { [SLUG]: dir(slugTree) }),
      nowMs: () => NOW_MS,
    };
  });

  afterEach(() => {
    temp.cleanup();
  });

  /** Simulate the append: new content, and a fingerprint that moved with it. */
  function appendUnpricedLine(): void {
    slugTree[`${SESSION_ID}.jsonl`] = file([...DAY_ONE_LINES, DAY_TWO_LINE].join('\n') + '\n', {
      size: 200,
      mtimeMs: 2,
    });
  }

  function usageRows(): number {
    const row = temp.db
      .prepare('SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ?')
      .get(SESSION_ID) as { n: number };
    return row.n;
  }

  it('keeps the rows its successful pass committed, and goes on serving them', async () => {
    const watcher = createCorpusWatcher(deps);

    watcher.tick();
    const afterHealthyPass = usageRows();
    expect(afterHealthyPass).toBeGreaterThan(0);

    appendUnpricedLine();
    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
      watcher.tick();
    }

    // The halt gate did its job - it wrote nothing. That is exactly why the
    // earlier rows are still here: "wrote nothing" is not "removed what was
    // there", and only the first of those two would make the claim true.
    expect(usageRows()).toBe(afterHealthyPass);
    expect(watcher.exclusions()).toEqual({ failing: 1, quarantined: 1 });

    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 7,
      db: temp.db,
      ingestExclusions: () => watcher.exclusions(),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
      const body = response.json();

      // The finding, in one pair of assertions: the session is counted as
      // excluded, and its own dollars are inside the total that count
      // qualifies. Both numbers are correct on their own; together they say
      // something neither of them means.
      //
      // `unpricedTokens: 0` is the third figure and the sharpest of the three.
      // Its job is to disclose tokens this dashboard holds but cannot price,
      // and it reads zero while two million tokens in this very session went
      // unpriced - truthfully, in its own terms, because it counts stored rows
      // and the halt gate stored none. A reader sees "nothing unpriced".
      expect(body.coverage).toEqual({ sessionsExcluded: 1, sessionsQuarantined: 1 });
      // Exact, not `> 0`: these are day one's own million tokens and day one's
      // own dollar. The corpus holds three million for this session.
      expect(body.totals).toEqual({ tokens: 1_000_000, costUsd: 1, unpricedTokens: 0 });
    } finally {
      await app.close();
    }
  });

  it('is still listed by the read API after quarantine', async () => {
    const watcher = createCorpusWatcher(deps);
    watcher.tick();
    appendUnpricedLine();
    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
      watcher.tick();
    }
    expect(watcher.exclusions().quarantined).toBe(1);

    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/sessions', headers: AUTH });

      expect(response.statusCode).toBe(200);
      const ids = (response.json() as { sessions: { id: string }[] }).sessions.map((s) => s.id);
      expect(ids).toContain(SESSION_ID);
    } finally {
      await app.close();
    }
  });

  it('serves a total that stops at the last pass that could be priced', async () => {
    const watcher = createCorpusWatcher(deps);
    watcher.tick();

    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    try {
      const before = (
        await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH })
      ).json();

      appendUnpricedLine();
      for (let i = 0; i < MAX_INGEST_ATTEMPTS; i += 1) {
        watcher.tick();
      }

      const after = (
        await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH })
      ).json();

      // Unchanged, though the corpus grew by two million tokens. The served
      // figure is frozen at the last priceable pass, and nothing in the body
      // distinguishes "frozen" from "current" - which is the part a reader
      // cannot see and the coverage count does not tell them.
      expect(after.totals).toEqual(before.totals);
    } finally {
      await app.close();
    }
  });
});
