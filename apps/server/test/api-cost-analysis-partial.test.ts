/**
 * The per-session cost analysis carries the same two honesty facts as every
 * other session total: `partial` (the main transcript was skipped as over the
 * read cap, so the figures are a lower bound) and `usageRecordsDropped` (usage
 * records with no `message.id`, excluded because they cannot be deduplicated).
 *
 * The analysis re-reads the transcripts rather than the stored rows, so both
 * facts are taken from THAT read - the one the figures were computed from -
 * not from whatever the last ingest pass stored.
 *
 * All data is synthetic: an in-memory fake corpus, never a real one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { createSubstrateProvider } from '../src/api/substrate-provider';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';
import { dir, file, makeFakeCorpusFs, type TreeSpec } from './corpus/fake-corpus-fs';

/**
 * `ParsedSession.usageRecordsDropped` is optional on the type (an additive
 * field), though `parseSession` always sets it. The switch lets one test hand
 * the provider a parse result without it; every other test sees the real one.
 */
const parser = vi.hoisted(() => ({ omitDroppedCount: false }));
vi.mock('@agenthropic/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agenthropic/core')>();
  return {
    ...actual,
    parseSession: (...args: Parameters<typeof actual.parseSession>) => {
      const parsed = actual.parseSession(...args);
      if (!parser.omitDroppedCount) return parsed;
      const withoutCount = { ...parsed };
      delete withoutCount.usageRecordsDropped;
      return withoutCount;
    },
  };
});

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-analysis-partial';
const SID = 'cafecafe-0000-4000-8000-000000000031';
const AGENT_HEX = 'facade31';
/** 70 MiB - over the DEFAULT 64 MiB cap, so the real limit is exercised. */
const OVERSIZE_BYTES = 70 * 1024 * 1024;
const MODEL = 'synthetic-model-a';

function assistantLine(second: number, messageId: string | undefined, input: number): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    sessionId: SID,
    agentId: AGENT_HEX,
    type: 'assistant',
    uuid: `88888888-0000-4000-8000-0000000000${String(second).padStart(2, '0')}`,
    timestamp: `2026-09-01T00:00:${String(second).padStart(2, '0')}.000Z`,
    message: {
      ...(messageId === undefined ? {} : { id: messageId }),
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'synthetic' }],
      usage: { input_tokens: input, output_tokens: 1 },
    },
  });
}

const MAIN_BODY =
  JSON.stringify({
    sessionId: SID,
    type: 'user',
    uuid: '88888888-0000-4000-8000-000000000000',
    timestamp: '2026-09-01T00:00:00.000Z',
    message: { role: 'user', content: 'go' },
  }) + '\n';

function corpus(main: ReturnType<typeof file>, agentLines: readonly string[]): TreeSpec {
  return {
    [SLUG]: dir({
      [`${SID}.jsonl`]: main,
      [SID]: dir({
        subagents: dir({ [`agent-${AGENT_HEX}.jsonl`]: file(agentLines.join('\n') + '\n') }),
      }),
    }),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  parser.omitDroppedCount = false;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startApp(tree: TreeSpec): Promise<FastifyInstance> {
  const temp: TempDb = createMigratedTempDb();
  const insert = temp.db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
  );
  for (const bucket of ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h']) {
    insert.run(MODEL, bucket, 1, '2020-01-01');
  }
  const app = buildServer({
    token: TEST_TOKEN,
    schemaVersion: 7,
    db: temp.db,
    substrateProvider: createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      fs: makeFakeCorpusFs(ROOT, tree),
    }),
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    temp.cleanup();
  });
  return app;
}

async function analyse(app: FastifyInstance) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/sessions/${SID}/cost-analysis?topTierModel=${MODEL}`,
    headers: AUTH,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

describe('GET /api/sessions/:id/cost-analysis carries the session honesty facts', () => {
  it('marks an analysis whose main transcript was skipped as over the cap partial', async () => {
    const app = await startApp(
      corpus(file(MAIN_BODY, { size: OVERSIZE_BYTES }), [
        assistantLine(1, 'msg_analysis_0001', 100),
        assistantLine(2, undefined, 900),
        assistantLine(3, undefined, 900),
      ]),
    );
    expect(await analyse(app)).toMatchObject({
      partial: { reason: 'main-transcript-oversize', skippedBytes: OVERSIZE_BYTES },
      usageRecordsDropped: 2,
    });
  });

  it('reports a whole read as not partial, with nothing dropped', async () => {
    const app = await startApp(
      corpus(file(MAIN_BODY), [assistantLine(1, 'msg_analysis_0002', 100)]),
    );
    expect(await analyse(app)).toMatchObject({ partial: null, usageRecordsDropped: 0 });
  });

  it('counts nothing dropped when the parse result carries no count', async () => {
    parser.omitDroppedCount = true;
    const app = await startApp(
      corpus(file(MAIN_BODY), [assistantLine(1, 'msg_analysis_0003', 100)]),
    );
    expect(await analyse(app)).toMatchObject({ partial: null, usageRecordsDropped: 0 });
  });
});
