/**
 * OPS-14 - the transcript lines ingest skipped, carried into the cost totals'
 * caveat.
 *
 * Since R13 a non-JSON line is skipped and counted instead of failing the
 * whole session, which keeps the session's spend in the totals but makes it a
 * lower bound. The count used to reach only `/api/health` `formatDrift`; the
 * cost summary now carries it corpus-wide, beside `partialSessions`, so the
 * page that shows the money says so too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getCostSummary } from '../src/api/queries';
import { readFormatDrift } from '../src/db/format-drift';
import { buildServer } from '../src/server';
import { createMigratedTempDb, insertSession, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

let temp: TempDb;

beforeEach(() => {
  temp = createMigratedTempDb();
});

afterEach(() => {
  temp.cleanup();
});

function storeCensus(id: string, census: string | null): void {
  insertSession(temp.db, id);
  temp.db.prepare('UPDATE sessions SET format_census = ? WHERE id = ?').run(census, id);
}

const census = (malformedLines: unknown): string =>
  JSON.stringify({ malformedLines, byVersion: {} });

function malformed(): { sessions: number; lines: number } {
  const summary = getCostSummary(temp.db, 10);
  return { sessions: summary.sessionsWithMalformedLines, lines: summary.malformedLinesSkipped };
}

describe('getCostSummary() malformed-line aggregates', () => {
  it('reads zero with no census at all, and for a clean census', () => {
    insertSession(temp.db, 'legacy');
    expect(malformed()).toEqual({ sessions: 0, lines: 0 });
    storeCensus('clean', census(0));
    expect(malformed()).toEqual({ sessions: 0, lines: 0 });
  });

  it('counts each torn session once and sums its lines', () => {
    storeCensus('torn-a', census(3));
    storeCensus('torn-b', census(1));
    storeCensus('clean', census(0));
    expect(malformed()).toEqual({ sessions: 2, lines: 4 });
  });

  it('agrees with the /api/health census on every readable census', () => {
    storeCensus('torn-a', census(3));
    storeCensus('torn-b', census(2));
    storeCensus('clean', census(0));
    expect(malformed().lines).toBe(readFormatDrift(temp.db).malformedLinesSkipped);
  });

  it('reads a value no parser writes as zero instead of guessing at it', () => {
    for (const [id, value] of [
      ['negative', census(-4)],
      ['fraction', census(2.5)],
      ['string', census('7')],
      ['null', census(null)],
      ['missing', JSON.stringify({ byVersion: {} })],
      ['array', '[1,2]'],
    ] as const) {
      storeCensus(id, value);
    }
    expect(malformed()).toEqual({ sessions: 0, lines: 0 });
  });

  it('is not served from a stale cache after a re-ingest writes a census', () => {
    storeCensus('torn', census(0));
    expect(malformed()).toEqual({ sessions: 0, lines: 0 });
    temp.db.prepare('UPDATE sessions SET format_census = ? WHERE id = ?').run(census(5), 'torn');
    expect(malformed()).toEqual({ sessions: 1, lines: 5 });
  });
});

describe('GET /api/cost/summary', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('serves the two aggregates', async () => {
    storeCensus('torn', census(2));
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    const response = await app.inject({ method: 'GET', url: '/api/cost/summary', headers: AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionsWithMalformedLines: 1,
      malformedLinesSkipped: 2,
    });
  });
});
