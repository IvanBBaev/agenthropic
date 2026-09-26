/**
 * An observed error outcome sets `agents.status` to 'error' even when the
 * child's `last_seen_at` does not advance.
 *
 * The outcome (for example `terminated_early`) is read from the PARENT
 * transcript, while the anchor is the CHILD's last record. A killed child's
 * transcript stops growing, so the pass that first sees the outcome carries the
 * same anchor as the pass before it. If the "strictly advance" rule applied,
 * the row would keep 'working' next to an `outcome_cause` that contradicts it,
 * and 'error' would never be counted.
 *
 * An observed 'completed' stays sticky. Whether an error outcome should
 * override it is an open owner decision (SA-BB1 variant), so it is pinned here
 * as it stands.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertAgent, type AgentUpsert } from '../src/db/agents';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

const SESSION_ID = 'synthetic-session-outcome-anchor';
const AGENT_ID = 'agent-outcome-anchor';
const SEEN = '2026-07-11T00:05:00.000Z';
const LATER = '2026-07-11T00:09:00.000Z';

interface Row {
  readonly status: string | null;
  readonly outcome_cause: string | null;
}

describe('an error outcome needs no anchor advance', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, SESSION_ID);
  });

  afterEach(() => {
    temp.cleanup();
  });

  function upsert(
    status: AgentUpsert['status'],
    lastSeenAt: string | null,
    outcomeCause: AgentUpsert['outcomeCause'] = null,
  ): void {
    upsertAgent(temp.db, {
      id: AGENT_ID,
      sessionId: SESSION_ID,
      type: 'subagent',
      subagentType: 'explorer',
      status,
      parentAgentId: null,
      firstSeenAt: SEEN,
      lastSeenAt,
      outcomeCause,
    });
  }

  function read(): Row | undefined {
    return temp.db
      .prepare('SELECT status, outcome_cause FROM agents WHERE id = ?')
      .get(AGENT_ID) as Row | undefined;
  }

  function mark(status: string): void {
    temp.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, AGENT_ID);
  }

  it('turns a working agent into error at an unchanged anchor', () => {
    upsert('working', SEEN);
    upsert('error', SEEN, 'terminated_early');

    expect(read()).toEqual({ status: 'error', outcome_cause: 'terminated_early' });
  });

  it.each(['waiting', 'unknown'])(
    'turns an inferred %s agent into error at an unchanged anchor',
    (inferred) => {
      upsert('working', SEEN);
      mark(inferred);
      upsert('error', SEEN, 'terminated_early');

      expect(read()?.status).toBe('error');
    },
  );

  it('applies the error even when the pass carries no anchor at all', () => {
    upsert('working', SEEN);
    upsert('error', null, 'terminated_early');

    expect(read()?.status).toBe('error');
  });

  it('keeps an observed completed sticky (owner decision pending)', () => {
    upsert('working', SEEN);
    mark('completed');
    upsert('error', SEEN, 'terminated_early');

    expect(read()?.status).toBe('completed');
  });

  it('keeps error on an identical replay', () => {
    upsert('error', SEEN, 'terminated_early');
    upsert('error', SEEN, 'terminated_early');

    expect(read()?.status).toBe('error');
  });

  it('still leaves a liveness status at an unchanged anchor alone', () => {
    upsert('working', SEEN);
    mark('waiting');
    upsert('working', SEEN);

    expect(read()?.status).toBe('waiting');
  });

  it('still lets liveness advance with a later anchor', () => {
    upsert('working', SEEN);
    mark('waiting');
    upsert('working', LATER);

    expect(read()?.status).toBe('working');
  });
});
