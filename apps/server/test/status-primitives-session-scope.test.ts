/**
 * Defence in depth for cross-session status writes, one layer below the hook.
 *
 * The hook layer (hooks/liveness-status.ts `agentBelongsToSession`) already
 * refuses a SubagentStop that names another session's agent. These tests pin
 * the SAME rule at the SQL layer: the session-scoped primitives
 * `applyAgentStatus` and `reconcileAgentStatus` key on `(id, session_id)`, so a
 * caller that bypasses the hook check still cannot move a foreign row.
 *
 * Also pins the watchdog honesty fix: a corrupt `last_seen_at` falls back to a
 * parseable `first_seen_at` instead of declaring 'unknown' without looking at it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAgentStatus, reconcileAgentStatus } from '../src/db/agents';
import type { SqliteDatabase } from '../src/db/connection';
import { decideWatchdogVerdict } from '../src/ingest/watchdog';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

const SESSION_A = 'session-a-0000';
const SESSION_B = 'session-b-0000';
const AGENT_B = 'agent-b-0001';

function statusOf(db: SqliteDatabase, id: string): string | null {
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as {
    status: string | null;
  };
  return row.status;
}

describe('session-scoped status primitives (SQL-layer ownership)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, SESSION_A);
    insertSession(temp.db, SESSION_B);
    insertAgent(temp.db, AGENT_B, SESSION_B, null, 'working');
  });

  afterEach(() => {
    temp.cleanup();
  });

  it("applyAgentStatus refuses to move session B's agent when scoped to session A", () => {
    expect(applyAgentStatus(temp.db, AGENT_B, 'completed', SESSION_A)).toBeNull();
    expect(statusOf(temp.db, AGENT_B)).toBe('working');
  });

  it('applyAgentStatus moves the agent when scoped to its own session', () => {
    expect(applyAgentStatus(temp.db, AGENT_B, 'completed', SESSION_B)).toEqual({
      type: 'agent-status-changed',
      agentId: AGENT_B,
      sessionId: SESSION_B,
      oldStatus: 'working',
      newStatus: 'completed',
    });
    expect(statusOf(temp.db, AGENT_B)).toBe('completed');
  });

  it("reconcileAgentStatus refuses to move session B's agent when scoped to session A", () => {
    expect(reconcileAgentStatus(temp.db, AGENT_B, 'completed', SESSION_A)).toBeNull();
    expect(statusOf(temp.db, AGENT_B)).toBe('working');
  });

  it('reconcileAgentStatus moves the agent when scoped to its own session', () => {
    expect(reconcileAgentStatus(temp.db, AGENT_B, 'completed', SESSION_B)).toEqual({
      type: 'agent-status-changed',
      agentId: AGENT_B,
      sessionId: SESSION_B,
      oldStatus: 'working',
      newStatus: 'completed',
    });
    expect(statusOf(temp.db, AGENT_B)).toBe('completed');
  });
});

describe('watchdog anchor fallback (no unchecked verdict)', () => {
  const NOW_MS = Date.parse('2026-07-12T00:00:00Z');
  const THRESHOLD_MS = 10 * 60_000;
  const at = (msBeforeNow: number): string => new Date(NOW_MS - msBeforeNow).toISOString();

  it('a corrupt last_seen_at falls back to a fresh first_seen_at: not stale, left alone', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: at(60_000), lastSeenAt: 'not-a-date' },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe(null);
  });

  it('a corrupt last_seen_at with a stale first_seen_at is still aged to unknown', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: at(THRESHOLD_MS), lastSeenAt: 'not-a-date' },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe('unknown');
  });

  it('both stamps corrupt: no activity can be proven, so unknown', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: 'also-bad', lastSeenAt: 'not-a-date' },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe('unknown');
  });
});
