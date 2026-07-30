/**
 * WP-IN12 missing-Stop watchdog tests. The pure verdict function is exercised
 * over the full timestamp truth table (fresh / boundary / stale / corrupt /
 * absent), then the sweep is proven against a real migrated temp db: only
 * non-terminal agents transition, transitions persist, the event payloads are
 * exact, and a second sweep is silent (an agent already marked 'unknown' is
 * terminal and can never re-fire).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWatchdogCandidates, setAgentStatus } from '../src/db/agents';
import type { SqliteDatabase } from '../src/db/connection';
import {
  decideWatchdogVerdict,
  isTerminalAgentStatus,
  runWatchdogSweep,
} from '../src/ingest/watchdog';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

const MINUTE_MS = 60_000;
const THRESHOLD_MS = 10 * MINUTE_MS;
/** Fixed "now", well after the helpers' fixed 2026-07-11T00:00:00Z stamps. */
const NOW_MS = Date.parse('2026-07-12T00:00:00Z');

function insertAgentWithStamps(
  db: SqliteDatabase,
  id: string,
  sessionId: string,
  status: string | null,
  firstSeenAt: string | null,
  lastSeenAt: string | null,
): void {
  db.prepare(
    `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES (?, ?, 'subagent', 'explorer', ?, NULL, ?, ?)`,
  ).run(id, sessionId, status, firstSeenAt, lastSeenAt);
}

function statusOf(db: SqliteDatabase, id: string): string | null {
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as {
    status: string | null;
  };
  return row.status;
}

describe('isTerminalAgentStatus', () => {
  it.each(['completed', 'error', 'unknown'] as const)('%s is terminal', (status) => {
    expect(isTerminalAgentStatus(status)).toBe(true);
  });

  it.each(['working', 'waiting', null] as const)('%s is not terminal', (status) => {
    expect(isTerminalAgentStatus(status)).toBe(false);
  });
});

describe('decideWatchdogVerdict', () => {
  const at = (msBeforeNow: number): string => new Date(NOW_MS - msBeforeNow).toISOString();

  it('leaves a recently active working agent alone', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: at(THRESHOLD_MS), lastSeenAt: at(MINUTE_MS) },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe(null);
  });

  it('marks a silent working agent unknown once the window elapses', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: at(2 * THRESHOLD_MS), lastSeenAt: at(THRESHOLD_MS + 1) },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe('unknown');
  });

  it('treats the exact boundary as already stale (>=, not >)', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'waiting', firstSeenAt: null, lastSeenAt: at(THRESHOLD_MS) },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe('unknown');
    expect(
      decideWatchdogVerdict(
        { status: 'waiting', firstSeenAt: null, lastSeenAt: at(THRESHOLD_MS - 1) },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe(null);
  });

  it('falls back to firstSeenAt when lastSeenAt is NULL', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: at(THRESHOLD_MS), lastSeenAt: null },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe('unknown');
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: at(MINUTE_MS), lastSeenAt: null },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe(null);
  });

  it('marks an agent with NO timestamps unknown immediately (honesty over optimism)', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: null, lastSeenAt: null },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe('unknown');
  });

  it('marks an agent with a corrupt timestamp unknown (cannot prove activity)', () => {
    expect(
      decideWatchdogVerdict(
        { status: 'working', firstSeenAt: null, lastSeenAt: 'not-a-date' },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe('unknown');
  });

  it('never touches a terminal status even if handed one (defence in depth)', () => {
    for (const status of ['completed', 'error', 'unknown'] as const) {
      expect(
        decideWatchdogVerdict(
          { status, firstSeenAt: null, lastSeenAt: null },
          NOW_MS,
          THRESHOLD_MS,
        ),
      ).toBe(null);
    }
  });

  it('handles a NULL status row like a non-terminal agent', () => {
    expect(
      decideWatchdogVerdict(
        { status: null, firstSeenAt: null, lastSeenAt: at(THRESHOLD_MS) },
        NOW_MS,
        THRESHOLD_MS,
      ),
    ).toBe('unknown');
  });
});

describe('watchdog against a real migrated db', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, 'session-1');
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('listWatchdogCandidates returns only non-terminal rows, mapped to camelCase', () => {
    insertAgent(temp.db, 'a-working', 'session-1', null, 'working');
    insertAgent(temp.db, 'a-waiting', 'session-1', null, 'waiting');
    insertAgent(temp.db, 'a-completed', 'session-1', null, 'completed');
    insertAgent(temp.db, 'a-error', 'session-1', null, 'error');
    insertAgent(temp.db, 'a-unknown', 'session-1', null, 'unknown');
    insertAgentWithStamps(temp.db, 'a-null-status', 'session-1', null, null, null);

    const candidates = listWatchdogCandidates(temp.db);
    expect(candidates.map((c) => c.id).sort()).toEqual(['a-null-status', 'a-waiting', 'a-working']);
    const working = candidates.find((c) => c.id === 'a-working');
    expect(working).toEqual({
      id: 'a-working',
      sessionId: 'session-1',
      status: 'working',
      firstSeenAt: '2026-07-11T00:00:00Z',
      lastSeenAt: '2026-07-11T00:00:00Z',
    });
  });

  it('setAgentStatus updates exactly the status column', () => {
    insertAgent(temp.db, 'a-1', 'session-1', null, 'working');
    setAgentStatus(temp.db, 'a-1', 'unknown');

    const row = temp.db
      .prepare('SELECT status, session_id, last_seen_at FROM agents WHERE id = ?')
      .get('a-1') as { status: string; session_id: string; last_seen_at: string };
    expect(row.status).toBe('unknown');
    expect(row.session_id).toBe('session-1');
    expect(row.last_seen_at).toBe('2026-07-11T00:00:00Z');
  });

  it('sweep transitions stale non-terminal agents, persists, and reports exact events', () => {
    // Helpers stamp 2026-07-11T00:00:00Z; NOW_MS is a full day later → stale.
    insertAgent(temp.db, 'a-stale-working', 'session-1', null, 'working');
    insertAgent(temp.db, 'a-stale-waiting', 'session-1', null, 'waiting');
    insertAgent(temp.db, 'a-completed', 'session-1', null, 'completed');
    insertAgentWithStamps(
      temp.db,
      'a-fresh',
      'session-1',
      'working',
      null,
      new Date(NOW_MS - MINUTE_MS).toISOString(),
    );

    const events = runWatchdogSweep(temp.db, NOW_MS, THRESHOLD_MS);

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.agentId).sort()).toEqual(['a-stale-waiting', 'a-stale-working']);
    expect(events.find((e) => e.agentId === 'a-stale-working')).toEqual({
      type: 'agent-status-changed',
      agentId: 'a-stale-working',
      sessionId: 'session-1',
      oldStatus: 'working',
      newStatus: 'unknown',
    });
    expect(statusOf(temp.db, 'a-stale-working')).toBe('unknown');
    expect(statusOf(temp.db, 'a-stale-waiting')).toBe('unknown');
    expect(statusOf(temp.db, 'a-completed')).toBe('completed');
    expect(statusOf(temp.db, 'a-fresh')).toBe('working');
  });

  it('reports oldStatus NULL for a NULL-status row it marks unknown', () => {
    insertAgentWithStamps(temp.db, 'a-null', 'session-1', null, null, null);

    const events = runWatchdogSweep(temp.db, NOW_MS, THRESHOLD_MS);
    expect(events).toEqual([
      {
        type: 'agent-status-changed',
        agentId: 'a-null',
        sessionId: 'session-1',
        oldStatus: null,
        newStatus: 'unknown',
      },
    ]);
    expect(statusOf(temp.db, 'a-null')).toBe('unknown');
  });

  it('a second sweep is silent - unknown is terminal and never re-fires', () => {
    insertAgent(temp.db, 'a-stale', 'session-1', null, 'working');

    expect(runWatchdogSweep(temp.db, NOW_MS, THRESHOLD_MS)).toHaveLength(1);
    expect(runWatchdogSweep(temp.db, NOW_MS, THRESHOLD_MS)).toEqual([]);
    expect(runWatchdogSweep(temp.db, NOW_MS + THRESHOLD_MS, THRESHOLD_MS)).toEqual([]);
  });

  it('an empty candidate set sweeps to zero events', () => {
    expect(runWatchdogSweep(temp.db, NOW_MS, THRESHOLD_MS)).toEqual([]);
  });
});
