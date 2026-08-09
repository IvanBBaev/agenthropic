/**
 * WP-IN6 — the pure Normalizer.
 *
 * The whole point of this file is what it does NOT need: there is no database
 * here, no clock, no filesystem, no temp directory, no migration. If any of
 * those ever becomes necessary to test this module, the seam has been lost and
 * `normalize-session.ts` is no longer pure.
 *
 * So the assertions are about DECISIONS rather than about rows: which agent may
 * be inserted before which (the `agents.parent_agent_id` self-FK makes that a
 * correctness question, not a style one), which parent has to be dropped to keep
 * a pathological corpus from rolling back an entire session, and what the
 * session's own span is. Before the split these could only be observed by
 * writing to SQLite and reading back.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedAgent, ParsedEdge, ParsedSession } from '@agenthropic/core';
import {
  LIVENESS_STATUS,
  normalizeSession,
  type NormalizeOptions,
} from '../src/ingest/normalize-session';

const SESSION = 'ssssssss-0000-4000-8000-000000000000';
const OPTIONS: NormalizeOptions = {
  projectSlug: '-Users-synthetic-project',
  instance: 'test-instance',
  hostId: 'test-host',
};

function agent(id: string, overrides: Partial<ParsedAgent> = {}): ParsedAgent {
  return {
    id,
    type: 'subagent',
    subagentType: 'general-purpose',
    parentAgentId: null,
    startedAt: '2026-07-11T10:00:00.000Z',
    endedAt: '2026-07-11T10:00:05.000Z',
    ...overrides,
  };
}

function edge(parentAgentId: string, childAgentId: string): ParsedEdge {
  return {
    sessionId: SESSION,
    parentAgentId,
    childAgentId,
    source: 'tool_use',
    toolUseId: `tu-${childAgentId}`,
  };
}

function parsed(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return { sessionId: SESSION, agents: [], edges: [], usage: [], ...overrides };
}

describe('normalizeSession', () => {
  it('is deterministic and does not mutate its input', () => {
    const input = parsed({
      agents: [
        agent(SESSION, { type: 'main', subagentType: null }),
        agent('a1', { parentAgentId: SESSION }),
      ],
      edges: [edge(SESSION, 'a1')],
    });
    const snapshot = structuredClone(input);

    const first = normalizeSession(input, OPTIONS);
    const second = normalizeSession(input, OPTIONS);

    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
  });

  describe('insertion order (the agents self-FK)', () => {
    it('emits a depth-3 chain parent-first even when the input is reversed', () => {
      const result = normalizeSession(
        parsed({
          agents: [
            agent('grandchild', { parentAgentId: 'child' }),
            agent('child', { parentAgentId: SESSION }),
            agent(SESSION, { type: 'main', subagentType: null }),
          ],
        }),
        OPTIONS,
      );

      expect(result.agents.map((a) => a.id)).toEqual([SESSION, 'child', 'grandchild']);
      // Every referenced parent appears strictly earlier — the property the
      // self-FK actually requires.
      const seen = new Set<string>();
      for (const a of result.agents) {
        if (a.parentAgentId !== null) {
          expect(seen.has(a.parentAgentId)).toBe(true);
        }
        seen.add(a.id);
      }
    });

    it('nulls the parent of an orphan whose parent is not a materialized agent', () => {
      const result = normalizeSession(
        parsed({ agents: [agent('orphan', { parentAgentId: 'never-materialized' })] }),
        OPTIONS,
      );

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]?.parentAgentId).toBeNull();
    });

    it('breaks a parent cycle without losing either agent or either relation', () => {
      // A -> B -> A. The parser can produce this from a corpus it has no basis
      // to reject (two sidecars naming each other's tool_use block).
      const result = normalizeSession(
        parsed({
          agents: [agent('A', { parentAgentId: 'B' }), agent('B', { parentAgentId: 'A' })],
          edges: [edge('B', 'A'), edge('A', 'B')],
        }),
        OPTIONS,
      );

      // Neither is dropped: dropping one would make the other's FK fail and
      // roll back the whole session.
      expect(result.agents.map((a) => a.id).sort()).toEqual(['A', 'B']);
      // Exactly one parent is cut — the one not yet inserted.
      expect(result.agents.filter((a) => a.parentAgentId === null)).toHaveLength(1);
      expect(result.agents.filter((a) => a.parentAgentId !== null)).toHaveLength(1);
      // And the cut relation is NOT lost: orchestration_edges carries no FK.
      expect(result.edges).toHaveLength(2);
      expect(result.edges.map((e) => `${e.parentAgentId}->${e.childAgentId}`).sort()).toEqual([
        'A->B',
        'B->A',
      ]);
    });

    it('emits a repeated agent id exactly once', () => {
      // `parseSession` cannot produce this — `collectAgentFiles` throws
      // SubstrateError when two agent files share a hex. But `normalizeSession`
      // is pure and exported: its contract is "any ParsedSession", so the
      // dedupe in the BFS is live code here even though the parser upstream
      // never triggers it. Emitting the duplicate would write the same agents
      // row twice inside one transaction.
      const result = normalizeSession(
        parsed({
          agents: [
            agent('root'),
            agent('dup', { parentAgentId: 'root' }),
            agent('dup', { parentAgentId: 'root', subagentType: 'Explore' }),
          ],
        }),
        OPTIONS,
      );

      expect(result.agents.map((a) => a.id)).toEqual(['root', 'dup']);
      // First occurrence wins; the BFS never revisits an emitted id.
      expect(result.agents[1]?.subagentType).toBe('general-purpose');
    });
  });

  describe('the session row', () => {
    it('anchors startedAt on the main agent, not on the earliest subagent', () => {
      const result = normalizeSession(
        parsed({
          agents: [
            agent('early', { startedAt: '2026-07-11T09:00:00.000Z' }),
            agent(SESSION, {
              type: 'main',
              subagentType: null,
              startedAt: '2026-07-11T10:00:00.000Z',
            }),
          ],
        }),
        OPTIONS,
      );

      expect(result.session.startedAt).toBe('2026-07-11T10:00:00.000Z');
    });

    it('falls back to the earliest agent when the session has no main transcript', () => {
      const result = normalizeSession(
        parsed({
          agents: [
            agent('later', { startedAt: '2026-07-11T11:00:00.000Z' }),
            agent('earliest', { startedAt: '2026-07-11T09:00:00.000Z' }),
          ],
        }),
        OPTIONS,
      );

      expect(result.session.startedAt).toBe('2026-07-11T09:00:00.000Z');
    });

    it('takes lastActivityAt from the latest agent activity', () => {
      const result = normalizeSession(
        parsed({
          agents: [
            agent('a', { endedAt: '2026-07-11T10:00:05.000Z' }),
            agent('b', { endedAt: '2026-07-11T12:30:00.000Z' }),
            agent('c', { endedAt: '2026-07-11T11:00:00.000Z' }),
          ],
        }),
        OPTIONS,
      );

      expect(result.session.lastActivityAt).toBe('2026-07-11T12:30:00.000Z');
    });

    it('leaves both timestamps null for a session with no agents', () => {
      const result = normalizeSession(parsed(), OPTIONS);

      expect(result.session.startedAt).toBeNull();
      expect(result.session.lastActivityAt).toBeNull();
      expect(result.agents).toEqual([]);
    });

    it('never concludes an ending — every status is the liveness status', () => {
      const result = normalizeSession(
        parsed({
          agents: [agent(SESSION, { type: 'main', subagentType: null }), agent('a1')],
        }),
        OPTIONS,
      );

      expect(LIVENESS_STATUS).toBe('working');
      expect(result.session.status).toBe(LIVENESS_STATUS);
      for (const a of result.agents) {
        expect(a.status).toBe(LIVENESS_STATUS);
      }
    });
  });

  it('stamps edges with the caller identity and leaves created_at to the projection', () => {
    const result = normalizeSession(
      parsed({
        agents: [agent(SESSION, { type: 'main', subagentType: null }), agent('a1')],
        edges: [edge(SESSION, 'a1')],
      }),
      OPTIONS,
    );

    expect(result.edges).toEqual([
      {
        sessionId: SESSION,
        parentAgentId: SESSION,
        childAgentId: 'a1',
        source: 'tool_use',
        instance: 'test-instance',
        hostId: 'test-host',
      },
    ]);
    // No clock reading anywhere in the pure half.
    expect(Object.keys(result.edges[0] ?? {})).not.toContain('createdAt');
  });

  it('passes deduped usage through untouched', () => {
    const usage = [
      {
        messageId: 'msg-1',
        model: 'synthetic-model-a',
        timestamp: '2026-07-11T10:00:01.000Z',
        agentId: null,
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      },
    ];
    const result = normalizeSession(parsed({ usage }), OPTIONS);

    expect(result.usage).toEqual(usage);
  });

  it('carries the project slug and session id onto the session row', () => {
    const result = normalizeSession(parsed(), { ...OPTIONS, projectSlug: null });

    expect(result.sessionId).toBe(SESSION);
    expect(result.session.id).toBe(SESSION);
    expect(result.session.projectSlug).toBeNull();
  });
});
