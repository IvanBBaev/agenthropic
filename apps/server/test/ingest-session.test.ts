/**
 * WP-IN9 ingest integrator - end-to-end tests over the synthetic fixture corpus.
 *
 * The corpus models use synthetic model ids (`synthetic-model-a`/`-b`) that the
 * WP-C1 pricing seed does not cover, so the DB-loaded prices are layered with
 * synthetic-model rows to make cost computable; `loadPricing(db)` is still
 * exercised as the base. The halt-gate test deliberately passes EMPTY pricing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSession, type PricingEntry } from '@agenthropic/core';
import { FIXTURE_NAMES, getFixture } from '@agenthropic/test-fixtures';
import { ingestSession, loadPricing } from '../src/index';
import type { IngestDeps } from '../src/index';
import type { SqliteDatabase } from '../src/db/connection';
import { getGlobalDag, getSessionTree } from '../src/api/queries';
import { createMigratedTempDb, type TempDb } from './helpers';

const FIXED_NOW = '2026-07-11T00:00:00.000Z';
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

/** Prices for the synthetic corpus models, effective well before every fixture timestamp. */
const SYNTHETIC_PRICING: readonly PricingEntry[] = [
  'synthetic-model-a',
  'synthetic-model-b',
].flatMap((model): PricingEntry[] =>
  BUCKETS.map((bucket) => ({ model, bucket, usdPerMtok: 1, effectiveFrom: '2020-01-01' })),
);

/**
 * The read queries price from `model_pricing`, not from `deps.pricing`, so the
 * synthetic corpus models need DB rows before a dollar assertion is meaningful.
 */
function seedSyntheticPricing(db: SqliteDatabase): void {
  const insert = db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
  );
  for (const entry of SYNTHETIC_PRICING) {
    insert.run(entry.model, entry.bucket, entry.usdPerMtok, entry.effectiveFrom);
  }
}

function count(temp: TempDb, sql: string, ...params: readonly string[]): number {
  const row = temp.db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

describe('ingestSession (WP-IN9)', () => {
  let temp: TempDb;
  let pricing: readonly PricingEntry[];

  beforeEach(() => {
    temp = createMigratedTempDb();
    pricing = [...loadPricing(temp.db), ...SYNTHETIC_PRICING];
  });

  afterEach(() => {
    temp.cleanup();
  });

  function makeDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
    return {
      db: temp.db,
      pricing,
      instance: 'local',
      hostId: 'test-host',
      projectSlug: 'test-slug',
      now: () => FIXED_NOW,
      ...overrides,
    };
  }

  it.each(FIXTURE_NAMES)('ingests the %s fixture and persists its parsed graph', (name) => {
    const fixture = getFixture(name);
    const expected = parseSession(fixture);

    const outcome = ingestSession(fixture, makeDeps());

    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.sessionId).toBe(expected.sessionId);
    expect(outcome.sessionId).not.toBeNull();
    expect(Number.isFinite(outcome.costUsd)).toBe(true);
    expect(outcome.costUsd as number).toBeGreaterThanOrEqual(0);

    expect(outcome.agentsUpserted).toBe(expected.agents.length);
    expect(outcome.edgesInserted).toBe(expected.edges.length);
    expect(outcome.usageRowsInserted).toBe(expected.usage.length * 5);

    const sid = expected.sessionId;
    expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions WHERE id = ?', sid)).toBe(1);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM agents WHERE session_id = ?', sid)).toBe(
      expected.agents.length,
    );
    expect(
      count(temp, 'SELECT COUNT(*) AS n FROM orchestration_edges WHERE session_id = ?', sid),
    ).toBe(expected.edges.length);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ?', sid)).toBe(
      expected.usage.length * 5,
    );
  });

  it('materializes the self-referential parent for the nested-workflow siblings', () => {
    const fixture = getFixture('nested-workflow');
    const expected = parseSession(fixture);
    ingestSession(fixture, makeDeps());

    for (const agent of expected.agents) {
      const row = temp.db
        .prepare('SELECT parent_agent_id AS parent FROM agents WHERE id = ?')
        .get(agent.id) as { parent: string | null };
      expect(row.parent).toBe(agent.parentAgentId);
    }
  });

  it('is idempotent: replaying the same fixture inserts no new edges or usage rows', () => {
    const fixture = getFixture('nested-workflow');

    const first = ingestSession(fixture, makeDeps());
    expect(first.ok).toBe(true);
    expect(first.edgesInserted).toBeGreaterThan(0);
    expect(first.usageRowsInserted).toBeGreaterThan(0);

    const sessions1 = count(temp, 'SELECT COUNT(*) AS n FROM sessions');
    const agents1 = count(temp, 'SELECT COUNT(*) AS n FROM agents');
    const edges1 = count(temp, 'SELECT COUNT(*) AS n FROM orchestration_edges');
    const usage1 = count(temp, 'SELECT COUNT(*) AS n FROM token_usage');

    const second = ingestSession(fixture, makeDeps());
    expect(second.ok).toBe(true);
    expect(second.edgesInserted).toBe(0);
    expect(second.usageRowsInserted).toBe(0);

    expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions')).toBe(sessions1);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM agents')).toBe(agents1);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM orchestration_edges')).toBe(edges1);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM token_usage')).toBe(usage1);
  });

  it('fans deduped usage into exactly dedupedMessages x 5 bucket rows (cost partition identity)', () => {
    const fixture = getFixture('usage-dedup');
    const dedupedMessages = parseSession(fixture).usage.length;

    const outcome = ingestSession(fixture, makeDeps());
    expect(outcome.ok).toBe(true);

    const total = count(temp, 'SELECT COUNT(*) AS n FROM token_usage');
    expect(total).toBe(dedupedMessages * 5);
    expect(outcome.usageRowsInserted).toBe(dedupedMessages * 5);
  });

  /**
   * The main agent is a materialized node (`agents.id === sessionId`), so its
   * turns must roll up onto it. Persisting them with agent_id NULL made the
   * root node report a permanent $0 while the spend hid in `unattributed`.
   */
  it('attributes main-transcript usage to the main agent node (no permanently-$0 root)', () => {
    seedSyntheticPricing(temp.db);
    const fixture = getFixture('flat-tool-use');
    const expected = parseSession(fixture);
    expect(ingestSession(fixture, makeDeps()).ok).toBe(true);

    const sid = expected.sessionId;
    expect(
      count(
        temp,
        'SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ? AND agent_id IS NULL',
        sid,
      ),
    ).toBe(0);

    const tree = getSessionTree(temp.db, sid);
    const main = tree?.agents.find((agent) => agent.type === 'main');
    expect(main?.id).toBe(sid);
    expect(main?.totalTokens).toBeGreaterThan(0);
    expect(main?.costUsd).toBeGreaterThan(0);
    expect(main?.unpricedTokens).toBe(0);
    expect(tree?.unattributed).toEqual({ totalTokens: 0, costUsd: 0, unpricedTokens: 0 });

    const root = getGlobalDag(temp.db, 50).nodes.find((node) => node.id === sid);
    expect(root?.totalTokens).toBe(main?.totalTokens);
    expect(root?.costUsd).toBeGreaterThan(0);
  });

  it('HALT GATE: empty pricing fails before any write, leaving the database untouched', () => {
    const outcome = ingestSession(getFixture('flat-tool-use'), makeDeps({ pricing: [] }));

    expect(outcome.ok).toBe(false);
    expect(outcome.sessionId).toBeNull();
    expect(outcome.costUsd).toBeNull();
    expect(outcome.error).toBeTruthy();
    expect(outcome.error ?? '').toMatch(/model|pricing/i);

    // Proves cost halts BEFORE the transaction: nothing is committed.
    expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM agents')).toBe(0);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM orchestration_edges')).toBe(0);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM token_usage')).toBe(0);
  });

  it('returns ok:false (never throws) when the substrate has a non-JSON line', () => {
    const substrate = {
      files: [{ relativePath: 'session.jsonl', lines: ['{"ok":true}', 'not json {'] }],
    };

    const outcome = ingestSession(substrate, makeDeps());

    expect(outcome.ok).toBe(false);
    expect(outcome.sessionId).toBeNull();
    expect(outcome.costUsd).toBeNull();
    expect(outcome.error).toBeTruthy();
    expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });

  it('stringifies a non-Error throw and rolls the whole transaction back', () => {
    // The `String(err)` arm of the catch. `deps.now` is the one injectable seam
    // that runs INSIDE the transaction (it stamps every edge), so throwing a
    // bare string from it fails mid-write - after the session and agent rows
    // have already been inserted. Both halves matter: the message survives the
    // non-Error throw, and better-sqlite3 rolls the partial write back.
    const fixture = getFixture('nested-workflow');
    const parsed = parseSession(fixture);
    // Guard: without edges `now()` is never called and this test would be vacuous.
    expect(parsed.edges.length).toBeGreaterThan(0);
    expect(parsed.agents.length).toBeGreaterThan(0);

    const outcome = ingestSession(
      fixture,
      makeDeps({
        now: () => {
          throw 'clock exploded';
        },
      }),
    );

    expect(outcome).toEqual({
      ok: false,
      sessionId: null,
      costUsd: null,
      agentsUpserted: 0,
      edgesInserted: 0,
      usageRowsInserted: 0,
      statusReconciliations: [],
      crossSessionUsageCollisions: 0,
      error: 'clock exploded',
    });

    // The session and agent upserts had already run when `now()` threw; nothing
    // of them survives.
    expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM agents')).toBe(0);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM orchestration_edges')).toBe(0);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM token_usage')).toBe(0);

    // ...and the connection is left usable: a clean replay still succeeds.
    const replay = ingestSession(fixture, makeDeps());
    expect(replay.ok).toBe(true);
    expect(count(temp, 'SELECT COUNT(*) AS n FROM agents')).toBe(parsed.agents.length);
  });

  it('carries a nonzero cost for a fixture with priced tokens', () => {
    const outcome = ingestSession(getFixture('flat-tool-use'), makeDeps());
    expect(outcome.ok).toBe(true);
    // Every synthetic bucket is priced at 1 usd/Mtok, so a corpus with tokens costs > 0.
    expect(outcome.costUsd as number).toBeGreaterThan(0);
  });

  it('defaults the edge clock and project slug when the caller omits them', () => {
    const outcome = ingestSession(
      getFixture('flat-tool-use'),
      makeDeps({ now: undefined, projectSlug: undefined }),
    );
    expect(outcome.ok).toBe(true);

    const session = temp.db
      .prepare('SELECT project_slug AS slug FROM sessions WHERE id = ?')
      .get(outcome.sessionId) as { slug: string | null };
    expect(session.slug).toBeNull();

    // The default wall-clock stamped a parseable ISO timestamp on the edge.
    const edge = temp.db
      .prepare('SELECT created_at AS createdAt FROM orchestration_edges LIMIT 1')
      .get() as { createdAt: string };
    expect(Number.isNaN(Date.parse(edge.createdAt))).toBe(false);
  });

  it('nulls a parent that is not a materialized agent node yet keeps the logical edge', () => {
    // A main-less session whose two subagents directory-join to the session id
    // (never a real agent node): the FK-bearing agents.parent_agent_id must be
    // nulled, while the FK-free orchestration_edges still records the spawn.
    const SESSION = 'no-main-session-uuid';
    const EARLY = 'aaaa1111';
    const LATE = 'bbbb2222';
    const substrate = {
      files: [
        {
          relativePath: `workflows/wf_orphan/agent-${LATE}.jsonl`,
          lines: [
            JSON.stringify({
              sessionId: SESSION,
              agentId: LATE,
              type: 'user',
              timestamp: '2026-05-01T00:00:02.000Z',
              message: { role: 'user', content: 'x' },
            }),
            JSON.stringify({
              sessionId: SESSION,
              agentId: LATE,
              type: 'assistant',
              timestamp: '2026-05-01T00:00:03.000Z',
              message: {
                id: 'm_late',
                model: 'synthetic-model-a',
                content: [{ type: 'text', text: 'x' }],
                usage: { input_tokens: 1 },
              },
            }),
          ],
        },
        {
          relativePath: `workflows/wf_orphan/agent-${EARLY}.jsonl`,
          lines: [
            JSON.stringify({
              sessionId: SESSION,
              agentId: EARLY,
              type: 'user',
              timestamp: '2026-05-01T00:00:00.000Z',
              message: { role: 'user', content: 'x' },
            }),
            JSON.stringify({
              sessionId: SESSION,
              agentId: EARLY,
              type: 'assistant',
              timestamp: '2026-05-01T00:00:01.000Z',
              message: {
                id: 'm_early',
                model: 'synthetic-model-a',
                usage: { input_tokens: 1 },
              },
            }),
          ],
        },
      ],
    };

    const outcome = ingestSession(substrate, makeDeps());
    expect(outcome.ok).toBe(true);
    expect(outcome.sessionId).toBe(SESSION);

    for (const id of [EARLY, LATE]) {
      const agent = temp.db
        .prepare('SELECT parent_agent_id AS parent FROM agents WHERE id = ?')
        .get(id) as { parent: string | null };
      expect(agent.parent).toBeNull();
    }

    // The logical spawn edges survive, anchored to the (non-agent) session id.
    const edges = count(
      temp,
      'SELECT COUNT(*) AS n FROM orchestration_edges WHERE session_id = ? AND parent_agent_id = ?',
      SESSION,
      SESSION,
    );
    expect(edges).toBe(2);

    // With no main agent, started_at derives from the earliest subagent start.
    const session = temp.db
      .prepare('SELECT started_at AS startedAt FROM sessions WHERE id = ?')
      .get(SESSION) as { startedAt: string };
    expect(session.startedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('derives session started_at/last_activity_at across a main-less multi-subagent set', () => {
    // Three main-less subagents with a non-monotonic (start, end) ordering, so the
    // earliest-start / latest-activity folds each see both a new-extreme and a
    // no-change step: started_at = the global min start, last_activity = the global
    // max end, regardless of discovery order.
    const SESSION = 'multi-orphan-session';
    const agent = (id: string, startSec: number, endSec: number) => ({
      relativePath: `workflows/wf_multi/agent-${id}.jsonl`,
      lines: [
        JSON.stringify({
          sessionId: SESSION,
          agentId: id,
          type: 'user',
          timestamp: `2026-06-01T00:00:0${startSec}.000Z`,
          message: { role: 'user', content: 'x' },
        }),
        JSON.stringify({
          sessionId: SESSION,
          agentId: id,
          type: 'assistant',
          timestamp: `2026-06-01T00:00:0${endSec}.000Z`,
          message: {
            id: `m_${id}`,
            model: 'synthetic-model-a',
            usage: { input_tokens: 1 },
          },
        }),
      ],
    });
    // Discovery order (start,end): (2,3) then (0,1) then (1,5).
    const substrate = {
      files: [agent('cccc0001', 2, 3), agent('cccc0002', 0, 1), agent('cccc0003', 1, 5)],
    };

    const outcome = ingestSession(substrate, makeDeps());
    expect(outcome.ok).toBe(true);
    expect(outcome.sessionId).toBe(SESSION);

    const session = temp.db
      .prepare(
        'SELECT started_at AS startedAt, last_activity_at AS lastActivityAt FROM sessions WHERE id = ?',
      )
      .get(SESSION) as { startedAt: string; lastActivityAt: string };
    expect(session.startedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(session.lastActivityAt).toBe('2026-06-01T00:00:05.000Z');
  });

  it('ingests a parent cycle without losing the session or the spawn relation', () => {
    // A cycle is not hypothetical: `resolveParent` anchors a child to whichever
    // transcript OWNS its sidecar's `toolUseId`, and a depth-2 parent block
    // legitimately lives inside a depth-1 agent transcript (parser-spec gate
    // #4). Two sidecars that name each other's block therefore produce
    // A -> B -> A from a structurally well-formed corpus - a corrupted or
    // hand-edited one, but one the parser has no basis to reject.
    //
    // BFS emits nothing for a cycle (neither member is a root), so this is the
    // input that drives `topoOrderAgents`' residual pass. What must hold is
    // that the session survives whole: the self-FK on `agents` would otherwise
    // roll back the entire transaction and lose the main agent and all usage
    // along with the two cyclic nodes.
    const SESSION = 'cyclic-parent-session';
    const A = 'aaaa1111';
    const B = 'bbbb2222';
    const BLOCK_IN_A = 'toolu_cycle_owned_by_a';
    const BLOCK_IN_B = 'toolu_cycle_owned_by_b';

    /** A subagent transcript that materialises one spawn block of its own. */
    const agentFiles = (
      hex: string,
      ownedBlock: string,
      anchorInSibling: string,
    ): Array<{ relativePath: string; lines: string[] }> => [
      {
        relativePath: `subagents/agent-${hex}.jsonl`,
        lines: [
          JSON.stringify({
            parentUuid: null,
            isSidechain: true,
            sessionId: SESSION,
            agentId: hex,
            type: 'assistant',
            timestamp: '2026-06-02T00:00:01.000Z',
            message: {
              id: `m_${hex}`,
              model: 'synthetic-model-a',
              content: [
                {
                  type: 'tool_use',
                  id: ownedBlock,
                  name: 'Agent',
                  input: { prompt: 'synthetic', subagent_type: 'general-purpose' },
                },
              ],
              usage: { input_tokens: 1 },
            },
          }),
        ],
      },
      {
        relativePath: `subagents/agent-${hex}.meta.json`,
        // The anchor points at the block owned by the OTHER subagent.
        lines: [JSON.stringify({ agentType: 'general-purpose', toolUseId: anchorInSibling })],
      },
    ];

    const substrate = {
      files: [
        {
          relativePath: `${SESSION}.jsonl`,
          lines: [
            JSON.stringify({
              parentUuid: null,
              isSidechain: false,
              sessionId: SESSION,
              type: 'assistant',
              timestamp: '2026-06-02T00:00:00.000Z',
              message: {
                id: 'm_main',
                model: 'synthetic-model-a',
                usage: { input_tokens: 1 },
              },
            }),
          ],
        },
        ...agentFiles(A, BLOCK_IN_A, BLOCK_IN_B),
        ...agentFiles(B, BLOCK_IN_B, BLOCK_IN_A),
      ],
    };

    const outcome = ingestSession(substrate, makeDeps());
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.agentsUpserted).toBe(3);

    const parentOf = (id: string): string | null =>
      (
        temp.db.prepare('SELECT parent_agent_id AS parent FROM agents WHERE id = ?').get(id) as {
          parent: string | null;
        }
      ).parent;

    // The cycle is cut at exactly ONE point, not erased: whichever member the
    // residual pass appends first cannot reference a row that does not exist
    // yet and is nulled; the second one finds its parent already inserted and
    // keeps the real link. Nulling both would discard a relation the corpus
    // does state.
    const parents = [parentOf(A), parentOf(B)];
    expect(parents.filter((parent) => parent === null)).toHaveLength(1);
    expect(parents.filter((parent) => parent !== null)).toHaveLength(1);

    // Whatever the self-FK forced, the spawn relation itself is never lost -
    // `orchestration_edges` carries no FK and still states both directions.
    const edges = temp.db
      .prepare(
        'SELECT parent_agent_id AS parent, child_agent_id AS child FROM orchestration_edges WHERE session_id = ? ORDER BY child_agent_id',
      )
      .all(SESSION) as Array<{ parent: string; child: string }>;
    expect(edges).toEqual([
      { parent: B, child: A },
      { parent: A, child: B },
    ]);

    // The main agent and its usage survived the transaction intact: three
    // assistant records, one row per bucket each.
    expect(parentOf(SESSION)).toBeNull();
    expect(count(temp, 'SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ?', SESSION)).toBe(
      3 * BUCKETS.length,
    );
  });
});
