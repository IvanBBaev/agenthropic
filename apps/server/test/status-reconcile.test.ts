/**
 * M-13 — SubagentStop verdicts stored BEFORE the agent row exists are replayed
 * when the row is first inserted, so a subagent faster than one poll interval
 * still ends 'completed' instead of aging into 'unknown'.
 *
 * The scenario, end to end: the hook receiver stores the stop as raw liveness
 * (CD-1 — it changes no row, the agent has none yet), the next ingest tick
 * parses the transcript and inserts the row, and the projection replays the
 * stored verdict inside the same transaction. Everything here drives that
 * boundary: `projectSession` + the real `SqliteEventStore`, no mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentUpsert } from '../src/db/agents';
import { SqliteEventStore } from '../src/db/event-store';
import { reconcilePendingSubagentStops } from '../src/hooks/liveness-status';
import type { NormalizedSession } from '../src/ingest/normalize-session';
import { projectSession } from '../src/ingest/project-session';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SUB_ID = '3fa9c2d1';
const TS = '2026-07-11T00:00:00Z';
const NOW = (): string => '2026-07-11T00:10:00Z';

const MAIN_AGENT: AgentUpsert = {
  id: SESSION_ID, // the main agent's id IS the session uuid (parse-session.ts)
  sessionId: SESSION_ID,
  type: 'main',
  subagentType: null,
  status: 'working',
  parentAgentId: null,
  firstSeenAt: TS,
  lastSeenAt: TS,
};

const SUB_AGENT: AgentUpsert = {
  id: SUB_ID,
  sessionId: SESSION_ID,
  type: 'subagent',
  subagentType: 'explorer',
  status: 'working',
  parentAgentId: SESSION_ID,
  firstSeenAt: TS,
  lastSeenAt: TS,
};

function normalizedWith(agents: readonly AgentUpsert[]): NormalizedSession {
  return {
    sessionId: SESSION_ID,
    session: {
      id: SESSION_ID,
      projectSlug: 'test-slug',
      startedAt: TS,
      lastActivityAt: TS,
      status: 'active',
    },
    agents,
    edges: [],
    usage: [],
  };
}

describe('reconcilePendingSubagentStops (M-13 hook-before-row replay)', () => {
  let temp: TempDb;
  let store: SqliteEventStore;

  beforeEach(() => {
    temp = createMigratedTempDb();
    store = new SqliteEventStore(temp.db);
  });

  afterEach(() => {
    temp.cleanup();
  });

  function appendHook(key: string, eventType: string, payload: unknown): void {
    store.append({
      idempotencyKey: key,
      source: 'hook',
      eventType,
      payload,
      receivedAt: '2026-07-11T00:05:00Z',
    });
  }

  function statusOf(table: 'agents' | 'sessions', id: string): string {
    const row = temp.db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as {
      status: string;
    };
    return row.status;
  }

  it('replays a stop stored before the row existed: the fast subagent commits completed', () => {
    appendHook('stop-1', 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: SESSION_ID,
      agent_id: SUB_ID,
    });

    const counts = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);

    expect(counts.statusReconciliations).toEqual([
      {
        type: 'agent-status-changed',
        agentId: SUB_ID,
        sessionId: SESSION_ID,
        oldStatus: 'working',
        newStatus: 'completed',
      },
    ]);
    expect(statusOf('agents', SUB_ID)).toBe('completed');
    // A subagent stopping says nothing about its parent: main agent and
    // session are untouched.
    expect(statusOf('agents', SESSION_ID)).toBe('working');
    expect(statusOf('sessions', SESSION_ID)).toBe('active');
  });

  it('resolves the target from transcript_path when the payload carries no agent_id', () => {
    appendHook('stop-path', 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: SESSION_ID,
      transcript_path: `/corpus/project/subagents/agent-${SUB_ID}.jsonl`,
    });

    const counts = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);

    expect(counts.statusReconciliations).toHaveLength(1);
    expect(statusOf('agents', SUB_ID)).toBe('completed');
  });

  it('reconciles nothing on a replay of the same session, and the verdict stays sticky', () => {
    appendHook('stop-1', 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: SESSION_ID,
      agent_id: SUB_ID,
    });
    projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);

    // Same substrate again: no agent is a first sighting, so nothing replays —
    // and the terminal from the first pass survives the re-upsert.
    const replay = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);

    expect(replay.statusReconciliations).toEqual([]);
    expect(statusOf('agents', SUB_ID)).toBe('completed');
  });

  it('does not reconcile a hook that arrived AFTER the row (the live path owns it)', () => {
    const first = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);
    expect(first.statusReconciliations).toEqual([]);

    appendHook('stop-late', 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: SESSION_ID,
      agent_id: SUB_ID,
    });

    // The next ingest tick inserts no new agents, so the projection stays out
    // of it — applying live deliveries is applyHookLiveness's job, and a
    // second writer would make status transitions unaccountable.
    const second = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);
    expect(second.statusReconciliations).toEqual([]);
    expect(statusOf('agents', SUB_ID)).toBe('working');
  });

  it('skips a stored stop naming an agent that is not among the new inserts', () => {
    insertSession(temp.db, SESSION_ID);
    insertAgent(temp.db, SUB_ID, SESSION_ID, null, 'working');
    appendHook('stop-existing', 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: SESSION_ID,
      agent_id: SUB_ID,
    });

    // MAIN_AGENT is the only first sighting; the stop names SUB_ID, whose row
    // already existed, so the replay must leave it alone.
    const counts = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);

    expect(counts.statusReconciliations).toEqual([]);
    expect(statusOf('agents', SUB_ID)).toBe('working');
  });

  it('skips a malformed stored payload without failing the ingest tick', () => {
    // Nothing appends invalid JSON through the port (it stringifies), but
    // events_raw carries no such CHECK — simulate a damaged row directly.
    const raw = temp.db
      .prepare(
        `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
         VALUES ('raw-damaged', 'hook', 'SubagentStop', 'not-json{{{', ?)`,
      )
      .run(TS);
    temp.db
      .prepare(
        `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
         VALUES (?, ?, ?, 'SubagentStop', ?)`,
      )
      .run(raw.lastInsertRowid, SESSION_ID, SUB_ID, TS);
    // A healthy stop alongside it: the damaged row must not shadow the replay.
    appendHook('stop-healthy', 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: SESSION_ID,
      agent_id: SUB_ID,
    });

    const counts = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);

    expect(counts.statusReconciliations).toHaveLength(1);
    expect(statusOf('agents', SUB_ID)).toBe('completed');
  });

  it('skips a stored stop whose payload names no agent at all', () => {
    appendHook('stop-anonymous', 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: SESSION_ID,
    });

    const counts = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);

    expect(counts.statusReconciliations).toEqual([]);
    expect(statusOf('agents', SUB_ID)).toBe('working');
  });

  it("never replays 'Stop' rows — a recurring idle verdict is not a terminal", () => {
    appendHook('main-stop', 'Stop', {
      hook_event_name: 'Stop',
      session_id: SESSION_ID,
    });

    const counts = projectSession(temp.db, normalizedWith([MAIN_AGENT]), NOW);

    expect(counts.statusReconciliations).toEqual([]);
    expect(statusOf('agents', SESSION_ID)).toBe('working');
  });

  it('collapses duplicate stored stops for one agent into exactly one transition', () => {
    // Two distinct deliveries (different idempotency keys) of the same stop.
    for (const key of ['stop-dup-1', 'stop-dup-2']) {
      appendHook(key, 'SubagentStop', {
        hook_event_name: 'SubagentStop',
        session_id: SESSION_ID,
        agent_id: SUB_ID,
        delivery: key,
      });
    }

    const counts = projectSession(temp.db, normalizedWith([MAIN_AGENT, SUB_AGENT]), NOW);

    expect(counts.statusReconciliations).toHaveLength(1);
    expect(statusOf('agents', SUB_ID)).toBe('completed');
  });

  it('mirrors the session row when a stored stop targets the MAIN agent (live-path parity)', () => {
    appendHook('stop-main-target', 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: SESSION_ID,
      agent_id: SESSION_ID,
    });

    const counts = projectSession(temp.db, normalizedWith([MAIN_AGENT]), NOW);

    expect(counts.statusReconciliations).toHaveLength(1);
    expect(statusOf('agents', SESSION_ID)).toBe('completed');
    // Same rule as applyHookLiveness: a main-agent terminal mirrors onto the
    // session so the two can never drift.
    expect(statusOf('sessions', SESSION_ID)).toBe('completed');
  });

  describe('direct calls', () => {
    it('an empty newAgentIds set reconciles nothing', () => {
      expect(reconcilePendingSubagentStops(temp.db, SESSION_ID, new Set())).toEqual([]);
    });

    it('a second pass over the same stored rows is a no-op', () => {
      insertSession(temp.db, SESSION_ID);
      insertAgent(temp.db, SUB_ID, SESSION_ID, null, 'working');
      appendHook('stop-once', 'SubagentStop', {
        hook_event_name: 'SubagentStop',
        session_id: SESSION_ID,
        agent_id: SUB_ID,
      });
      const ids = new Set([SUB_ID]);

      expect(reconcilePendingSubagentStops(temp.db, SESSION_ID, ids)).toHaveLength(1);
      expect(reconcilePendingSubagentStops(temp.db, SESSION_ID, ids)).toEqual([]);
      expect(statusOf('agents', SUB_ID)).toBe('completed');
    });
  });
});
