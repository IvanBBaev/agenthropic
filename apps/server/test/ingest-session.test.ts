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
});
