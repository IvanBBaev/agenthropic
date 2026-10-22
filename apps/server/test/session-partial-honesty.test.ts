/**
 * Owner decisions on two silent undercounts, persisted and served.
 *
 * DECISION 1 — an oversize main transcript makes a PARTIAL session. The 64 MiB
 * read cap stays; what changes is that a session whose `<uuid>.jsonl` main was
 * skipped for size (while its subagents still ingested) is no longer presented
 * as whole. The session row carries `partial_reason = 'main-transcript-oversize'`
 * and the skipped file's byte size, and every API DTO that shows a session
 * total carries `partial` so the dashboard can say "lower bound".
 *
 * DECISION 2 / NN1 — usage records the parser had to drop (no `message.id`, so
 * no dedupe key) are counted per session in `usage_records_dropped` and served
 * as `usageRecordsDropped`.
 *
 * All data is synthetic: an in-memory fake corpus, never a real one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PricingEntry } from '@agenthropic/core';
import { buildServer } from '../src/server';
import {
  DEFAULT_MAX_FILE_BYTES,
  type CorpusFs,
  type SessionRef,
  type SkippedFile,
} from '../src/corpus/fs-port';
import { buildSessionSubstrate, enumerateSessions } from '../src/corpus/disk-substrate';
import { partialFor, runCorpusIngest, type CorpusIngestDeps } from '../src/corpus/ingest-corpus';
import { loadPricing } from '../src/db/pricing';
import type { IngestDeps } from '../src/ingest/ingest-session';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';
import { dir, file, makeFakeCorpusFs, type TreeSpec } from './corpus/fake-corpus-fs';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-partial-project';
const SID = 'cafecafe-0000-4000-8000-000000000021';
const AGENT_HEX = 'facade21';
/** 70 MiB — over the DEFAULT 64 MiB cap, so the test exercises the real limit. */
const OVERSIZE_BYTES = 70 * 1024 * 1024;

const PRICING: readonly PricingEntry[] = (
  ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const
).map((bucket) => ({
  model: 'synthetic-model-a',
  bucket,
  usdPerMtok: 1,
  effectiveFrom: '2020-01-01',
}));

function assistantLine(second: number, messageId: string | undefined, input: number): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    sessionId: SID,
    agentId: AGENT_HEX,
    type: 'assistant',
    uuid: `77777777-0000-4000-8000-0000000000${String(second).padStart(2, '0')}`,
    timestamp: `2026-09-01T00:00:${String(second).padStart(2, '0')}.000Z`,
    message: {
      ...(messageId === undefined ? {} : { id: messageId }),
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [{ type: 'text', text: 'synthetic' }],
      usage: { input_tokens: input, output_tokens: 1 },
    },
  });
}

/** The subagent transcript: one deduplicable message and two id-less records. */
const AGENT_BODY =
  [
    assistantLine(1, 'msg_partial_0001', 100),
    assistantLine(2, undefined, 900),
    assistantLine(3, undefined, 900),
  ].join('\n') + '\n';

const MAIN_BODY =
  JSON.stringify({
    sessionId: SID,
    type: 'user',
    uuid: '77777777-0000-4000-8000-000000000000',
    timestamp: '2026-09-01T00:00:00.000Z',
    message: { role: 'user', content: 'go' },
  }) + '\n';

/** A main that itself holds one id-less usage record: a whole read counts three. */
const MAIN_WITH_DROPPED_BODY =
  MAIN_BODY +
  JSON.stringify({
    parentUuid: '77777777-0000-4000-8000-000000000000',
    isSidechain: false,
    sessionId: SID,
    type: 'assistant',
    uuid: '77777777-0000-4000-8000-000000000009',
    timestamp: '2026-09-01T00:00:09.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [{ type: 'text', text: 'synthetic' }],
      usage: { input_tokens: 900, output_tokens: 1 },
    },
  }) +
  '\n';

function corpus(main: ReturnType<typeof file>): TreeSpec {
  return {
    [SLUG]: dir({
      [`${SID}.jsonl`]: main,
      [SID]: dir({ subagents: dir({ [`agent-${AGENT_HEX}.jsonl`]: file(AGENT_BODY) }) }),
    }),
  };
}

const OVERSIZE_MAIN = file(MAIN_BODY, { size: OVERSIZE_BYTES });

function deps(
  temp: TempDb,
  tree: TreeSpec,
  extra: Partial<CorpusIngestDeps> = {},
): CorpusIngestDeps {
  return {
    db: temp.db,
    pricing: [...loadPricing(temp.db), ...PRICING],
    env: { CLAUDE_PROJECTS_DIR: ROOT },
    fs: makeFakeCorpusFs(ROOT, tree),
    now: () => '2026-09-02T00:00:00.000Z',
    ...extra,
  };
}

interface SessionHonestyRow {
  readonly partial_reason: string | null;
  readonly partial_skipped_bytes: number | null;
  readonly usage_records_dropped: number;
}

function sessionRow(temp: TempDb): SessionHonestyRow | undefined {
  return temp.db
    .prepare(
      'SELECT partial_reason, partial_skipped_bytes, usage_records_dropped FROM sessions WHERE id = ?',
    )
    .get(SID) as SessionHonestyRow | undefined;
}

/** The one session the fake corpus holds - asserting the `sessions` arm. */
function onlyRef(fs: CorpusFs): SessionRef {
  const enumeration = enumerateSessions(fs, ROOT);
  if (enumeration.kind !== 'sessions') {
    expect.unreachable(`expected enumerated sessions, got ${enumeration.kind}`);
  }
  expect(enumeration.refs).toHaveLength(1);
  return enumeration.refs[0]!;
}

describe('the substrate records the skipped byte size of an oversize file', () => {
  it('an oversize main carries sizeBytes; an unreadable one does not', () => {
    const fs = makeFakeCorpusFs(ROOT, corpus(OVERSIZE_MAIN));
    const ref = onlyRef(fs);
    const built = buildSessionSubstrate(fs, ref, {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxDepth: 4,
    });
    expect(built.skipped).toEqual([
      {
        relativePath: `${SID}.jsonl`,
        reason: 'oversize',
        code: undefined,
        sizeBytes: OVERSIZE_BYTES,
      },
    ]);

    const eacces = makeFakeCorpusFs(ROOT, corpus(file(MAIN_BODY, { throwCode: 'EACCES' })));
    const eaccesRef = onlyRef(eacces);
    const unreadable = buildSessionSubstrate(eacces, eaccesRef, {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxDepth: 4,
    });
    expect(unreadable.skipped).toEqual([
      { relativePath: `${SID}.jsonl`, reason: 'unreadable', code: 'EACCES' },
    ]);
  });

  it('an oversize subagent artifact carries sizeBytes too', () => {
    const tree: TreeSpec = {
      [SLUG]: dir({
        [`${SID}.jsonl`]: file(MAIN_BODY),
        [SID]: dir({
          subagents: dir({ [`agent-${AGENT_HEX}.jsonl`]: file(AGENT_BODY, { size: 5000 }) }),
        }),
      }),
    };
    const fs = makeFakeCorpusFs(ROOT, tree);
    const ref = onlyRef(fs);
    const built = buildSessionSubstrate(fs, ref, { maxFileBytes: 1000, maxDepth: 4 });
    expect(built.skipped).toEqual([
      {
        relativePath: `subagents/agent-${AGENT_HEX}.jsonl`,
        reason: 'oversize',
        code: undefined,
        sizeBytes: 5000,
      },
    ]);
  });
});

describe('runCorpusIngest hands the partial fact to ingest', () => {
  function capturedDeps(temp: TempDb, tree: TreeSpec, maxFileBytes?: number): IngestDeps[] {
    const seen: IngestDeps[] = [];
    runCorpusIngest(
      deps(temp, tree, {
        ...(maxFileBytes === undefined ? {} : { limits: { maxFileBytes } }),
        ingest: (_substrate, ingestDeps) => {
          seen.push(ingestDeps);
          return {
            ok: true,
            sessionId: SID,
            costUsd: 0,
            agentsUpserted: 0,
            edgesInserted: 0,
            usageRowsInserted: 0,
            statusReconciliations: [],
            crossSessionUsageCollisions: 0,
            error: null,
          };
        },
      }),
    );
    return seen;
  }

  let temp: TempDb;
  beforeEach(() => {
    temp = createMigratedTempDb();
  });
  afterEach(() => {
    temp.cleanup();
  });

  it('an oversize MAIN marks the session partial, with the skipped size', () => {
    const [only] = capturedDeps(temp, corpus(OVERSIZE_MAIN));
    expect(only?.partial).toEqual({
      reason: 'main-transcript-oversize',
      skippedBytes: OVERSIZE_BYTES,
    });
  });

  it('a whole read, an oversize SUBAGENT and an unreadable main are not this partial', () => {
    expect(capturedDeps(temp, corpus(file(MAIN_BODY)))[0]?.partial).toBeNull();

    const bigAgent: TreeSpec = {
      [SLUG]: dir({
        [`${SID}.jsonl`]: file(MAIN_BODY),
        [SID]: dir({
          subagents: dir({
            [`agent-${AGENT_HEX}.jsonl`]: file(AGENT_BODY, { size: 5000 }),
            'agent-beefbeef.jsonl': file(AGENT_BODY.replaceAll(AGENT_HEX, 'beefbeef')),
          }),
        }),
      }),
    };
    expect(capturedDeps(temp, bigAgent, 1000)[0]?.partial).toBeNull();

    const eacces = corpus(file(MAIN_BODY, { throwCode: 'EACCES' }));
    expect(capturedDeps(temp, eacces)[0]?.partial).toBeNull();
  });
});

describe('the partial flag and the dropped count are persisted by the real ingest', () => {
  let temp: TempDb;
  beforeEach(() => {
    temp = createMigratedTempDb();
  });
  afterEach(() => {
    temp.cleanup();
  });

  it('writes partial + dropped count, and a later whole read clears the partial', () => {
    const first = runCorpusIngest(deps(temp, corpus(OVERSIZE_MAIN)));
    expect(first.failures).toEqual([]);
    expect(first.sessionsOk).toBe(1);
    expect(sessionRow(temp)).toEqual({
      partial_reason: 'main-transcript-oversize',
      partial_skipped_bytes: OVERSIZE_BYTES,
      usage_records_dropped: 2,
    });

    // Idempotent: the same pass again changes nothing.
    runCorpusIngest(deps(temp, corpus(OVERSIZE_MAIN)));
    expect(sessionRow(temp)?.partial_reason).toBe('main-transcript-oversize');

    // The main shrinks back under the cap (or the cap is raised): the latest
    // pass is the truth, so the session is whole again.
    runCorpusIngest(deps(temp, corpus(file(MAIN_BODY))));
    expect(sessionRow(temp)).toEqual({
      partial_reason: null,
      partial_skipped_bytes: null,
      usage_records_dropped: 2,
    });
  });

  it('a main that grows past the cap never lowers the dropped count', () => {
    // Read whole: the main's own id-less record counts with the subagent's two.
    runCorpusIngest(deps(temp, corpus(file(MAIN_WITH_DROPPED_BODY))));
    expect(sessionRow(temp)?.usage_records_dropped).toBe(3);

    // The main grows past the cap. This pass sees only the subagent's two, but
    // the main's record is still excluded from totals that still hold the
    // main's earlier usage: the count is a lower bound and must not shrink.
    runCorpusIngest(deps(temp, corpus(file(MAIN_WITH_DROPPED_BODY, { size: OVERSIZE_BYTES }))));
    expect(sessionRow(temp)).toEqual({
      partial_reason: 'main-transcript-oversize',
      partial_skipped_bytes: OVERSIZE_BYTES,
      usage_records_dropped: 3,
    });

    // A whole read is exact, so it still overwrites - downwards too.
    runCorpusIngest(deps(temp, corpus(file(MAIN_BODY))));
    expect(sessionRow(temp)).toEqual({
      partial_reason: null,
      partial_skipped_bytes: null,
      usage_records_dropped: 2,
    });
  });

  it('the schema refuses an unknown partial reason and defaults the dropped count to 0', () => {
    temp.db.exec(`INSERT INTO sessions (id) VALUES ('${SID}')`);
    expect(sessionRow(temp)).toEqual({
      partial_reason: null,
      partial_skipped_bytes: null,
      usage_records_dropped: 0,
    });
    expect(() =>
      temp.db.exec(`UPDATE sessions SET partial_reason = 'made-up' WHERE id = '${SID}'`),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('the API serves partial and usageRecordsDropped on every session total', () => {
  let temp: TempDb;
  let app: FastifyInstance;
  const warnings: SkippedFile[] = [];

  beforeEach(async () => {
    temp = createMigratedTempDb();
    runCorpusIngest(deps(temp, corpus(OVERSIZE_MAIN), { onWarning: (w) => warnings.push(w) }));
    // A second, whole session with no drops, so aggregates count only the one.
    temp.db.exec(
      `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
       VALUES ('whole-session', 'p', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 'active');
       INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
       VALUES ('whole-session', NULL, 'w1', 'synthetic-model-a', 'input', 5, 0, '2026-08-01T00:00:00Z');`,
    );
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    temp.cleanup();
  });

  const PARTIAL = { reason: 'main-transcript-oversize', skippedBytes: OVERSIZE_BYTES };

  it('the list and the detail carry it (and a whole session carries null / 0)', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/sessions', headers: AUTH });
    expect(list.statusCode).toBe(200);
    const byId = new Map(
      (list.json().sessions as Array<{ id: string }>).map((s) => [s.id, s] as const),
    );
    expect(byId.get(SID)).toMatchObject({ partial: PARTIAL, usageRecordsDropped: 2 });
    expect(byId.get('whole-session')).toMatchObject({ partial: null, usageRecordsDropped: 0 });

    const detail = await app.inject({ method: 'GET', url: `/api/sessions/${SID}`, headers: AUTH });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ partial: PARTIAL, usageRecordsDropped: 2 });
  });

  it('the tree carries it', async () => {
    const tree = await app.inject({
      method: 'GET',
      url: `/api/sessions/${SID}/tree`,
      headers: AUTH,
    });
    expect(tree.statusCode).toBe(200);
    expect(tree.json()).toMatchObject({ partial: PARTIAL, usageRecordsDropped: 2 });
    const whole = await app.inject({
      method: 'GET',
      url: '/api/sessions/whole-session/tree',
      headers: AUTH,
    });
    expect(whole.json()).toMatchObject({ partial: null, usageRecordsDropped: 0 });
  });

  it('the cost summary carries it per top session and as corpus aggregates', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.partialSessions).toBe(1);
    expect(body.usageRecordsDropped).toBe(2);
    const top = new Map(
      (body.topSessions as Array<{ sessionId: string }>).map((s) => [s.sessionId, s] as const),
    );
    expect(top.get(SID)).toMatchObject({ partial: PARTIAL, usageRecordsDropped: 2 });
    expect(top.get('whole-session')).toMatchObject({ partial: null, usageRecordsDropped: 0 });
  });

  it('a session in the ledger with no sessions row is served as not partial', async () => {
    temp.db.exec(
      `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
       VALUES ('orphan-session', NULL, 'o1', 'synthetic-model-a', 'input', 50000, 0, '2026-08-01T00:00:00Z');`,
    );
    const response = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
    const top = (response.json().topSessions as Array<{ sessionId: string }>).find(
      (s) => s.sessionId === 'orphan-session',
    );
    expect(top).toMatchObject({ projectSlug: null, partial: null, usageRecordsDropped: 0 });
  });

  it('a partial with an unknown skipped size is served with skippedBytes null', async () => {
    temp.db.exec(`UPDATE sessions SET partial_skipped_bytes = NULL WHERE id = '${SID}'`);
    const detail = await app.inject({ method: 'GET', url: `/api/sessions/${SID}`, headers: AUTH });
    expect(detail.json().partial).toEqual({
      reason: 'main-transcript-oversize',
      skippedBytes: null,
    });
  });
});

describe('partialFor (the skip -> partial mapping)', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('reports a null byte count when an oversize main skip carries no size', () => {
    expect(partialFor(id, [{ relativePath: `${id}.jsonl`, reason: 'oversize' }])).toEqual({
      reason: 'main-transcript-oversize',
      skippedBytes: null,
    });
  });

  it('ignores an unreadable main and an oversize subagent file', () => {
    expect(
      partialFor(id, [
        { relativePath: `${id}.jsonl`, reason: 'unreadable' },
        { relativePath: `${id}/subagents/agent-x.jsonl`, reason: 'oversize', sizeBytes: 9 },
      ]),
    ).toBeNull();
  });
});
