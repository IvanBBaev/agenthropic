/**
 * WP-U11 - /api/changes: CD-10 daily question 5, "what changed across
 * sessions", as a first-class delta rather than a client-side stitch of
 * /api/dag/global and /api/cost/summary.
 *
 * What this suite is really guarding is the window arithmetic. A delta
 * endpoint that is off by one boundary row is worse than no endpoint at all:
 * it looks authoritative while quietly dropping (or repeating) exactly the
 * rows the operator came to see. So the corpus below is built around the
 * boundary, the two timestamp spellings that a naive text comparison gets
 * wrong, and the rows that belong to NO window at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import type { SqliteDatabase } from '../src/db/connection';
import { assertChangesInvariants, getChanges, normalizeSinceInstant } from '../src/api/queries';
import type { ChangesDto } from '@agenthropic/shared';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

/** The lower boundary every window test asks about, canonically spelled. */
const SINCE = '2026-07-10T00:00:00.000Z';

/** The upper boundary the seeded corpus can vouch for (its newest instant). */
const UNTIL = '2026-07-12T00:00:00.000Z';

function seed(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES
      ('model-a', 'input', 1.0, '2020-01-01');

    -- The spellings matter more than the values here.
    --   s-boundary's activity is the SINCE instant written WITHOUT millis; as
    --     raw text it sorts ABOVE the canonical spelling of the same instant
    --     ('Z' > '.'), so a text comparison would wrongly call it changed.
    --   s-offset's activity carries a UTC offset and lands inside the window
    --     only once the offset is folded onto the clock.
    --   s-undated's timestamps cannot be parsed at all - it belongs to no
    --     window and must be disclosed, not dated by guesswork.
    INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES
      ('s-new',      'proj-a', '2026-07-11T00:00:00Z',     '2026-07-11T06:00:00Z',      'active'),
      ('s-updated',  'proj-b', '2026-07-01T00:00:00.000Z', '2026-07-12T00:00:00Z',      'active'),
      ('s-offset',   'proj-c', '2026-07-02T00:00:00Z',     '2026-07-10T20:00:00-05:00', 'completed'),
      ('s-unknown',  NULL,     NULL,                       '2026-07-11T12:00:00Z',      NULL),
      ('s-boundary', 'proj-d', '2026-07-09T00:00:00Z',     '2026-07-10T00:00:00Z',      'active'),
      ('s-undated',  'proj-e', 'not-a-date',               NULL,                        'active'),
      ('s-old',      'proj-f', '2026-01-01T00:00:00Z',     '2026-01-02T00:00:00Z',      'completed');

    INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at) VALUES
      ('a-main-new',     's-new',     'main',     NULL,       'working',   NULL,             '2026-07-11T00:01:00Z', '2026-07-11T06:00:00Z'),
      ('a-sub-new',      's-new',     'subagent', 'explorer', 'completed', 'a-main-new',     '2026-07-11T00:05:00Z', '2026-07-11T01:00:00Z'),
      ('a-main-updated', 's-updated', 'main',     NULL,       'working',   NULL,             '2026-07-01T00:00:00Z', '2026-07-12T00:00:00Z'),
      ('a-undated',      's-updated', 'subagent', 'planner',  'unknown',   'a-main-updated', 'not-a-date',           'not-a-date'),
      ('a-main-old',     's-old',     'main',     NULL,       'completed', NULL,             '2026-07-11T09:00:00Z', '2026-07-11T09:00:00Z');

    INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at) VALUES
      ('s-new',     'a-sub-new',  'm1', 'model-a', 'input', 1000000, 0, '2026-07-11T01:00:00Z'),
      ('s-new',     'a-sub-new',  'm2', 'model-x', 'input',     500, 0, '2026-07-11T02:00:00Z'),
      ('s-updated', NULL,         'm3', 'model-a', 'input', 2000000, 0, '2026-07-12T00:00:00Z'),
      ('s-old',     'a-main-old', 'm4', 'model-a', 'input', 3000000, 0, '2026-07-11T03:00:00Z'),
      ('s-updated', NULL,         'm5', 'model-a', 'input', 9000000, 0, '2026-01-05T00:00:00Z'),
      ('s-new',     NULL,         'm6', 'model-a', 'input',       7, 0, NULL);
  `);
}

function url(query: string): string {
  return `/api/changes?${query}`;
}

describe('/api/changes (WP-U11)', () => {
  let temp: TempDb;
  let app: FastifyInstance;

  beforeEach(async () => {
    temp = createMigratedTempDb();
    seed(temp.db);
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    temp.cleanup();
  });

  it('requires auth (401 without a token) - the global hook gates it, not the route', async () => {
    const response = await app.inject({ method: 'GET', url: url(`since=${SINCE}`) });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized.' });

    // ...and a wrong token is no better than none.
    const wrong = await app.inject({
      method: 'GET',
      url: url(`since=${SINCE}`),
      headers: { authorization: 'Bearer not-the-token-000000' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('names its own window and answers the whole of it', async () => {
    const response = await app.inject({ method: 'GET', url: url(`since=${SINCE}`), headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ChangesDto;

    // The window is stated, not implied: a caller that chains `since=until`
    // can prove it will neither skip nor repeat a row.
    expect(body.since).toBe(SINCE);
    expect(body.until).toBe(UNTIL);
    expect(body.interval).toBe('(since, until]');
    expect(body.basis).toBe('event-time');

    expect(body.total).toBe(4);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.sessions.map((s) => s.id)).toEqual(['s-updated', 's-unknown', 's-new', 's-offset']);

    // s-boundary changed AT `since` - excluded, because the window is
    // half-open. s-old changed long before it. s-undated cannot be placed.
    expect(body.sessions.map((s) => s.id)).not.toContain('s-boundary');
    expect(body.sessions.map((s) => s.id)).not.toContain('s-old');
    expect(body.sessions.map((s) => s.id)).not.toContain('s-undated');

    // ...while a session whose activity lands exactly ON `until` IS included:
    // the boundary belongs to the window that ends at it, exactly once.
    expect(body.sessions[0]?.changedAt).toBe(UNTIL);
  });

  it('classifies new vs updated vs unknown without ever guessing a start', async () => {
    const response = await app.inject({ method: 'GET', url: url(`since=${SINCE}`), headers: AUTH });
    const body = response.json() as ChangesDto;
    const byId = new Map(body.sessions.map((s) => [s.id, s]));

    expect(byId.get('s-new')?.change).toBe('new');
    expect(byId.get('s-updated')?.change).toBe('updated');
    // Its offset spelling started before the window: an update, not a birth.
    expect(byId.get('s-offset')?.change).toBe('updated');
    // No `started_at` at all - 'unknown', never defaulted into 'new'.
    expect(byId.get('s-unknown')?.change).toBe('unknown');

    // The three counts partition the window exactly.
    expect(body.totals.sessionsNew).toBe(1);
    expect(body.totals.sessionsUpdated).toBe(2);
    expect(body.totals.sessionsUnknownStart).toBe(1);
    expect(
      body.totals.sessionsNew + body.totals.sessionsUpdated + body.totals.sessionsUnknownStart,
    ).toBe(body.total);
  });

  it('folds a UTC offset and a millis-less spelling onto the same clock', async () => {
    const response = await app.inject({ method: 'GET', url: url(`since=${SINCE}`), headers: AUTH });
    const byId = new Map((response.json() as ChangesDto).sessions.map((s) => [s.id, s]));

    // '2026-07-10T20:00:00-05:00' is 2026-07-11T01:00Z - inside the window,
    // even though as raw text it sorts BELOW `since`.
    expect(byId.get('s-offset')?.changedAt).toBe('2026-07-11T01:00:00.000Z');
    // The raw column is served verbatim next to the derived key, so the
    // operator can see what was stored as well as how it was read.
    expect(byId.get('s-offset')?.lastActivityAt).toBe('2026-07-10T20:00:00-05:00');
    expect(byId.get('s-new')?.changedAt).toBe('2026-07-11T06:00:00.000Z');
    expect(byId.get('s-new')?.startedAt).toBe('2026-07-11T00:00:00Z');
    expect(byId.get('s-unknown')?.projectSlug).toBeNull();
    expect(byId.get('s-unknown')?.status).toBeNull();
    expect(byId.get('s-unknown')?.startedAt).toBeNull();
  });

  it('adds up money and tokens from token_usage x model_pricing only', async () => {
    const response = await app.inject({ method: 'GET', url: url(`since=${SINCE}`), headers: AUTH });
    const body = response.json() as ChangesDto;
    const byId = new Map(body.sessions.map((s) => [s.id, s]));

    // 1_000_000 priced + 500 unpriced + 2_000_000 priced + 3_000_000 priced.
    // The 9_000_000 from January and the undated 7 are outside the window.
    expect(body.totals.tokensAdded).toBe(6_000_500);
    expect(body.totals.costAddedUsd).toBeCloseTo(6, 9);
    expect(body.totals.unpricedTokensAdded).toBe(500);
    // 3_000_000 of those tokens belong to s-old, which did NOT change in the
    // window - stated, so the per-session breakdown's shortfall is explained
    // instead of looking like a bug.
    expect(body.totals.tokensAddedOutsideChangedSessions).toBe(3_000_000);

    expect(byId.get('s-new')).toMatchObject({
      tokensAdded: 1_000_500,
      unpricedTokensAdded: 500,
      agentsAppeared: 2,
    });
    expect(byId.get('s-new')?.costAddedUsd).toBeCloseTo(1, 9);
    expect(byId.get('s-updated')).toMatchObject({
      tokensAdded: 2_000_000,
      unpricedTokensAdded: 0,
      agentsAppeared: 0,
    });
    expect(byId.get('s-updated')?.costAddedUsd).toBeCloseTo(2, 9);
    // A changed session with no usage and no new agents in the window reports
    // zeros, not absent fields.
    expect(byId.get('s-offset')).toMatchObject({
      tokensAdded: 0,
      costAddedUsd: 0,
      unpricedTokensAdded: 0,
      agentsAppeared: 0,
    });

    // The page can only ever be a subset of the window.
    const pageTokens = body.sessions.reduce((sum, s) => sum + s.tokensAdded, 0);
    expect(pageTokens).toBe(3_000_500);
    expect(pageTokens).toBeLessThan(body.totals.tokensAdded);
  });

  it('counts every agent that appeared in the window, session-changed or not', async () => {
    const response = await app.inject({ method: 'GET', url: url(`since=${SINCE}`), headers: AUTH });
    const body = response.json() as ChangesDto;
    // a-main-new, a-sub-new and a-main-old (whose session did not change).
    expect(body.totals.agentsAppeared).toBe(3);
  });

  it('discloses what it could not date instead of dropping it silently', async () => {
    const response = await app.inject({ method: 'GET', url: url(`since=${SINCE}`), headers: AUTH });
    const body = response.json() as ChangesDto;
    expect(body.coverage).toEqual({
      undatedSessions: 1,
      undatedAgents: 1,
      undatedUsageRows: 1,
    });
  });

  it('caps the page and says how much of the window it is showing', async () => {
    const first = await app.inject({
      method: 'GET',
      url: url(`since=${SINCE}&limit=2`),
      headers: AUTH,
    });
    const firstBody = first.json() as ChangesDto;
    expect(firstBody.limit).toBe(2);
    expect(firstBody.offset).toBe(0);
    expect(firstBody.total).toBe(4);
    expect(firstBody.sessions.map((s) => s.id)).toEqual(['s-updated', 's-unknown']);
    // The window totals are the WINDOW's, never the page's.
    expect(firstBody.totals.tokensAdded).toBe(6_000_500);

    const second = await app.inject({
      method: 'GET',
      url: url(`since=${SINCE}&limit=2&offset=2`),
      headers: AUTH,
    });
    const secondBody = second.json() as ChangesDto;
    expect(secondBody.offset).toBe(2);
    expect(secondBody.sessions.map((s) => s.id)).toEqual(['s-new', 's-offset']);
    expect(secondBody.total).toBe(4);

    // Past the end: an empty page, not an error and not a wrapped-around one.
    const past = await app.inject({
      method: 'GET',
      url: url(`since=${SINCE}&offset=99`),
      headers: AUTH,
    });
    const pastBody = past.json() as ChangesDto;
    expect(pastBody.sessions).toEqual([]);
    expect(pastBody.total).toBe(4);
    expect(pastBody.totals.tokensAdded).toBe(6_000_500);
  });

  it('rejects an out-of-range limit or offset rather than clamping it', async () => {
    for (const query of [
      `since=${SINCE}&limit=0`,
      `since=${SINCE}&limit=201`,
      `since=${SINCE}&offset=-1`,
      `since=${SINCE}&offset=1000001`,
      `since=${SINCE}&limit=not-a-number`,
    ]) {
      const response = await app.inject({ method: 'GET', url: url(query), headers: AUTH });
      expect(response.statusCode).toBe(400);
      expect(Object.keys(response.json() as object)).toEqual(['error']);
    }

    // The maxima themselves are accepted - the cap is inclusive.
    const atCap = await app.inject({
      method: 'GET',
      url: url(`since=${SINCE}&limit=200&offset=1000000`),
      headers: AUTH,
    });
    expect(atCap.statusCode).toBe(200);
    expect((atCap.json() as ChangesDto).limit).toBe(200);
  });

  it('refuses an absent, ambiguous or impossible `since` - it never invents one', async () => {
    // Absent: a delta with a defaulted lower bound answers a question nobody
    // asked, and nothing in the reply would say so.
    const absent = await app.inject({ method: 'GET', url: '/api/changes', headers: AUTH });
    expect(absent.statusCode).toBe(400);
    expect(Object.keys(absent.json() as object)).toEqual(['error']);

    // Shape-rejected by the schema.
    for (const since of [
      'yesterday',
      '2026-07-10T00:00:00', // no zone - would be read as LOCAL time
      '07/10/2026',
      '',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: url(`since=${encodeURIComponent(since)}`),
        headers: AUTH,
      });
      expect(response.statusCode).toBe(400);
    }

    // Shape-legal but not a real instant: the schema cannot see this, the
    // normalizer must. '2026-02-30' would otherwise be silently answered as
    // March 2nd.
    for (const since of ['2026-02-30', '2026-13-01', '2026-07-10T25:00:00Z']) {
      const response = await app.inject({
        method: 'GET',
        url: url(`since=${since}`),
        headers: AUTH,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'The `since` parameter must be a real ISO-8601 instant in UTC.',
      });
    }
  });

  it('accepts a bare date and a zoned instant, and echoes `since` canonically', async () => {
    const bare = await app.inject({
      method: 'GET',
      url: url('since=2026-07-10'),
      headers: AUTH,
    });
    expect(bare.statusCode).toBe(200);
    expect((bare.json() as ChangesDto).since).toBe(SINCE);

    const zoned = await app.inject({
      method: 'GET',
      url: url(`since=${encodeURIComponent('2026-07-09T19:00:00-05:00')}`),
      headers: AUTH,
    });
    expect(zoned.statusCode).toBe(200);
    // The same instant as SINCE, restated in the one spelling the API uses.
    expect((zoned.json() as ChangesDto).since).toBe(SINCE);
  });

  it('chains without a gap or a repeat when the caller passes back `until`', async () => {
    const first = (
      await app.inject({ method: 'GET', url: url('since=2026-01-01'), headers: AUTH })
    ).json() as ChangesDto;
    const second = (
      await app.inject({ method: 'GET', url: url(`since=${first.until}`), headers: AUTH })
    ).json() as ChangesDto;

    // Nothing is served twice...
    const firstIds = new Set(first.sessions.map((s) => s.id));
    for (const session of second.sessions) {
      expect(firstIds.has(session.id)).toBe(false);
    }
    // ...and with nothing newer in the corpus, the follow-up window is empty
    // and SAYS it is empty (until == since) rather than pretending to reach
    // the wall clock.
    expect(second.until).toBe(first.until);
    expect(second.total).toBe(0);
    expect(second.sessions).toEqual([]);
    expect(second.totals.tokensAdded).toBe(0);
    expect(second.totals.costAddedUsd).toBe(0);
    expect(second.totals.agentsAppeared).toBe(0);
    // The coverage disclosure is about the CORPUS, not the window, so it
    // still reports the undated rows.
    expect(second.coverage.undatedSessions).toBe(1);
  });

  it('never reaches past the newest instant it can actually see', async () => {
    const response = await app.inject({
      method: 'GET',
      url: url('since=2026-01-01'),
      headers: AUTH,
    });
    const body = response.json() as ChangesDto;
    expect(body.until).toBe(UNTIL);
    // The corpus's newest row, not "now" - ingest lags event time, so a clock
    // boundary would promise rows that have not arrived.
    expect(Date.parse(body.until)).toBeLessThan(Date.now());
  });
});

describe('/api/changes on an empty database (WP-U11)', () => {
  let temp: TempDb;
  let app: FastifyInstance;

  beforeEach(async () => {
    temp = createMigratedTempDb();
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    temp.cleanup();
  });

  it('answers an honestly empty window instead of failing or faking a boundary', async () => {
    const response = await app.inject({ method: 'GET', url: url(`since=${SINCE}`), headers: AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      since: SINCE,
      until: SINCE,
      interval: '(since, until]',
      basis: 'event-time',
      sessions: [],
      totals: {
        sessionsNew: 0,
        sessionsUpdated: 0,
        sessionsUnknownStart: 0,
        agentsAppeared: 0,
        tokensAdded: 0,
        costAddedUsd: 0,
        unpricedTokensAdded: 0,
        tokensAddedOutsideChangedSessions: 0,
      },
      coverage: { undatedSessions: 0, undatedAgents: 0, undatedUsageRows: 0 },
      total: 0,
      limit: 50,
      offset: 0,
    });
  });
});

describe('normalizeSinceInstant (WP-U11)', () => {
  it('canonicalizes every spelling it accepts', () => {
    expect(normalizeSinceInstant('2026-07-10')).toBe('2026-07-10T00:00:00.000Z');
    expect(normalizeSinceInstant('2026-07-10T00:00:00Z')).toBe('2026-07-10T00:00:00.000Z');
    expect(normalizeSinceInstant('2026-07-10T00:00:00.000Z')).toBe('2026-07-10T00:00:00.000Z');
    expect(normalizeSinceInstant('2026-07-10T06:30:00.5Z')).toBe('2026-07-10T06:30:00.500Z');
    expect(normalizeSinceInstant('2026-07-09T19:00:00-05:00')).toBe('2026-07-10T00:00:00.000Z');
    // A leap day the calendar DOES have, so it must survive the round-trip.
    expect(normalizeSinceInstant('2024-02-29')).toBe('2024-02-29T00:00:00.000Z');
  });

  it('rejects each way a boundary can be ambiguous or unreal', () => {
    // Shape: not an ISO-8601 instant at all. `Date.parse` would happily
    // accept some of these on V8 and quietly answer a different window.
    expect(normalizeSinceInstant('July 10, 2026')).toBeNull();
    expect(normalizeSinceInstant('2026-07-10 00:00:00Z')).toBeNull();
    // A time with no zone: ECMAScript reads it as LOCAL, so the window would
    // silently shift with the server's timezone.
    expect(normalizeSinceInstant('2026-07-10T00:00:00')).toBeNull();
    // Digits that are not a month.
    expect(normalizeSinceInstant('2026-13-01')).toBeNull();
    // A day the calendar does not have - V8 rolls this to March 2nd, which is
    // precisely the silent wrong answer this check exists to prevent.
    expect(normalizeSinceInstant('2026-02-30')).toBeNull();
    expect(normalizeSinceInstant('2025-02-29')).toBeNull();
    // Shape-legal, calendar-legal, but not a real time of day.
    expect(normalizeSinceInstant('2026-07-10T25:00:00Z')).toBeNull();
  });
});

/**
 * The invariant sweep is unreachable through the queries by construction -
 * which is exactly why it is exercised directly here. A rule that is only ever
 * asserted on data that cannot break it is not a tested rule, and this one is
 * the last thing standing between a corrupted count and an HTTP 200:
 * `ChangesResponseSchema`'s `minimum: 0` does nothing at runtime, because
 * fast-json-stringify serializes TO a schema rather than validating AGAINST it.
 */
describe('assertChangesInvariants (WP-U11)', () => {
  function baseDto(): ChangesDto {
    return {
      since: SINCE,
      until: UNTIL,
      interval: '(since, until]',
      basis: 'event-time',
      sessions: [
        {
          id: 's-new',
          projectSlug: 'proj-a',
          status: 'active',
          startedAt: '2026-07-11T00:00:00Z',
          lastActivityAt: '2026-07-11T06:00:00Z',
          changedAt: '2026-07-11T06:00:00.000Z',
          change: 'new',
          agentsAppeared: 2,
          tokensAdded: 1000,
          costAddedUsd: 1,
          unpricedTokensAdded: 100,
        },
      ],
      totals: {
        sessionsNew: 1,
        sessionsUpdated: 0,
        sessionsUnknownStart: 0,
        agentsAppeared: 2,
        tokensAdded: 5000,
        costAddedUsd: 5,
        unpricedTokensAdded: 100,
        tokensAddedOutsideChangedSessions: 4000,
      },
      coverage: { undatedSessions: 0, undatedAgents: 0, undatedUsageRows: 0 },
      total: 1,
      limit: 50,
      offset: 0,
    };
  }

  it('passes a coherent answer through untouched', () => {
    expect(() => {
      assertChangesInvariants(baseDto());
    }).not.toThrow();
  });

  const violations: ReadonlyArray<readonly [string, (dto: ChangesDto) => ChangesDto, RegExp]> = [
    [
      'an inverted window',
      (dto) => ({ ...dto, until: '2026-01-01T00:00:00.000Z' }),
      /window is inverted/,
    ],
    [
      'a classification that does not partition the window',
      (dto) => ({ ...dto, totals: { ...dto.totals, sessionsUpdated: 3 } }),
      /classified 4 session\(s\) but the window holds 1/,
    ],
    ['a page longer than its own cap', (dto) => ({ ...dto, limit: 0 }), /exceeds the limit 0/],
    [
      'a page longer than the window it pages',
      (dto) => ({ ...dto, total: 0, totals: { ...dto.totals, sessionsNew: 0 } }),
      /exceeds the window total 0/,
    ],
    [
      'more unpriced tokens than tokens, in the totals',
      (dto) => ({ ...dto, totals: { ...dto.totals, unpricedTokensAdded: 6000 } }),
      /unpriced 6000 exceeds/,
    ],
    [
      'more unattributed tokens than tokens',
      (dto) => ({ ...dto, totals: { ...dto.totals, tokensAddedOutsideChangedSessions: 9000 } }),
      /unattributed 9000 exceeds/,
    ],
    [
      'a session dated at or before `since`',
      (dto) => ({ ...dto, sessions: [{ ...dto.sessions[0]!, changedAt: SINCE }] }),
      /outside \(2026-07-10/,
    ],
    [
      'a session dated after `until`',
      (dto) => ({
        ...dto,
        sessions: [{ ...dto.sessions[0]!, changedAt: '2027-01-01T00:00:00.000Z' }],
      }),
      /outside \(2026-07-10/,
    ],
    [
      'more unpriced tokens than tokens, in one session',
      (dto) => ({ ...dto, sessions: [{ ...dto.sessions[0]!, unpricedTokensAdded: 2000 }] }),
      /more unpriced tokens than tokens/,
    ],
    [
      'a page that sums past its own window',
      (dto) => ({ ...dto, sessions: [{ ...dto.sessions[0]!, tokensAdded: 6000 }] }),
      /the page sums to 6000 tokens/,
    ],
    [
      'a negative count',
      (dto) => ({ ...dto, coverage: { ...dto.coverage, undatedAgents: -1 } }),
      /coverage.undatedAgents is -1/,
    ],
    [
      'a negative per-session figure',
      (dto) => ({ ...dto, sessions: [{ ...dto.sessions[0]!, costAddedUsd: -0.5 }] }),
      /session s-new costAddedUsd is -0\.5/,
    ],
    [
      'a figure that is not a number at all',
      (dto) => ({ ...dto, totals: { ...dto.totals, costAddedUsd: Number.NaN } }),
      /totals.costAddedUsd is NaN/,
    ],
  ];

  for (const [label, corrupt, expected] of violations) {
    it(`refuses to serve ${label}`, () => {
      expect(() => {
        assertChangesInvariants(corrupt(baseDto()));
      }).toThrow(expected);
    });
  }

  it('reports every violation at once, so one fix does not hide the next', () => {
    const dto = baseDto();
    expect(() => {
      assertChangesInvariants({
        ...dto,
        until: '2026-01-01T00:00:00.000Z',
        totals: { ...dto.totals, unpricedTokensAdded: 6000 },
      });
    }).toThrow(/window is inverted.*unpriced 6000 exceeds/s);
  });

  it('is what stops the query layer serving a wrong number as a 200', () => {
    // A direct call with a corrupted DTO proves the throw; the route's 500
    // arm then converts it to a detail-free error. The queries themselves
    // cannot produce this, which is the point of testing it here.
    const temp = createMigratedTempDb();
    try {
      seed(temp.db);
      const honest = getChanges(temp.db, SINCE, 50, 0);
      expect(() => {
        assertChangesInvariants(honest);
      }).not.toThrow();
      expect(honest.total).toBe(4);
    } finally {
      temp.cleanup();
    }
  });
});
