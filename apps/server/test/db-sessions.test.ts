import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SessionUpsert, upsertSession } from '../src/db/sessions';
import { createMigratedTempDb, type TempDb } from './helpers';

interface SessionRow {
  readonly id: string;
  readonly project_slug: string | null;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly status: string;
  readonly partial_reason: string | null;
  readonly partial_skipped_bytes: number | null;
  readonly usage_records_dropped: number;
  readonly claude_code_versions: string | null;
  readonly format_census: string | null;
  readonly ingest_seq: number;
}

/**
 * What an upsert that names no honesty field records: a whole read, nothing
 * dropped, no census known.
 */
const WHOLE = {
  partial_reason: null,
  partial_skipped_bytes: null,
  usage_records_dropped: 0,
  claude_code_versions: null,
  format_census: null,
};

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
      ...WHOLE,
      ingest_seq: 1,
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
      ...WHOLE,
      // S-1: the second upsert changed values, so it re-stamped the row.
      ingest_seq: 2,
    });
  });

  it('keeps the ingest stamp when an upsert rewrites identical values (S-1)', () => {
    const row: SessionUpsert = {
      id: 'session-1',
      projectSlug: 'agenthropic',
      startedAt: '2026-07-11T00:00:00Z',
      lastActivityAt: '2026-07-11T00:05:00Z',
      status: 'active',
    };
    upsertSession(temp.db, row);
    upsertSession(temp.db, row);

    expect(readRow('session-1')?.ingest_seq).toBe(1);
    expect(temp.db.prepare('SELECT seq FROM ingest_clock').get()).toEqual({ seq: 1 });
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
      ...WHOLE,
      ingest_seq: 1,
    });
  });
});

describe('upsertSession - R13 format census columns', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  const BASE: SessionUpsert = {
    id: 'session-c',
    projectSlug: 'agenthropic',
    startedAt: '2026-07-11T00:00:00Z',
    lastActivityAt: '2026-07-11T00:05:00Z',
    status: 'active',
  };

  function census(): { claude_code_versions: string | null; format_census: string | null } {
    return temp.db
      .prepare('SELECT claude_code_versions, format_census FROM sessions WHERE id = ?')
      .get('session-c') as { claude_code_versions: string | null; format_census: string | null };
  }

  it('stores sorted versions and the census as JSON, overwritten by the next pass', () => {
    upsertSession(temp.db, {
      ...BASE,
      claudeCodeVersions: ['2.1.81', '2.1.80'],
      formatCensus: { malformedLines: 2, byVersion: {} },
    });
    expect(census()).toEqual({
      claude_code_versions: '["2.1.80","2.1.81"]',
      format_census: '{"malformedLines":2,"byVersion":{}}',
    });

    upsertSession(temp.db, {
      ...BASE,
      claudeCodeVersions: ['2.1.81'],
      formatCensus: { malformedLines: 0, byVersion: {} },
    });
    expect(census()).toEqual({
      claude_code_versions: '["2.1.81"]',
      format_census: '{"malformedLines":0,"byVersion":{}}',
    });
  });

  it('writes byte-identical JSON on an identical replay and does not bump ingest_seq', () => {
    const row: SessionUpsert = {
      ...BASE,
      claudeCodeVersions: ['2.1.80'],
      formatCensus: {
        malformedLines: 0,
        byVersion: {
          '2.1.80': { unknownRecordTypes: { novel: 1 }, unknownUsageKeys: {}, zeroUsageRecords: 0 },
        },
      },
    };
    upsertSession(temp.db, row);
    const first = temp.db.prepare('SELECT * FROM sessions').get();
    upsertSession(temp.db, row);
    expect(temp.db.prepare('SELECT * FROM sessions').get()).toEqual(first);
  });

  it('rejects a non-JSON value at the column CHECK', () => {
    upsertSession(temp.db, BASE);
    expect(() =>
      temp.db
        .prepare("UPDATE sessions SET format_census = 'not json' WHERE id = 'session-c'")
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
