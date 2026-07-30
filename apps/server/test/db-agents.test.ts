import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertAgent } from '../src/db/agents';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

const SESSION_ID = 'session-1';
const ROOT_ID = 'agent-root';
const CHILD_ID = 'agent-child';
const TS = '2026-07-11T00:00:00Z';

interface AgentRow {
  readonly id: string;
  readonly session_id: string;
  readonly type: string;
  readonly subagent_type: string | null;
  readonly status: string;
  readonly parent_agent_id: string | null;
  readonly first_seen_at: string | null;
  readonly last_seen_at: string | null;
}

describe('upsertAgent (WP-D6)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, SESSION_ID);
  });

  afterEach(() => {
    temp.cleanup();
  });

  function readAgent(id: string): AgentRow | undefined {
    return temp.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  }

  it('inserts a root agent and a child pointing at it via parent_agent_id', () => {
    upsertAgent(temp.db, {
      id: ROOT_ID,
      sessionId: SESSION_ID,
      type: 'main',
      subagentType: null,
      status: 'working',
      parentAgentId: null,
      firstSeenAt: TS,
      lastSeenAt: TS,
    });
    upsertAgent(temp.db, {
      id: CHILD_ID,
      sessionId: SESSION_ID,
      type: 'subagent',
      subagentType: 'explorer',
      status: 'working',
      parentAgentId: ROOT_ID,
      firstSeenAt: TS,
      lastSeenAt: TS,
    });

    const root = readAgent(ROOT_ID);
    expect(root).toMatchObject({
      id: ROOT_ID,
      session_id: SESSION_ID,
      type: 'main',
      subagent_type: null,
      status: 'working',
      parent_agent_id: null,
    });

    const child = readAgent(CHILD_ID);
    expect(child).toMatchObject({
      id: CHILD_ID,
      session_id: SESSION_ID,
      type: 'subagent',
      subagent_type: 'explorer',
      parent_agent_id: ROOT_ID,
    });
  });

  it('upserts the same id idempotently, updating status without duplicating', () => {
    upsertAgent(temp.db, {
      id: ROOT_ID,
      sessionId: SESSION_ID,
      type: 'main',
      subagentType: null,
      status: 'working',
      parentAgentId: null,
      firstSeenAt: TS,
      lastSeenAt: TS,
    });
    upsertAgent(temp.db, {
      id: CHILD_ID,
      sessionId: SESSION_ID,
      type: 'subagent',
      subagentType: 'explorer',
      status: 'working',
      parentAgentId: ROOT_ID,
      firstSeenAt: TS,
      lastSeenAt: TS,
    });

    upsertAgent(temp.db, {
      id: CHILD_ID,
      sessionId: SESSION_ID,
      type: 'subagent',
      subagentType: 'explorer',
      status: 'completed',
      parentAgentId: ROOT_ID,
      firstSeenAt: TS,
      lastSeenAt: '2026-07-11T00:05:00Z',
    });

    const count = temp.db
      .prepare('SELECT COUNT(*) AS n FROM agents WHERE id = ?')
      .get(CHILD_ID) as { n: number };
    expect(count.n).toBe(1);

    const child = readAgent(CHILD_ID);
    expect(child?.status).toBe('completed');
    expect(child?.last_seen_at).toBe('2026-07-11T00:05:00Z');
  });

  it('does not overwrite the immutable owning session_id on conflict', () => {
    upsertAgent(temp.db, {
      id: ROOT_ID,
      sessionId: SESSION_ID,
      type: 'main',
      subagentType: null,
      status: 'working',
      parentAgentId: null,
      firstSeenAt: TS,
      lastSeenAt: TS,
    });

    const otherSession = 'session-2';
    insertSession(temp.db, otherSession);
    upsertAgent(temp.db, {
      id: ROOT_ID,
      sessionId: otherSession,
      type: 'main',
      subagentType: null,
      status: 'completed',
      parentAgentId: null,
      firstSeenAt: TS,
      lastSeenAt: TS,
    });

    const root = readAgent(ROOT_ID);
    expect(root?.session_id).toBe(SESSION_ID);
    expect(root?.status).toBe('completed');
  });

  it("throws when parent_agent_id references a non-existent agent (FK - ordering is the caller's job)", () => {
    expect(() =>
      upsertAgent(temp.db, {
        id: CHILD_ID,
        sessionId: SESSION_ID,
        type: 'subagent',
        subagentType: 'explorer',
        status: 'working',
        parentAgentId: 'no-such-parent',
        firstSeenAt: TS,
        lastSeenAt: TS,
      }),
    ).toThrow(/FOREIGN KEY/i);
  });
});
