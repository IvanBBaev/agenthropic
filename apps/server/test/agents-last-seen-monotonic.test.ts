/**
 * `agents.last_seen_at` is monotonic non-decreasing.
 *
 * A pass reads only what it COULD read: a skipped file (oversize, EACCES) or a
 * duplicate-slug dedupe that picks a different, shorter copy of a session
 * hands the upsert FEWER records for an agent than an earlier pass saw. That
 * earlier, later timestamp is still a fact — absence of the tail this pass is
 * absence of evidence, not evidence the activity never happened. Letting the
 * column move backwards would misorder every recent-activity list and, worse,
 * break the status CASE's "strictly advance" rule: the NEXT pass replaying the
 * unchanged full transcript would look like new activity and flip an inferred
 * 'waiting' / 'unknown' back to 'working'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PricingEntry } from '@agenthropic/core';
import { setAgentStatus, upsertAgent, type AgentUpsert } from '../src/db/agents';
import { ingestSession, loadPricing } from '../src/index';
import type { IngestDeps } from '../src/index';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

const SESSION_ID = 'synthetic-monotonic-session';
const AGENT_ID = 'agent-monotonic';
const EARLY = '2026-07-11T00:00:00Z';
const LATE = '2026-07-11T00:05:00Z';
const LATER = '2026-07-11T00:09:00Z';

interface SeenRow {
  readonly status: string | null;
  readonly last_seen_at: string | null;
}

describe('agents.last_seen_at is monotonic non-decreasing', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function readRow(id: string): SeenRow | undefined {
    return temp.db.prepare('SELECT status, last_seen_at FROM agents WHERE id = ?').get(id) as
      SeenRow | undefined;
  }

  describe('upsertAgent', () => {
    const seed: Omit<AgentUpsert, 'lastSeenAt' | 'status'> = {
      id: AGENT_ID,
      sessionId: SESSION_ID,
      type: 'subagent',
      subagentType: 'explorer',
      parentAgentId: null,
      firstSeenAt: EARLY,
      outcomeCause: null,
    };

    function upsert(lastSeenAt: string | null, status: AgentUpsert['status'] = 'working'): void {
      upsertAgent(temp.db, { ...seed, status, lastSeenAt });
    }

    beforeEach(() => {
      insertSession(temp.db, SESSION_ID);
    });

    it('keeps the later value when a pass reports an earlier last_seen_at', () => {
      upsert(LATE);
      upsert(EARLY);

      expect(readRow(AGENT_ID)?.last_seen_at).toBe(LATE);
    });

    it('still lets a genuine advance win', () => {
      upsert(LATE);
      upsert(LATER);

      expect(readRow(AGENT_ID)?.last_seen_at).toBe(LATER);
    });

    it('does not erase a stored value with a NULL', () => {
      upsert(LATE);
      upsert(null);

      expect(readRow(AGENT_ID)?.last_seen_at).toBe(LATE);
    });

    it('adopts a non-null value when the stored one is NULL', () => {
      upsert(null);
      expect(readRow(AGENT_ID)?.last_seen_at).toBeNull();

      upsert(EARLY);
      expect(readRow(AGENT_ID)?.last_seen_at).toBe(EARLY);
    });

    it.each(['waiting', 'unknown'] as const)(
      "a stale replay after a regress attempt does not flip '%s' back to 'working'",
      (inferred) => {
        upsert(LATE);
        // A hook (waiting) or the watchdog (unknown) moves the row off 'working'.
        setAgentStatus(temp.db, AGENT_ID, inferred);

        // A short pass: an earlier anchor, so no advance and no status change.
        upsert(EARLY);
        expect(readRow(AGENT_ID)).toEqual({ status: inferred, last_seen_at: LATE });

        // The full transcript again, unchanged: LATE is not > LATE, so this is
        // a replay, not new activity — the inferred status must survive.
        upsert(LATE);
        expect(readRow(AGENT_ID)).toEqual({ status: inferred, last_seen_at: LATE });

        // Real new activity still reverts the inferred state (OPEN-2).
        upsert(LATER);
        expect(readRow(AGENT_ID)).toEqual({ status: 'working', last_seen_at: LATER });
      },
    );

    it('evaluates the status CASE against the PRE-update last_seen_at', () => {
      // SQLite evaluates every SET expression against the old row, so the
      // status arm compares the incoming anchor with the STORED one even
      // though last_seen_at is assigned in the same statement.
      upsert(EARLY);
      setAgentStatus(temp.db, AGENT_ID, 'waiting');

      upsert(LATE);

      expect(readRow(AGENT_ID)).toEqual({ status: 'working', last_seen_at: LATE });
    });
  });

  describe('ingestSession', () => {
    const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;
    const PRICING: readonly PricingEntry[] = BUCKETS.map((bucket) => ({
      model: 'synthetic-model-a',
      bucket,
      usdPerMtok: 1,
      effectiveFrom: '2020-01-01',
    }));

    function turn(second: number, messageId: string): string[] {
      return [
        JSON.stringify({
          sessionId: SESSION_ID,
          type: 'user',
          timestamp: `2026-05-01T00:00:0${String(second)}.000Z`,
          message: { role: 'user', content: 'x' },
        }),
        JSON.stringify({
          sessionId: SESSION_ID,
          type: 'assistant',
          timestamp: `2026-05-01T00:00:0${String(second + 1)}.000Z`,
          message: { id: messageId, model: 'synthetic-model-a', usage: { input_tokens: 1 } },
        }),
      ];
    }

    const MAIN_PATH = `${SESSION_ID}.jsonl`;
    const FULL = { relativePath: MAIN_PATH, lines: [...turn(0, 'm_one'), ...turn(2, 'm_two')] };
    // What a later pass sees when it can read less of the session: the shorter
    // copy a duplicate-slug dedupe now prefers, or a transcript mid-rewrite.
    const SHORT = { relativePath: MAIN_PATH, lines: turn(0, 'm_one') };
    const FULL_END = '2026-05-01T00:00:03.000Z';

    function deps(): IngestDeps {
      return {
        db: temp.db,
        pricing: [...loadPricing(temp.db), ...PRICING],
        instance: 'local',
        hostId: 'test-host',
        projectSlug: 'test-slug',
        now: () => '2026-07-11T00:00:00.000Z',
      };
    }

    it('keeps last_seen_at, and an inferred status, across a pass that reads fewer records', () => {
      expect(ingestSession({ files: [FULL] }, deps()).ok).toBe(true);
      expect(readRow(SESSION_ID)?.last_seen_at).toBe(FULL_END);
      setAgentStatus(temp.db, SESSION_ID, 'waiting');

      expect(ingestSession({ files: [SHORT] }, deps()).ok).toBe(true);
      expect(readRow(SESSION_ID)).toEqual({ status: 'waiting', last_seen_at: FULL_END });

      // The full copy is back, byte-identical to pass 1: nothing is new.
      expect(ingestSession({ files: [FULL] }, deps()).ok).toBe(true);
      expect(readRow(SESSION_ID)).toEqual({ status: 'waiting', last_seen_at: FULL_END });
    });
  });
});
