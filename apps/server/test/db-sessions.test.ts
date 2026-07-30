import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SessionUpsert, upsertSession } from '../src/db/sessions';
import { createMigratedTempDb, type TempDb } from './helpers';

interface SessionRow {
  readonly id: string;
  readonly project_slug: string | null;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly status: string;
}

describe('upsertSession (WP-D4)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function readRow(id: string): SessionRow | undefined {
    return temp.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  function countRows(): number {
    return (temp.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  }

  it('inserts a new session row', () => {
    const row: SessionUpsert = {
      id: 'session-1',
      projectSlug: 'agenthropic',
      startedAt: '2026-07-11T00:00:00Z',
      lastActivityAt: '2026-07-11T00:05:00Z',
      status: 'active',
    };
    upsertSession(temp.db, row);

    expect(countRows()).toBe(1);
    expect(readRow('session-1')).toEqual({
      id: 'session-1',
      project_slug: 'agenthropic',
      started_at: '2026-07-11T00:00:00Z',
      last_activity_at: '2026-07-11T00:05:00Z',
      status: 'active',
    });
  });

  it('updates the same single row on a second upsert with the same id', () => {
    upsertSession(temp.db, {
      id: 'session-1',
      projectSlug: 'agenthropic',
      startedAt: '2026-07-11T00:00:00Z',
      lastActivityAt: '2026-07-11T00:05:00Z',
      status: 'active',
    });
    upsertSession(temp.db, {
      id: 'session-1',
      projectSlug: 'agenthropic',
      startedAt: '2026-07-11T00:00:00Z',
      lastActivityAt: '2026-07-11T00:42:00Z',
      status: 'completed',
    });

    expect(countRows()).toBe(1);
    expect(readRow('session-1')).toEqual({
      id: 'session-1',
      project_slug: 'agenthropic',
      started_at: '2026-07-11T00:00:00Z',
      last_activity_at: '2026-07-11T00:42:00Z',
      status: 'completed',
    });
  });

  it('accepts a null projectSlug', () => {
    upsertSession(temp.db, {
      id: 'session-2',
      projectSlug: null,
      startedAt: null,
      lastActivityAt: null,
      status: 'active',
    });

    expect(countRows()).toBe(1);
    expect(readRow('session-2')).toEqual({
      id: 'session-2',
      project_slug: null,
      started_at: null,
      last_activity_at: null,
      status: 'active',
    });
  });
});
