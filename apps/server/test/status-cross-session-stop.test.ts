/**
 * A `SubagentStop` is scoped to the session that delivered it.
 *
 * Hook payloads are untrusted input: the receiver is auth-gated, but a buggy or
 * replayed hook can still deliver a stop whose `session_id` is session A while
 * its `agent_id` names an agent row that belongs to session B. Accepting it
 * would stamp a sticky 'completed' on another session's still-running agent.
 *
 * Both writers are pinned here: the live applier (`applyHookLiveness`) and the
 * M-13 replay (`reconcilePendingSubagentStops`, driven directly and through
 * `projectSession`). The raw hook is still STORED either way (CD-1: `events_raw`
 * is append-only) - only the status projection refuses the stop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentUpsert } from '../src/db/agents';
import { SqliteEventStore } from '../src/db/event-store';
import { applyHookLiveness, reconcilePendingSubagentStops } from '../src/hooks/liveness-status';
import type { NormalizedSession } from '../src/ingest/normalize-session';
import { projectSession } from '../src/ingest/project-session';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

const SESSION_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SESSION_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const AGENT_OF_A = 'a1a1a1a1';
const AGENT_OF_B = 'b2b2b2b2';
const TS = '2026-07-11T00:00:00Z';
const NOW = (): string => '2026-07-11T00:10:00Z';

function normalizedFor(sessionId: string, agents: readonly AgentUpsert[]): NormalizedSession {
  return {
    sessionId,
    session: {
      id: sessionId,
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

function subagentOf(sessionId: string, id: string): AgentUpsert {
  return {
    id,
    sessionId,
    type: 'subagent',
    subagentType: 'explorer',
    status: 'working',
    parentAgentId: null,
    firstSeenAt: TS,
    lastSeenAt: TS,
    outcomeCause: null,
  };
}

describe('SubagentStop is scoped to its own session', () => {
  let temp: TempDb;
  let store: SqliteEventStore;

  beforeEach(() => {
    temp = createMigratedTempDb();
    store = new SqliteEventStore(temp.db);
  });

  afterEach(() => {
    temp.cleanup();
  });

  function appendStop(key: string, sessionId: string, agentId: string): void {
    store.append({
      idempotencyKey: key,
      source: 'hook',
      eventType: 'SubagentStop',
      payload: { hook_event_name: 'SubagentStop', session_id: sessionId, agent_id: agentId },
      receivedAt: '2026-07-11T00:05:00Z',
    });
  }

  function statusOf(id: string): string {
    const row = temp.db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as {
      status: string;
    };
    return row.status;
  }

  function sessionStatusOf(id: string): string {
    const row = temp.db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as {
      status: string;
    };
    return row.status;
  }

  function rawStopCount(): number {
    const row = temp.db
      .prepare("SELECT COUNT(*) AS n FROM events_raw WHERE event_type = 'SubagentStop'")
      .get() as { n: number };
    return row.n;
  }

  describe('live delivery (applyHookLiveness)', () => {
    it("refuses a stop from session A that names session B's agent: B's agent stays working", () => {
      insertSession(temp.db, SESSION_A);
      insertSession(temp.db, SESSION_B);
      insertAgent(temp.db, AGENT_OF_B, SESSION_B);

      const events = applyHookLiveness(temp.db, 'SubagentStop', {
        session_id: SESSION_A,
        agent_id: AGENT_OF_B,
      });

      expect(events).toEqual([]);
      expect(statusOf(AGENT_OF_B)).toBe('working');
    });

    it('refuses a stop that carries no session id: the owner cannot be verified', () => {
      insertSession(temp.db, SESSION_B);
      insertAgent(temp.db, AGENT_OF_B, SESSION_B);

      const events = applyHookLiveness(temp.db, 'SubagentStop', {
        transcript_path: `/corpus/project/subagents/agent-${AGENT_OF_B}.jsonl`,
      });

      expect(events).toEqual([]);
      expect(statusOf(AGENT_OF_B)).toBe('working');
    });

    it('a refused stop never reaches the session mirror: both session rows stay unchanged', () => {
      // The named agent is B's MAIN agent (its id IS B's session uuid), so the
      // session mirror - which runs on every resolved target - WOULD write
      // 'completed' onto B's session row if the refusal came after it. The
      // resolver's own session-id refusal does not fire: the payload names B's
      // main agent from session A, or from no session at all.
      insertSession(temp.db, SESSION_A);
      insertSession(temp.db, SESSION_B);
      temp.db
        .prepare(
          `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id,
                               first_seen_at, last_seen_at)
           VALUES (?, ?, 'main', NULL, 'working', NULL, ?, ?)`,
        )
        .run(SESSION_B, SESSION_B, TS, TS);

      const crossSession = applyHookLiveness(temp.db, 'SubagentStop', {
        session_id: SESSION_A,
        agent_id: SESSION_B,
      });
      const noSession = applyHookLiveness(temp.db, 'SubagentStop', { agent_id: SESSION_B });

      expect(crossSession).toEqual([]);
      expect(noSession).toEqual([]);
      expect(statusOf(SESSION_B)).toBe('working');
      expect(sessionStatusOf(SESSION_A)).toBe('active');
      expect(sessionStatusOf(SESSION_B)).toBe('active');
    });

    it("still marks a same-session subagent 'completed'", () => {
      insertSession(temp.db, SESSION_A);
      insertAgent(temp.db, AGENT_OF_A, SESSION_A);

      const events = applyHookLiveness(temp.db, 'SubagentStop', {
        session_id: SESSION_A,
        agent_id: AGENT_OF_A,
      });

      expect(events).toEqual([
        {
          type: 'agent-status-changed',
          agentId: AGENT_OF_A,
          sessionId: SESSION_A,
          oldStatus: 'working',
          newStatus: 'completed',
        },
      ]);
      expect(statusOf(AGENT_OF_A)).toBe('completed');
    });
  });

  describe('M-13 replay (reconcilePendingSubagentStops)', () => {
    it('does not replay a stored stop from session A onto an agent that later appears under B', () => {
      appendStop('stop-cross', SESSION_A, AGENT_OF_B);

      const counts = projectSession(
        temp.db,
        normalizedFor(SESSION_B, [subagentOf(SESSION_B, AGENT_OF_B)]),
        NOW,
      );

      expect(counts.statusReconciliations).toEqual([]);
      expect(statusOf(AGENT_OF_B)).toBe('working');
      // CD-1: the raw hook is kept, only the projection refused it.
      expect(rawStopCount()).toBe(1);
    });

    it("refuses to replay A's stored stop onto a new agent row owned by B, even when handed it", () => {
      // The projection only ever hands the replay rows it just inserted for its
      // own session; this drives the exported seam directly so the owner check
      // does not rest on that caller discipline alone.
      insertSession(temp.db, SESSION_B);
      insertAgent(temp.db, AGENT_OF_B, SESSION_B);
      appendStop('stop-cross', SESSION_A, AGENT_OF_B);

      const transitions = reconcilePendingSubagentStops(temp.db, SESSION_A, new Set([AGENT_OF_B]));

      expect(transitions).toEqual([]);
      expect(statusOf(AGENT_OF_B)).toBe('working');
      expect(rawStopCount()).toBe(1);
    });

    it('still replays a same-session stored stop onto the agent it names', () => {
      appendStop('stop-same', SESSION_A, AGENT_OF_A);

      const counts = projectSession(
        temp.db,
        normalizedFor(SESSION_A, [subagentOf(SESSION_A, AGENT_OF_A)]),
        NOW,
      );

      expect(counts.statusReconciliations).toHaveLength(1);
      expect(statusOf(AGENT_OF_A)).toBe('completed');
    });
  });
});
