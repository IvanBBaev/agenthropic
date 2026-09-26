/**
 * P0 proof 1 (WP-X3 + WP-IN13): Σ token_usage == JSONL, EXACTLY.
 *
 * After a real corpus ingest of EVERY registered fixture, the summed token
 * counts in `token_usage` must equal — integer equality, per session, per
 * model, per bucket — an independent sum computed straight from the raw JSONL
 * lines by THIS test. The expected side deliberately does NOT reuse the
 * production parser: it is a minimal reader written against the normative
 * rules of docs/analysis/parser-spec.md:
 *
 *  - section 5.1: a usage row is a `type === 'assistant'` record carrying both
 *    `message.usage` and `message.id`;
 *  - section 5.2 (correctness gate N3): lines sharing a `message.id` are
 *    streamed partials of ONE message — dedup collapses them to the PER-BUCKET
 *    MAXIMUM (never a sum), and the model settles to the greatest-output row;
 *  - section 5.3 bucket mapping: `cache_creation.ephemeral_5m/1h_input_tokens`
 *    when the nested object is present, else the legacy flat
 *    `cache_creation_input_tokens` as the 5m bucket (1h = 0).
 */
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DUPLICATED_MESSAGE_ID } from '@agenthropic/test-fixtures';
import { loadPricing, runCorpusIngest, type CorpusIngestSummary } from '../../src/index';
import type { SqliteDatabase } from '../../src/index';
import {
  DB_BUCKETS,
  FIXED_NOW,
  allFixtures,
  corpusEnv,
  countRows,
  makeTempDir,
  materializeCorpus,
  openSeededDb,
  type DbBucket,
} from './harness';

type JsonRecord = Record<string, unknown>;

/** One deduped message as reconstructed by the test's own independent reader. */
interface IndependentMessage {
  readonly sessionId: string;
  readonly messageId: string;
  model: string;
  /** Greatest output seen so far — the model-settling criterion (spec 5.2). */
  settledOutput: number;
  readonly buckets: Record<DbBucket, number>;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Every regular `*.jsonl` file under `root`, recursively. */
function listJsonlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(abs);
    }
  }
  return files;
}

/** Raw-field bucket mapping per parser-spec section 5.3 (NOT the production mapper). */
function bucketsOfRawUsage(usage: JsonRecord): Record<DbBucket, number> {
  const cacheCreation = asRecord(usage['cache_creation']);
  return {
    input: asCount(usage['input_tokens']),
    output: asCount(usage['output_tokens']),
    cache_read: asCount(usage['cache_read_input_tokens']),
    cache_write_5m:
      cacheCreation !== null
        ? asCount(cacheCreation['ephemeral_5m_input_tokens'])
        : asCount(usage['cache_creation_input_tokens']),
    cache_write_1h:
      cacheCreation !== null ? asCount(cacheCreation['ephemeral_1h_input_tokens']) : 0,
  };
}

/** The independent expected side: raw JSONL -> deduped messages, plus the raw line count. */
function readCorpusIndependently(corpusRoot: string): {
  deduped: Map<string, IndependentMessage>;
  rawUsageLines: number;
} {
  const deduped = new Map<string, IndependentMessage>();
  let rawUsageLines = 0;

  for (const file of listJsonlFiles(corpusRoot)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const record = asRecord(JSON.parse(line));
      if (record === null || record['type'] !== 'assistant') {
        continue;
      }
      const message = asRecord(record['message']);
      const usage = message === null ? null : asRecord(message['usage']);
      const messageId = message?.['id'];
      if (message === null || usage === null || typeof messageId !== 'string') {
        continue; // spec 5.1: usage rows require BOTH message.usage and message.id
      }
      rawUsageLines += 1;

      const sessionId = record['sessionId'];
      expect(typeof sessionId).toBe('string'); // every fixture record carries it
      const model = typeof message['model'] === 'string' ? message['model'] : '';
      const buckets = bucketsOfRawUsage(usage);

      const existing = deduped.get(messageId);
      if (existing === undefined) {
        deduped.set(messageId, {
          sessionId: sessionId as string,
          messageId,
          model,
          settledOutput: buckets.output,
          buckets,
        });
        continue;
      }
      // Spec 5.2: per-bucket MAXIMUM across partials, never a sum.
      for (const bucket of DB_BUCKETS) {
        existing.buckets[bucket] = Math.max(existing.buckets[bucket], buckets[bucket]);
      }
      // Spec 5.2: the message's model settles to the greatest-output row.
      if (buckets.output > existing.settledOutput) {
        existing.settledOutput = buckets.output;
        existing.model = model;
      }
    }
  }
  return { deduped, rawUsageLines };
}

const KEY_SEP = '\0';

describe('P0 proof 1 - sum(token_usage) equals the independent JSONL sum exactly', () => {
  const dirs: string[] = [];
  let db: SqliteDatabase;
  let corpusRoot: string;
  let summary: CorpusIngestSummary;
  let deduped: Map<string, IndependentMessage>;
  let rawUsageLines: number;

  beforeAll(() => {
    const dir = makeTempDir('agenthropic-p0-tokens-');
    dirs.push(dir);
    corpusRoot = join(dir, 'projects');
    materializeCorpus(corpusRoot, allFixtures());

    db = openSeededDb(join(dir, 'agent.db'));
    summary = runCorpusIngest({
      db,
      pricing: loadPricing(db),
      env: corpusEnv(corpusRoot, 'p0-proof-1'),
      now: () => FIXED_NOW,
    });

    const independent = readCorpusIndependently(corpusRoot);
    deduped = independent.deduped;
    rawUsageLines = independent.rawUsageLines;
  });

  afterAll(() => {
    db.close();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P0: ingests the WHOLE fixture registry cleanly (proof precondition)', () => {
    expect(summary.sessionsDiscovered).toBe(allFixtures().length);
    expect(summary.sessionsOk).toBe(allFixtures().length);
    expect(summary.sessionsFailed).toBe(0);
    expect(summary.failures).toEqual([]);
    expect(summary.usageRowsInserted).toBeGreaterThan(0);
  });

  it('P0: the dedup rule is load-bearing — the corpus really contains streamed partials', () => {
    // Guards against a trivially-green proof: if dedup were a no-op the
    // expected and actual sides could agree while both over-count.
    expect(rawUsageLines).toBeGreaterThan(deduped.size);
    const dup = deduped.get(DUPLICATED_MESSAGE_ID);
    expect(dup).toBeDefined();
    expect(dup?.buckets.output).toBe(310); // max(7, 7, 310) — NOT the 324 a summing reader gets
    expect(dup?.buckets.input).toBe(8);
    expect(dup?.buckets.cache_read).toBe(52000);
  });

  it('P0: every token_usage row equals the independently deduped message, cell by cell', () => {
    const rows = db
      .prepare('SELECT session_id, agent_id, message_id, model, bucket, tokens FROM token_usage')
      .all() as {
      session_id: string;
      message_id: string;
      model: string;
      bucket: DbBucket;
      tokens: number;
    }[];

    // Exactly the deduped universe, fanned out to the full 5-bucket matrix.
    expect(rows).toHaveLength(deduped.size * DB_BUCKETS.length);
    expect(countRows(db, 'token_usage')).toBe(deduped.size * DB_BUCKETS.length);

    for (const row of rows) {
      const expected = deduped.get(row.message_id);
      expect(expected, `unexpected message_id ${row.message_id} in token_usage`).toBeDefined();
      expect(Number.isInteger(row.tokens)).toBe(true);
      expect(row.tokens, `tokens mismatch for ${row.message_id}/${row.bucket}`).toBe(
        expected?.buckets[row.bucket],
      );
      expect(row.model, `model mismatch for ${row.message_id}`).toBe(expected?.model);
      expect(row.session_id, `session mismatch for ${row.message_id}`).toBe(expected?.sessionId);
    }
  });

  it('P0: every token_usage row is attributed to exactly one agent of its own session', () => {
    // WP-IN9 Done-when: "After backfill every row attributed to exactly one agent"
    // (development-plan). Until 2026-09-26 only the session-sum half was proven:
    // the test above selects agent_id and never asserts it, and the schema has no
    // FK from token_usage to agents, so nothing else enforces it either.
    const unattributed = db
      .prepare(
        `SELECT tu.session_id, tu.message_id, tu.bucket, tu.agent_id
           FROM token_usage tu
           LEFT JOIN agents a ON a.id = tu.agent_id AND a.session_id = tu.session_id
          WHERE tu.agent_id IS NULL OR a.id IS NULL`,
      )
      .all();
    expect(unattributed).toEqual([]);

    // "Exactly one": the five bucket rows of one message never split across agents.
    const split = db
      .prepare(
        `SELECT session_id, message_id, COUNT(DISTINCT agent_id) AS agents
           FROM token_usage
          GROUP BY session_id, message_id
         HAVING COUNT(DISTINCT agent_id) <> 1`,
      )
      .all();
    expect(split).toEqual([]);

    // Not vacuous: the corpus attributes usage to subagents, not only to mains.
    const subagentRows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM token_usage tu
           JOIN agents a ON a.id = tu.agent_id AND a.session_id = tu.session_id
          WHERE a.type = 'subagent'`,
      )
      .get() as { n: number };
    expect(subagentRows.n).toBeGreaterThan(0);
  });

  it('P0: per (session, model, bucket) sums match the independent sums with integer equality', () => {
    const expectedSums = new Map<string, number>();
    for (const message of deduped.values()) {
      for (const bucket of DB_BUCKETS) {
        const key = [message.sessionId, message.model, bucket].join(KEY_SEP);
        expectedSums.set(key, (expectedSums.get(key) ?? 0) + message.buckets[bucket]);
      }
    }

    const actualRows = db
      .prepare(
        `SELECT session_id, model, bucket, SUM(tokens) AS total
           FROM token_usage
          GROUP BY session_id, model, bucket`,
      )
      .all() as { session_id: string; model: string; bucket: string; total: number }[];
    const actualSums = new Map<string, number>(
      actualRows.map((row) => [[row.session_id, row.model, row.bucket].join(KEY_SEP), row.total]),
    );

    expect(actualSums.size).toBeGreaterThan(0);
    for (const total of actualSums.values()) {
      expect(Number.isInteger(total)).toBe(true);
    }
    // EXACT equality of the complete key set and every integer total — both
    // directions (nothing missing, nothing extra), zero-token buckets included.
    expect(Object.fromEntries(actualSums)).toEqual(Object.fromEntries(expectedSums));
  });

  it('P0: per (model, bucket) corpus-wide sums match the independent sums with integer equality', () => {
    const expectedSums = new Map<string, number>();
    for (const message of deduped.values()) {
      for (const bucket of DB_BUCKETS) {
        const key = [message.model, bucket].join(KEY_SEP);
        expectedSums.set(key, (expectedSums.get(key) ?? 0) + message.buckets[bucket]);
      }
    }

    const actualRows = db
      .prepare('SELECT model, bucket, SUM(tokens) AS total FROM token_usage GROUP BY model, bucket')
      .all() as { model: string; bucket: string; total: number }[];
    const actualSums = new Map<string, number>(
      actualRows.map((row) => [[row.model, row.bucket].join(KEY_SEP), row.total]),
    );

    expect(Object.fromEntries(actualSums)).toEqual(Object.fromEntries(expectedSums));
  });
});
