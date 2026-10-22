/**
 * Audit S-2: the monotonic start/activity anchors order INSTANTS, not text.
 *
 * Ingest canonicalizes every incoming instant to `toISOString` form, but a row
 * written before that boundary may still hold a legacy offset spelling. Text
 * order is not instant order across spellings: '2026-01-01T10:00:00.000+02:00'
 * is 08:00Z, yet it sorts AFTER '2026-01-01T09:00:00.000Z'. A text MIN()/MAX()
 * (or the status CASE's `>`) over such a pair keeps the wrong anchor forever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertAgent, type AgentUpsert } from '../src/db/agents';
import { upsertSession, type SessionUpsert } from '../src/db/sessions';
import { createMigratedTempDb, type TempDb } from './helpers';

const SESSION_ID = 'synthetic-session-instant-order';
const AGENT_ID = 'agent-instant-order';
/** 08:00Z spelled with a +02:00 offset - text-larger than NINE_Z. */
const EIGHT_OFFSET = '2026-01-01T10:00:00.000+02:00';
const EIGHT_Z = '2026-01-01T08:00:00.000Z';
const NINE_Z = '2026-01-01T09:00:00.000Z';
const SEVEN_Z = '2026-01-01T07:00:00.000Z';

describe('timestamp anchors compare as instants (S-2)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function session(overrides: Partial<SessionUpsert>): void {
    upsertSession(temp.db, {
      id: SESSION_ID,
      projectSlug: 'test-slug',
      startedAt: null,
      lastActivityAt: null,
      status: 'working',
      ...overrides,
    });
  }

  function sessionRow(): {
    started_at: string | null;
    last_activity_at: string | null;
    status: string;
  } {
    return temp.db
      .prepare('SELECT started_at, last_activity_at, status FROM sessions WHERE id = ?')
      .get(SESSION_ID) as {
      started_at: string | null;
      last_activity_at: string | null;
      status: string;
    };
  }

  function agent(overrides: Partial<AgentUpsert>): void {
    upsertAgent(temp.db, {
      id: AGENT_ID,
      sessionId: SESSION_ID,
      type: 'main',
      subagentType: null,
      status: 'working',
      parentAgentId: null,
      firstSeenAt: null,
      lastSeenAt: null,
      outcomeCause: null,
      ...overrides,
    });
  }

  function agentRow(): {
    first_seen_at: string | null;
    last_seen_at: string | null;
    status: string;
  } {
    return temp.db
      .prepare('SELECT first_seen_at, last_seen_at, status FROM agents WHERE id = ?')
      .get(AGENT_ID) as {
      first_seen_at: string | null;
      last_seen_at: string | null;
      status: string;
    };
  }

  describe('sessions', () => {
    it('keeps a legacy offset-spelled start that is the earlier instant', () => {
      session({ startedAt: EIGHT_OFFSET });
      session({ startedAt: NINE_Z });
      expect(sessionRow().started_at).toBe(EIGHT_OFFSET);
    });

    it('lets a later-instant canonical activity replace a legacy offset-spelled anchor', () => {
      session({ lastActivityAt: EIGHT_OFFSET, status: 'unknown' });
      session({ lastActivityAt: NINE_Z, status: 'working' });
      const row = sessionRow();
      expect(row.last_activity_at).toBe(NINE_Z);
      // The status CASE's "strictly advance" test must see the new activity too.
      expect(row.status).toBe('working');
    });

    it('heals a legacy spelling to the canonical one on an instant tie', () => {
      session({ startedAt: EIGHT_OFFSET, lastActivityAt: EIGHT_OFFSET, status: 'unknown' });
      session({ startedAt: EIGHT_Z, lastActivityAt: EIGHT_Z, status: 'working' });
      const row = sessionRow();
      expect(row).toEqual({ started_at: EIGHT_Z, last_activity_at: EIGHT_Z, status: 'unknown' });
    });

    it('still keeps canonical rows byte-identical and NULL-tolerant', () => {
      session({ startedAt: EIGHT_Z, lastActivityAt: NINE_Z });
      session({ startedAt: NINE_Z, lastActivityAt: EIGHT_Z });
      expect(sessionRow()).toMatchObject({ started_at: EIGHT_Z, last_activity_at: NINE_Z });
      session({ startedAt: null, lastActivityAt: null });
      expect(sessionRow()).toMatchObject({ started_at: EIGHT_Z, last_activity_at: NINE_Z });
      session({ startedAt: SEVEN_Z, lastActivityAt: NINE_Z });
      expect(sessionRow()).toMatchObject({ started_at: SEVEN_Z, last_activity_at: NINE_Z });
    });

    it('lets a parsable value replace an unparsable legacy one', () => {
      session({ startedAt: 'not-a-time', lastActivityAt: 'not-a-time' });
      session({ startedAt: NINE_Z, lastActivityAt: EIGHT_Z });
      expect(sessionRow()).toMatchObject({ started_at: NINE_Z, last_activity_at: EIGHT_Z });
    });
  });

  describe('agents', () => {
    beforeEach(() => {
      session({});
    });

    it('keeps a legacy offset-spelled first sighting that is the earlier instant', () => {
      agent({ firstSeenAt: EIGHT_OFFSET });
      agent({ firstSeenAt: NINE_Z });
      expect(agentRow().first_seen_at).toBe(EIGHT_OFFSET);
    });

    it('lets a later-instant canonical sighting replace a legacy offset-spelled anchor', () => {
      agent({ lastSeenAt: EIGHT_OFFSET, status: 'unknown' });
      agent({ lastSeenAt: NINE_Z, status: 'working' });
      const row = agentRow();
      expect(row.last_seen_at).toBe(NINE_Z);
      expect(row.status).toBe('working');
    });

    it('still keeps canonical rows byte-identical', () => {
      agent({ firstSeenAt: EIGHT_Z, lastSeenAt: NINE_Z });
      agent({ firstSeenAt: NINE_Z, lastSeenAt: EIGHT_Z });
      expect(agentRow()).toMatchObject({ first_seen_at: EIGHT_Z, last_seen_at: NINE_Z });
    });
  });
});
