/**
 * `sessions.started_at` and `agents.first_seen_at` are monotonic
 * non-increasing: the mirror of the `last_activity_at` / `last_seen_at` rule.
 *
 * A pass reads only what it COULD read. Compaction can evict the head of a
 * transcript, a file can be skipped (oversize, EACCES), and a duplicate-slug
 * dedupe can pick a copy that starts later. Each of these hands the upsert a
 * LATER start than an earlier pass observed. The missing head is absence of
 * evidence, not evidence that the session or agent began later. An overwrite
 * would move the start forward, so the row would claim a start later than one
 * already observed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertAgent, type AgentUpsert } from '../src/db/agents';
import { upsertSession } from '../src/db/sessions';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

const SESSION_ID = 'synthetic-session-start-anchor';
const AGENT_ID = 'agent-start-anchor';
const EARLIER = '2026-07-11T00:00:00.000Z';
const EARLY = '2026-07-11T00:05:00.000Z';
const LATE = '2026-07-11T00:09:00.000Z';

describe('start anchors are monotonic non-increasing', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  describe('sessions.started_at', () => {
    function upsert(startedAt: string | null): void {
      upsertSession(temp.db, {
        id: SESSION_ID,
        projectSlug: 'test-slug',
        startedAt,
        lastActivityAt: LATE,
        status: 'working',
      });
    }

    function startedAt(): string | null | undefined {
      const row = temp.db
        .prepare('SELECT started_at FROM sessions WHERE id = ?')
        .get(SESSION_ID) as { started_at: string | null } | undefined;
      return row?.started_at;
    }

    it('keeps the earlier start when a pass reports a later one', () => {
      upsert(EARLY);
      upsert(LATE);

      expect(startedAt()).toBe(EARLY);
    });

    it('still lets an earlier start win', () => {
      upsert(EARLY);
      upsert(EARLIER);

      expect(startedAt()).toBe(EARLIER);
    });

    it('does not erase a stored start with a NULL', () => {
      upsert(EARLY);
      upsert(null);

      expect(startedAt()).toBe(EARLY);
    });

    it('fills a stored NULL from the first pass that knows the start', () => {
      upsert(null);
      upsert(EARLY);

      expect(startedAt()).toBe(EARLY);
    });

    it('rewrites an identical replay byte-identically', () => {
      upsert(EARLY);
      upsert(EARLY);

      expect(startedAt()).toBe(EARLY);
    });
  });

  describe('agents.first_seen_at', () => {
    function upsert(firstSeenAt: string | null): void {
      const row: AgentUpsert = {
        id: AGENT_ID,
        sessionId: SESSION_ID,
        type: 'subagent',
        subagentType: 'explorer',
        status: 'working',
        parentAgentId: null,
        firstSeenAt,
        lastSeenAt: LATE,
        outcomeCause: null,
      };
      upsertAgent(temp.db, row);
    }

    function firstSeenAt(): string | null | undefined {
      const row = temp.db.prepare('SELECT first_seen_at FROM agents WHERE id = ?').get(AGENT_ID) as
        { first_seen_at: string | null } | undefined;
      return row?.first_seen_at;
    }

    beforeEach(() => {
      insertSession(temp.db, SESSION_ID);
    });

    it('keeps the earlier first sighting when a pass reports a later one', () => {
      upsert(EARLY);
      upsert(LATE);

      expect(firstSeenAt()).toBe(EARLY);
    });

    it('still lets an earlier first sighting win', () => {
      upsert(EARLY);
      upsert(EARLIER);

      expect(firstSeenAt()).toBe(EARLIER);
    });

    it('does not erase a stored first sighting with a NULL', () => {
      upsert(EARLY);
      upsert(null);

      expect(firstSeenAt()).toBe(EARLY);
    });

    it('fills a stored NULL from the first pass that knows the sighting', () => {
      upsert(null);
      upsert(EARLY);

      expect(firstSeenAt()).toBe(EARLY);
    });

    it('rewrites an identical replay byte-identically', () => {
      upsert(EARLY);
      upsert(EARLY);

      expect(firstSeenAt()).toBe(EARLY);
    });
  });
});
