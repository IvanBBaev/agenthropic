/**
 * `sessions.last_activity_at` is monotonic non-decreasing.
 *
 * The session anchor is the MAX `endedAt` over the agents a pass emitted, so it
 * regresses whenever a pass reads less than an earlier one did: a subagent
 * transcript skipped this pass (oversize, EACCES), or a duplicate-slug dedupe
 * that now prefers a shorter copy. The skipped tail is absence of evidence,
 * not evidence the activity never happened. A regressed anchor misorders the
 * session lists and breaks SESSION_STATUS_CASE's "strictly advance" rule: the
 * next unchanged replay reads as new activity and flips an inferred
 * 'waiting' / 'unknown' session back to the ingest liveness status.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PricingEntry } from '@agenthropic/core';
import { setAgentStatus } from '../src/db/agents';
import { mirrorMainAgentStatus, upsertSession, type SessionUpsert } from '../src/db/sessions';
import { ingestSession, loadPricing } from '../src/index';
import type { IngestDeps } from '../src/index';
import { createMigratedTempDb, type TempDb } from './helpers';

const SESSION_ID = 'synthetic-session-monotonic';
const EARLY = '2026-07-11T00:00:00Z';
const LATE = '2026-07-11T00:05:00Z';
const LATER = '2026-07-11T00:09:00Z';

interface SessionRow {
  readonly status: string | null;
  readonly last_activity_at: string | null;
}

describe('sessions.last_activity_at is monotonic non-decreasing', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function readSession(): SessionRow | undefined {
    return temp.db
      .prepare('SELECT status, last_activity_at FROM sessions WHERE id = ?')
      .get(SESSION_ID) as SessionRow | undefined;
  }

  function markSession(status: string): void {
    temp.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, SESSION_ID);
  }

  describe('upsertSession', () => {
    function upsert(lastActivityAt: string | null, status = 'working'): void {
      const row: SessionUpsert = {
        id: SESSION_ID,
        projectSlug: 'test-slug',
        startedAt: EARLY,
        lastActivityAt,
        status,
      };
      upsertSession(temp.db, row);
    }

    it('keeps the later value when a pass reports an earlier last_activity_at', () => {
      upsert(LATE);
      upsert(EARLY);

      expect(readSession()?.last_activity_at).toBe(LATE);
    });

    it('still lets a genuine advance win', () => {
      upsert(LATE);
      upsert(LATER);

      expect(readSession()?.last_activity_at).toBe(LATER);
    });

    it('does not erase a stored value with a NULL', () => {
      upsert(LATE);
      upsert(null);

      expect(readSession()?.last_activity_at).toBe(LATE);
    });

    it('adopts a non-null value when the stored one is NULL', () => {
      upsert(null);
      expect(readSession()?.last_activity_at).toBeNull();

      upsert(EARLY);
      expect(readSession()?.last_activity_at).toBe(EARLY);
    });

    it.each(['waiting', 'unknown'] as const)(
      "a stale replay after a regress attempt does not flip '%s' back to 'working'",
      (inferred) => {
        upsert(LATE);
        markSession(inferred);

        upsert(EARLY);
        expect(readSession()).toEqual({ status: inferred, last_activity_at: LATE });

        // The unchanged full replay: LATE is not > LATE, so nothing is new.
        upsert(LATE);
        expect(readSession()).toEqual({ status: inferred, last_activity_at: LATE });

        // Real new activity still reverts the inferred state (OPEN-2).
        upsert(LATER);
        expect(readSession()).toEqual({ status: 'working', last_activity_at: LATER });
      },
    );

    it('evaluates SESSION_STATUS_CASE against the PRE-update last_activity_at', () => {
      // SQLite evaluates every SET expression against the old row, so the
      // status arm compares the incoming anchor with the STORED one even
      // though last_activity_at is assigned earlier in the same statement.
      upsert(EARLY);
      markSession('waiting');

      upsert(LATE);

      expect(readSession()).toEqual({ status: 'working', last_activity_at: LATE });
    });
  });

  describe('ingestSession', () => {
    const CHILD = 'cafe0002';
    const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;
    const PRICING: readonly PricingEntry[] = BUCKETS.map((bucket) => ({
      model: 'synthetic-model-a',
      bucket,
      usdPerMtok: 1,
      effectiveFrom: '2020-01-01',
    }));

    function turn(agentId: string | null, second: number, messageId: string): string[] {
      const base =
        agentId === null ? { sessionId: SESSION_ID } : { sessionId: SESSION_ID, agentId };
      return [
        JSON.stringify({
          ...base,
          type: 'user',
          timestamp: `2026-05-01T00:00:0${String(second)}.000Z`,
          message: { role: 'user', content: 'x' },
        }),
        JSON.stringify({
          ...base,
          type: 'assistant',
          timestamp: `2026-05-01T00:00:0${String(second + 1)}.000Z`,
          message: { id: messageId, model: 'synthetic-model-a', usage: { input_tokens: 1 } },
        }),
      ];
    }

    const MAIN_PATH = `${SESSION_ID}.jsonl`;
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

    /** What a `Stop` hook does: move the main agent and mirror it onto the session. */
    function stopHook(): void {
      setAgentStatus(temp.db, SESSION_ID, 'waiting');
      mirrorMainAgentStatus(temp.db, SESSION_ID, 'waiting');
    }

    it('keeps the session anchor and status across a short-copy pass', () => {
      const full = {
        relativePath: MAIN_PATH,
        lines: [...turn(null, 0, 'm_one'), ...turn(null, 2, 'm_two')],
      };
      // The shorter copy a duplicate-slug dedupe now prefers.
      const short = { relativePath: MAIN_PATH, lines: turn(null, 0, 'm_one') };

      expect(ingestSession({ files: [full] }, deps()).ok).toBe(true);
      expect(readSession()?.last_activity_at).toBe(FULL_END);
      stopHook();

      expect(ingestSession({ files: [short] }, deps()).ok).toBe(true);
      expect(readSession()).toEqual({ status: 'waiting', last_activity_at: FULL_END });

      // The full copy is back, byte-identical to pass 1: nothing is new.
      expect(ingestSession({ files: [full] }, deps()).ok).toBe(true);
      expect(readSession()).toEqual({ status: 'waiting', last_activity_at: FULL_END });
    });

    it('keeps the session anchor and status across a pass that skips the latest subagent', () => {
      const main = { relativePath: MAIN_PATH, lines: turn(null, 0, 'm_main') };
      const child = {
        relativePath: `workflows/wf_one/agent-${CHILD}.jsonl`,
        lines: turn(CHILD, 2, 'm_child'),
      };

      expect(ingestSession({ files: [main, child] }, deps()).ok).toBe(true);
      expect(readSession()?.last_activity_at).toBe(FULL_END);
      stopHook();

      // The subagent transcript was skipped this pass (oversize / EACCES).
      expect(ingestSession({ files: [main] }, deps()).ok).toBe(true);
      expect(readSession()).toEqual({ status: 'waiting', last_activity_at: FULL_END });

      expect(ingestSession({ files: [main, child] }, deps()).ok).toBe(true);
      expect(readSession()).toEqual({ status: 'waiting', last_activity_at: FULL_END });
    });
  });
});
