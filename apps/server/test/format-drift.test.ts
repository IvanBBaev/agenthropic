/**
 * R13 (ARC-6, QA-3, DAT-7, DAT-11) - the format-drift census on /api/health.
 *
 * Covers the request-time aggregation over the per-session census columns
 * (migration 26), the `formatDrift` seam on buildServer, and the end-to-end
 * path: a drifted transcript ingested through ingestSession shows up in the
 * aggregate, and a torn JSONL line is skipped and counted instead of
 * quarantining the session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { censusFormat, type FormatCensus, type SessionSubstrate } from '@agenthropic/core';
import { HealthSchema } from '@agenthropic/shared';
import { Value } from '@sinclair/typebox/value';
import { readFormatDrift } from '../src/db/format-drift';
import { ingestSession, loadPricing } from '../src/index';
import { buildServer } from '../src/server';
import { createMigratedTempDb, insertSession, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const EMPTY = {
  sessionsCensused: 0,
  sessionsWithDrift: 0,
  malformedLinesSkipped: 0,
  claudeCodeVersions: {},
  byClaudeCodeVersion: {},
};

let temp: TempDb;

beforeEach(() => {
  temp = createMigratedTempDb();
});

afterEach(() => {
  temp.cleanup();
});

function store(id: string, versions: string | null, census: string | null): void {
  insertSession(temp.db, id);
  temp.db
    .prepare('UPDATE sessions SET claude_code_versions = ?, format_census = ? WHERE id = ?')
    .run(versions, census, id);
}

const census = (value: FormatCensus): string => JSON.stringify(value);

describe('readFormatDrift()', () => {
  it('answers an all-zero census on an empty database and ignores uncensused rows', () => {
    expect(readFormatDrift(temp.db)).toEqual(EMPTY);
    insertSession(temp.db, 'legacy');
    expect(readFormatDrift(temp.db)).toEqual(EMPTY);
  });

  it('sums drift per version across sessions and counts versions once per session', () => {
    store('clean', '["2.1.80"]', census({ malformedLines: 0, byVersion: {} }));
    store(
      'renamed',
      '["2.2.0","2.1.80","2.2.0"]',
      census({
        malformedLines: 0,
        byVersion: {
          '2.2.0': {
            unknownRecordTypes: { novel: 1 },
            unknownUsageKeys: { prompt_tokens: 2 },
            zeroUsageRecords: 2,
          },
        },
      }),
    );
    store(
      'torn',
      '["2.2.0"]',
      census({
        malformedLines: 3,
        byVersion: {
          '2.2.0': {
            unknownRecordTypes: { another: 1, novel: 4 },
            unknownUsageKeys: {},
            zeroUsageRecords: 1,
          },
          '(none)': {
            unknownRecordTypes: { '(missing)': 1 },
            unknownUsageKeys: {},
            zeroUsageRecords: 0,
          },
        },
      }),
    );

    const drift = readFormatDrift(temp.db);
    expect(drift).toEqual({
      sessionsCensused: 3,
      sessionsWithDrift: 2,
      malformedLinesSkipped: 3,
      claudeCodeVersions: { '2.1.80': 2, '2.2.0': 2 },
      byClaudeCodeVersion: {
        '(none)': {
          unknownRecordTypes: { '(missing)': 1 },
          unknownUsageKeys: {},
          zeroUsageRecords: 0,
        },
        '2.2.0': {
          unknownRecordTypes: { another: 1, novel: 5 },
          unknownUsageKeys: { prompt_tokens: 2 },
          zeroUsageRecords: 3,
        },
      },
    });
    // Sorted keys: the same rows always serialize to the same body.
    expect(Object.keys(drift.byClaudeCodeVersion)).toEqual(['(none)', '2.2.0']);
    expect(Object.keys(drift.byClaudeCodeVersion['2.2.0']!.unknownRecordTypes)).toEqual([
      'another',
      'novel',
    ]);
  });

  it('counts a malformed-only session as drifted', () => {
    store('torn', null, census({ malformedLines: 1, byVersion: {} }));
    expect(readFormatDrift(temp.db)).toEqual({
      ...EMPTY,
      sessionsCensused: 1,
      sessionsWithDrift: 1,
      malformedLinesSkipped: 1,
    });
  });

  it('counts versions from a row that has no census yet', () => {
    store('versions-only', '["2.1.80", 7]', null);
    expect(readFormatDrift(temp.db)).toEqual({ ...EMPTY, claudeCodeVersions: { '2.1.80': 1 } });
  });

  it('skips a stored value of the wrong shape instead of failing the probe', () => {
    const good = { unknownRecordTypes: {}, unknownUsageKeys: {}, zeroUsageRecords: 0 };
    store('versions-object', '{"not":"an array"}', null);
    store('not-an-object', null, '[1]');
    store('bad-malformed', null, '{"malformedLines":-1,"byVersion":{}}');
    store('no-by-version', null, '{"malformedLines":0}');
    store(
      'bad-entry',
      null,
      JSON.stringify({ malformedLines: 0, byVersion: { v: { ...good, zeroUsageRecords: 1.5 } } }),
    );
    store(
      'bad-counts',
      null,
      JSON.stringify({
        malformedLines: 0,
        byVersion: { v: { ...good, unknownUsageKeys: { k: 'x' } } },
      }),
    );
    store(
      'bad-map',
      null,
      JSON.stringify({
        malformedLines: 0,
        byVersion: { v: { ...good, unknownRecordTypes: null } },
      }),
    );
    // json_valid() keeps unparseable text out of the column; a parse failure
    // can only come from a hand edit that bypassed it, so it is simulated here.
    temp.db.pragma('ignore_check_constraints = ON');
    store('unparseable', 'nope', '{torn');
    temp.db.pragma('ignore_check_constraints = OFF');

    expect(readFormatDrift(temp.db)).toEqual(EMPTY);
  });
});

describe('the formatDrift seam on buildServer', () => {
  it('reports the census when the seam is given, and validates against the schema', async () => {
    store('renamed', '["2.2.0"]', census({ malformedLines: 2, byVersion: {} }));
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 26,
      formatDrift: () => readFormatDrift(temp.db),
    });
    try {
      const body = (
        await app.inject({ method: 'GET', url: '/api/health', headers: AUTH })
      ).json() as Record<string, unknown>;
      expect(body['formatDrift']).toEqual({
        ...EMPTY,
        sessionsCensused: 1,
        sessionsWithDrift: 1,
        malformedLinesSkipped: 2,
        claudeCodeVersions: { '2.2.0': 1 },
      });
      expect(Value.Check(HealthSchema, body)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('omits the field without the seam', async () => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 26 });
    try {
      const body = (
        await app.inject({ method: 'GET', url: '/api/health', headers: AUTH })
      ).json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('formatDrift');
    } finally {
      await app.close();
    }
  });
});

describe('ingest persists the census (end to end)', () => {
  const SESSION = 'dddddddd-1111-4222-8333-444444444444';
  const line = (record: Record<string, unknown>): string => JSON.stringify(record);

  function substrate(extraLines: readonly string[]): SessionSubstrate {
    return {
      files: [
        {
          relativePath: `${SESSION}.jsonl`,
          lines: [
            line({
              sessionId: SESSION,
              type: 'user',
              timestamp: '2026-11-08T00:00:00.000Z',
              version: '2.2.0',
            }),
            ...extraLines,
            line({
              sessionId: SESSION,
              type: 'assistant',
              timestamp: '2026-11-08T00:00:01.000Z',
              version: '2.2.0',
              message: {
                id: 'msg_1',
                model: 'claude-opus-4-5',
                role: 'assistant',
                content: [],
                usage: { prompt_tokens: 10, completion_tokens: 20 },
              },
            }),
          ],
        },
      ],
    };
  }

  function ingest(input: SessionSubstrate): void {
    const outcome = ingestSession(input, {
      db: temp.db,
      pricing: loadPricing(temp.db),
      instance: 'local',
      hostId: 'test-host',
      projectSlug: 'test-slug',
      now: () => '2026-11-08T00:00:02.000Z',
    });
    expect(outcome.error).toBeNull();
  }

  it('stores the session census and versions, and a torn line no longer quarantines it', () => {
    ingest(substrate(['{"type": "assistant", "sessionId":']));

    const row = temp.db
      .prepare('SELECT claude_code_versions, format_census FROM sessions WHERE id = ?')
      .get(SESSION) as { claude_code_versions: string; format_census: string };
    expect(row.claude_code_versions).toBe('["2.2.0"]');
    expect(JSON.parse(row.format_census)).toEqual(
      censusFormat(
        [
          {
            isTranscript: true,
            records: substrate([]).files[0]!.lines.map((l) => JSON.parse(l) as unknown),
          },
        ],
        1,
      ),
    );
    expect(readFormatDrift(temp.db)).toEqual({
      sessionsCensused: 1,
      sessionsWithDrift: 1,
      malformedLinesSkipped: 1,
      claudeCodeVersions: { '2.2.0': 1 },
      byClaudeCodeVersion: {
        '2.2.0': {
          unknownRecordTypes: {},
          unknownUsageKeys: { completion_tokens: 1, prompt_tokens: 1 },
          zeroUsageRecords: 1,
        },
      },
    });
  });

  it('a re-ingest of the repaired transcript overwrites the census', () => {
    ingest(substrate(['not json']));
    ingest(substrate([]));
    expect(readFormatDrift(temp.db).malformedLinesSkipped).toBe(0);
  });
});
