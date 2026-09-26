/**
 * M-5 (queries half) - getGlobalDag must price ONLY the selected agent set.
 * The pre-fix shape built usage_by_agent from the unfiltered priced CTE
 * regardless of nodeLimit, so the response scaled with corpus size (measured:
 * 432 ms over 752k token_usage rows). Behavioral output is identical by
 * design, so behavior alone cannot distinguish scoped from unscoped - these
 * tests therefore also record the SQL through a pass-through `prepare` spy
 * (getGlobalDag's only database surface) and assert the token_usage scan is
 * bounded by an id list whose size equals the SELECTION, not the corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDag } from '../src/api/queries';
import type { SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, type TempDb } from './helpers';

/** Pass-through spy: every prepared SQL text is recorded, then run for real. */
function recordingDb(real: SqliteDatabase): { spy: SqliteDatabase; statements: string[] } {
  const statements: string[] = [];
  const spy = {
    prepare: (sql: string) => {
      statements.push(sql);
      return real.prepare(sql);
    },
  } as unknown as SqliteDatabase;
  return { spy, statements };
}

/**
 * Same corpus shape as api-dag.test.ts plus adversarial usage rows that the
 * rollup must never attach to any node: a NULL agent_id row and a dangling
 * agent_id naming no agents row (token_usage declares no foreign keys).
 * Pricing seed (migration floor 2026-01-01): claude-fable-5 input $10/Mtok,
 * claude-sonnet-5 output $15/Mtok - the fixture dollars are exact.
 */
function seed(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
      ('s1', 'proj-x', '2026-07-10T00:00:00Z', '2026-07-10T03:00:00Z', 'active'),
      ('s2', 'proj-y', '2026-07-12T00:00:00Z', '2026-07-12T01:00:00Z', 'active');
    INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at) VALUES
      ('g-main', 's1', 'main', NULL, 'working', NULL, '2026-07-10T00:00:00Z', '2026-07-10T03:00:00Z'),
      ('g-sub1', 's1', 'subagent', 'explorer', 'completed', 'g-main', '2026-07-10T00:10:00Z', '2026-07-10T02:00:00Z'),
      ('h-main', 's2', 'main', NULL, 'completed', NULL, '2026-07-12T00:00:00Z', '2026-07-12T01:00:00Z'),
      ('h-sub1', 's2', 'subagent', 'planner', 'completed', 'h-main', '2026-07-12T00:10:00Z', '2026-07-12T00:30:00Z');
    INSERT INTO orchestration_edges (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at) VALUES
      ('s1', 'g-main', 'g-sub1', 'tool_use', 'default', 'host-1', '2026-07-10T00:10:00Z'),
      ('s2', 'h-main', 'h-sub1', 'queue_operation', 'default', 'host-1', '2026-07-12T00:10:00Z');
    INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
      ('s2', 'h-sub1', 'm1', 'claude-sonnet-5', 'output', 200000, 0, '2026-07-12T00:20:00Z'),
      ('s2', 'h-main', 'm2', 'future-model-x', 'input', 5000, 0, '2026-07-12T00:40:00Z'),
      ('s1', 'g-sub1', 'm3', 'claude-fable-5', 'input', 1000000, 0, '2026-07-10T01:00:00Z'),
      ('s1', NULL, 'm4', 'claude-fable-5', 'input', 70000, 0, '2026-07-10T01:30:00Z'),
      ('s1', 'ghost-agent', 'm5', 'claude-fable-5', 'input', 80000, 0, '2026-07-10T01:45:00Z');
  `);
}

describe('getGlobalDag rollup scoping (M-5)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('an uncapped read returns the full payload with adversarial rows on no node', () => {
    seed(temp.db);
    const dag = getGlobalDag(temp.db, 100);

    expect(dag.nodes.map((n) => n.id)).toEqual(['h-main', 'h-sub1', 'g-main', 'g-sub1']);
    const byId = new Map(dag.nodes.map((n) => [n.id, n]));
    expect(byId.get('g-sub1')).toMatchObject({ totalTokens: 1_000_000, unpricedTokens: 0 });
    expect(byId.get('g-sub1')?.costUsd).toBeCloseTo(10, 9);
    expect(byId.get('h-sub1')).toMatchObject({ totalTokens: 200_000, unpricedTokens: 0 });
    // 200k sonnet-5 output at $10/Mtok (migration 20) = $2.
    expect(byId.get('h-sub1')?.costUsd).toBeCloseTo(2, 9);
    // Unknown model: tokens surface as unpriced, never silently priced.
    expect(byId.get('h-main')).toMatchObject({
      totalTokens: 5000,
      costUsd: 0,
      unpricedTokens: 5000,
    });
    expect(byId.get('g-main')).toMatchObject({ totalTokens: 0, costUsd: 0, unpricedTokens: 0 });
    // The NULL-agent (70k) and dangling-agent (80k) rows land on NO node.
    const nodeTokenSum = dag.nodes.reduce((sum, n) => sum + n.totalTokens, 0);
    expect(nodeTokenSum).toBe(1_205_000);

    expect(dag.edges.map((e) => e.source)).toEqual(['tool_use', 'queue_operation']);
    expect(dag.counts).toEqual({
      totalSessions: 2,
      totalAgents: 4,
      totalEdges: 2,
      returnedAgents: 4,
      returnedEdges: 2,
      truncated: false,
    });
  });

  it('a capped read keeps the payload identical AND provably scopes every scan', () => {
    seed(temp.db);
    const { spy, statements } = recordingDb(temp.db);
    const dag = getGlobalDag(spy, 2);

    // Payload: same content the pre-fix shape produced for limit=2.
    expect(dag.nodes.map((n) => n.id)).toEqual(['h-main', 'h-sub1']);
    expect(dag.edges.map((e) => e.source)).toEqual(['queue_operation']);
    expect(dag.counts).toEqual({
      totalSessions: 2,
      totalAgents: 4,
      totalEdges: 2,
      returnedAgents: 2,
      returnedEdges: 1,
      truncated: true,
    });

    // Scoping proof: exactly ONE statement scans token_usage, and its WHERE
    // binds an id list of the SELECTION size (2 placeholders), not the corpus.
    const usageScans = statements.filter((sql) => sql.includes('FROM token_usage'));
    expect(usageScans).toHaveLength(1);
    expect(usageScans[0]).toMatch(/FROM token_usage tu\s+WHERE tu\.agent_id IN \(\?, \?\)/);
    // No unconditional rollup remains: the scan is never left unfiltered.
    expect(usageScans[0]).not.toMatch(/FROM token_usage tu\s*\)/);

    // The edge scan binds the SAME resolved id list on both endpoints instead
    // of re-deriving the selection - membership cannot diverge from nodes.
    const edgeScans = statements.filter(
      (sql) => sql.includes('FROM orchestration_edges') && !sql.includes('COUNT'),
    );
    expect(edgeScans).toHaveLength(1);
    expect(edgeScans[0]).toContain('parent_agent_id IN (?, ?)');
    expect(edgeScans[0]).toContain('child_agent_id IN (?, ?)');
  });

  it('a virgin database yields the empty shape without ever touching token_usage', () => {
    const { spy, statements } = recordingDb(temp.db);
    const dag = getGlobalDag(spy, 100);

    expect(dag).toEqual({
      nodes: [],
      edges: [],
      counts: {
        totalSessions: 0,
        totalAgents: 0,
        totalEdges: 0,
        returnedAgents: 0,
        returnedEdges: 0,
        truncated: false,
      },
    });
    expect(statements.filter((sql) => sql.includes('FROM token_usage'))).toHaveLength(0);
  });

  it('nodeLimit 0 over a populated corpus reports honest truncation, not emptiness', () => {
    seed(temp.db);
    const dag = getGlobalDag(temp.db, 0);

    expect(dag.nodes).toEqual([]);
    expect(dag.edges).toEqual([]);
    expect(dag.counts).toEqual({
      totalSessions: 2,
      totalAgents: 4,
      totalEdges: 2,
      returnedAgents: 0,
      returnedEdges: 0,
      truncated: true,
    });
  });

  it('caps edges on both endpoints but serves parentAgentId as persisted, cap or not (F4)', () => {
    seed(temp.db);
    // A third session whose main agent is OLDER (by last_seen_at) than its own
    // subagents, so a recent-first cap of 2 keeps the children and drops the
    // parent: k-sub1 (02:00) and k-sub2 (01:00) make it, k-main (00:30) does not.
    temp.db.exec(`
      INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
        ('s3', 'proj-z', '2026-07-14T00:00:00Z', '2026-07-14T02:00:00Z', 'active');
      INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at) VALUES
        ('k-main', 's3', 'main', NULL, 'working', NULL, '2026-07-14T00:00:00Z', '2026-07-14T00:30:00Z'),
        ('k-sub1', 's3', 'subagent', 'explorer', 'working', 'k-main', '2026-07-14T00:10:00Z', '2026-07-14T02:00:00Z'),
        ('k-sub2', 's3', 'subagent', 'planner', 'completed', 'k-sub1', '2026-07-14T00:20:00Z', '2026-07-14T01:00:00Z');
      INSERT INTO orchestration_edges (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at) VALUES
        ('s3', 'k-main', 'k-sub1', 'tool_use', 'default', 'host-1', '2026-07-14T00:10:00Z'),
        ('s3', 'k-sub1', 'k-sub2', 'tool_use', 'default', 'host-1', '2026-07-14T00:20:00Z');
    `);

    const dag = getGlobalDag(temp.db, 2);

    expect(dag.nodes.map((n) => n.id)).toEqual(['k-sub1', 'k-sub2']);
    const nodeIds = new Set(dag.nodes.map((n) => n.id));
    // `parentAgentId` is the persisted data fact, NOT subject to the cap: the
    // tree is a data fact, not a UI reconstruction, so the client is told the
    // real parent even when that parent is not in this slice.
    const parentsOutsideCap = dag.nodes
      .filter((n) => n.parentAgentId !== null && !nodeIds.has(n.parentAgentId))
      .map((n) => [n.id, n.parentAgentId]);
    expect(parentsOutsideCap).toEqual([['k-sub1', 'k-main']]);
    // Edges, by contrast, are capped on BOTH endpoints: the k-main -> k-sub1
    // edge is dropped, the k-sub1 -> k-sub2 edge is kept.
    expect(dag.edges).toHaveLength(1);
    expect(dag.edges[0]).toMatchObject({ parentAgentId: 'k-sub1', childAgentId: 'k-sub2' });
    for (const edge of dag.edges) {
      expect(nodeIds.has(edge.parentAgentId)).toBe(true);
      expect(nodeIds.has(edge.childAgentId)).toBe(true);
    }
    expect(dag.counts).toEqual({
      totalSessions: 3,
      totalAgents: 7,
      totalEdges: 4,
      returnedAgents: 2,
      returnedEdges: 1,
      truncated: true,
    });
  });
});
