import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileAgentStatus, upsertAgent } from '../src/db/agents';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

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
    // First sightings report inserted: true — the signal the M-13 replay keys on.
    expect(
      upsertAgent(temp.db, {
        id: ROOT_ID,
        sessionId: SESSION_ID,
        type: 'main',
        subagentType: null,
        status: 'working',
        parentAgentId: null,
        firstSeenAt: TS,
        lastSeenAt: TS,
        outcomeCause: null,
      }),
    ).toEqual({ inserted: true });
    expect(
      upsertAgent(temp.db, {
        id: CHILD_ID,
        sessionId: SESSION_ID,
        type: 'subagent',
        subagentType: 'explorer',
        status: 'working',
        parentAgentId: ROOT_ID,
        firstSeenAt: TS,
        lastSeenAt: TS,
        outcomeCause: null,
      }),
    ).toEqual({ inserted: true });

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
      outcomeCause: null,
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
      outcomeCause: null,
    });

    // A re-upsert of an existing row is NOT a first sighting.
    expect(
      upsertAgent(temp.db, {
        id: CHILD_ID,
        sessionId: SESSION_ID,
        type: 'subagent',
        subagentType: 'explorer',
        status: 'completed',
        parentAgentId: ROOT_ID,
        firstSeenAt: TS,
        lastSeenAt: '2026-07-11T00:05:00Z',
        outcomeCause: null,
      }),
    ).toEqual({ inserted: false });

    const count = temp.db
      .prepare('SELECT COUNT(*) AS n FROM agents WHERE id = ?')
      .get(CHILD_ID) as { n: number };
    expect(count.n).toBe(1);

    const child = readAgent(CHILD_ID);
    expect(child?.status).toBe('completed');
    expect(child?.last_seen_at).toBe('2026-07-11T00:05:00Z');
  });

  it("never lets fresh liveness un-fail a sticky 'error' row", () => {
    // The `'error'` arm of AGENT_STATUS_CASE, pinned. It is the ONLY thing
    // standing between a failed agent and a silent recovery, and the sequence
    // that would cause one is ordinary rather than exotic: the parent
    // transcript is compacted, the errored `tool_result` scrolls out of the
    // retained window, the next re-ingest observes no outcome at all, and
    // `statusForOutcome(null)` therefore returns liveness. `last_seen_at` has
    // advanced meanwhile, so every condition of the "inferred states yield to
    // fresh evidence" arm below it is satisfied. Absence of the evidence is
    // not evidence of recovery — a terminal that was OBSERVED outranks a
    // later reading that merely failed to observe it again.
    insertAgent(temp.db, ROOT_ID, SESSION_ID);
    upsertAgent(temp.db, {
      id: CHILD_ID,
      sessionId: SESSION_ID,
      type: 'subagent',
      subagentType: 'general-purpose',
      status: 'error',
      parentAgentId: ROOT_ID,
      firstSeenAt: TS,
      lastSeenAt: TS,
      outcomeCause: 'terminated_early',
    });
    expect(readAgent(CHILD_ID)?.status).toBe('error');

    upsertAgent(temp.db, {
      id: CHILD_ID,
      sessionId: SESSION_ID,
      type: 'subagent',
      subagentType: 'general-purpose',
      status: 'working',
      parentAgentId: ROOT_ID,
      firstSeenAt: TS,
      lastSeenAt: '2026-07-11T00:09:00Z',
      outcomeCause: null,
    });

    const errored = readAgent(CHILD_ID);
    expect(errored?.status).toBe('error');
    // The replay is not ignored — it is only barred from the status column.
    expect(errored?.last_seen_at).toBe('2026-07-11T00:09:00Z');
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
      outcomeCause: null,
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
      outcomeCause: null,
    });

    const root = readAgent(ROOT_ID);
    expect(root?.session_id).toBe(SESSION_ID);
    // Incidental to this test's subject, but worth pinning: the second upsert
    // did NOT advance last_seen_at, so it carries no new evidence and the
    // status CASE leaves the row alone. The status rule itself is covered in
    // test/status-lifecycle.test.ts.
    expect(root?.status).toBe('working');
  });

  it('applies a status only when last_seen_at strictly advances', () => {
    const seed = {
      id: ROOT_ID,
      sessionId: SESSION_ID,
      type: 'main',
      subagentType: null,
      parentAgentId: null,
      firstSeenAt: TS,
      outcomeCause: null,
    } as const;
    upsertAgent(temp.db, { ...seed, status: 'working', lastSeenAt: TS });

    // Same anchor: nothing new happened, so nothing moves.
    upsertAgent(temp.db, { ...seed, status: 'waiting', lastSeenAt: TS });
    expect(readAgent(ROOT_ID)?.status).toBe('working');

    // Anchor moved backwards (a truncated / rewritten tail): still no advance.
    upsertAgent(temp.db, { ...seed, status: 'waiting', lastSeenAt: '2026-07-10T00:00:00Z' });
    expect(readAgent(ROOT_ID)?.status).toBe('working');

    // A NULL anchor cannot prove an advance either.
    upsertAgent(temp.db, { ...seed, status: 'waiting', lastSeenAt: null });
    expect(readAgent(ROOT_ID)?.status).toBe('working');
  });

  it('adopts the incoming status when the existing status is NULL', () => {
    // The column is nullable, and rows predating the lifecycle can hold NULL;
    // any evidence beats none.
    temp.db
      .prepare(
        `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id,
                             first_seen_at, last_seen_at)
         VALUES (?, ?, 'main', NULL, NULL, NULL, ?, ?)`,
      )
      .run(ROOT_ID, SESSION_ID, TS, TS);

    upsertAgent(temp.db, {
      id: ROOT_ID,
      sessionId: SESSION_ID,
      type: 'main',
      subagentType: null,
      status: 'working',
      parentAgentId: null,
      firstSeenAt: TS,
      lastSeenAt: TS,
      outcomeCause: null,
    });

    expect(readAgent(ROOT_ID)?.status).toBe('working');
  });

  describe('parent_agent_id on re-parse', () => {
    const OTHER_PARENT = 'agent-other-parent';

    function upsertChild(parentAgentId: string | null): void {
      upsertAgent(temp.db, {
        id: CHILD_ID,
        sessionId: SESSION_ID,
        type: 'subagent',
        subagentType: 'explorer',
        status: 'working',
        parentAgentId,
        firstSeenAt: TS,
        lastSeenAt: TS,
        outcomeCause: null,
      });
    }

    beforeEach(() => {
      insertAgent(temp.db, ROOT_ID, SESSION_ID);
      insertAgent(temp.db, OTHER_PARENT, SESSION_ID);
    });

    it('keeps a known parent when a later pass resolves none (null is absence of evidence)', () => {
      upsertChild(ROOT_ID);
      upsertChild(null);

      expect(readAgent(CHILD_ID)?.parent_agent_id).toBe(ROOT_ID);
    });

    it('still applies a legitimate correction to a different non-null parent', () => {
      upsertChild(ROOT_ID);
      upsertChild(OTHER_PARENT);

      expect(readAgent(CHILD_ID)?.parent_agent_id).toBe(OTHER_PARENT);
    });

    it('adopts a parent once one is resolved for a row first stored as a root', () => {
      upsertChild(null);
      upsertChild(ROOT_ID);

      expect(readAgent(CHILD_ID)?.parent_agent_id).toBe(ROOT_ID);
    });
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
        outcomeCause: null,
      }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('reconcileAgentStatus (M-13 replay primitive)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, SESSION_ID);
  });

  afterEach(() => {
    temp.cleanup();
  });

  function statusOf(id: string): string {
    const row = temp.db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as {
      status: string;
    };
    return row.status;
  }

  it("moves a non-terminal row and reports the transition ('working' -> 'completed')", () => {
    insertAgent(temp.db, CHILD_ID, SESSION_ID, null, 'working');

    expect(reconcileAgentStatus(temp.db, CHILD_ID, 'completed', SESSION_ID)).toEqual({
      type: 'agent-status-changed',
      agentId: CHILD_ID,
      sessionId: SESSION_ID,
      oldStatus: 'working',
      newStatus: 'completed',
    });
    expect(statusOf(CHILD_ID)).toBe('completed');
  });

  it("moves an 'unknown' row too — replayed evidence beats a watchdog guess", () => {
    insertAgent(temp.db, CHILD_ID, SESSION_ID, null, 'unknown');

    expect(reconcileAgentStatus(temp.db, CHILD_ID, 'completed', SESSION_ID)).toMatchObject({
      oldStatus: 'unknown',
      newStatus: 'completed',
    });
    expect(statusOf(CHILD_ID)).toBe('completed');
  });

  it('returns null for an agent id with no row (never creates one — CD-1)', () => {
    expect(reconcileAgentStatus(temp.db, 'no-such-agent', 'completed', SESSION_ID)).toBeNull();
    const count = temp.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("never moves a row already 'completed' (idempotence under replay)", () => {
    insertAgent(temp.db, CHILD_ID, SESSION_ID, null, 'completed');

    expect(reconcileAgentStatus(temp.db, CHILD_ID, 'completed', SESSION_ID)).toBeNull();
    expect(statusOf(CHILD_ID)).toBe('completed');
  });

  it("never moves a row already 'error' — replayed evidence cannot outrank a later terminal", () => {
    insertAgent(temp.db, CHILD_ID, SESSION_ID, null, 'error');

    expect(reconcileAgentStatus(temp.db, CHILD_ID, 'completed', SESSION_ID)).toBeNull();
    expect(statusOf(CHILD_ID)).toBe('error');
  });

  it('returns null when the row already holds the target non-terminal status (no X -> X transition)', () => {
    insertAgent(temp.db, CHILD_ID, SESSION_ID, null, 'waiting');

    expect(reconcileAgentStatus(temp.db, CHILD_ID, 'waiting', SESSION_ID)).toBeNull();
    expect(statusOf(CHILD_ID)).toBe('waiting');
  });
});
