/**
 * Owner decision (2026-10-01): a session the corpus holds but ingest REJECTED
 * is not a session that does not exist.
 *
 * Before this, every per-session read answered `404 Session not found.` for
 * both, so a reader chasing a quarantined session - typically a model shipped
 * before its price row - was told the session was never there, and went
 * looking for a missing transcript instead of a missing price. The two facts
 * now get two answers on every per-session read endpoint:
 *
 *  - unknown to ingest and absent from the database -> 404, unchanged;
 *  - rejected by ingest (failing or quarantined) and absent from the database
 *    -> 409 with a machine-readable `code` and the sanitized `reason`.
 *
 * 409 Conflict rather than 422: the request is well-formed and names a real
 * resource, but the resource's current STATE (rejected at ingest) conflicts
 * with serving it. 422 is about the request content, and a GET has none.
 *
 * Pinned at three levels: the response mapping the routes use, the routes
 * at the buildServer seam, and end-to-end through `start()` over a corpus that
 * genuinely cannot be priced.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { SessionRejectedErrorSchema, type SessionRejectedErrorDto } from '@agenthropic/shared';
import { getFixture } from '@agenthropic/test-fixtures';
import { openDatabase, runMigrations, start } from '../src/index';
import { buildServer } from '../src/server';
import {
  rejectionBody,
  rejectionResponse,
  splitErrno,
  type IngestRejection,
} from '../src/api/ingest-rejections';
import type { SubstrateProvider } from '../src/api/substrate-provider';
import { createMigratedTempDb, insertSession, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

describe('rejectionResponse', () => {
  it('re-sanitizes the reason, so nothing path-shaped or multi-line can reach a body', () => {
    const { body, errno } = rejectionResponse({
      code: 'quarantined',
      reason: 'cannot open /Users/someone/.claude/projects/x.jsonl\nsecond line',
    });

    expect(body.reason).toBe('cannot open <path> second line');
    expect(body.code).toBe('quarantined');
    expect(errno).toEqual([]);
  });

  it('moves errno codes to the log side and keeps the body path-free', () => {
    const { body, errno } = rejectionResponse({
      code: 'ingest-failing',
      reason: "EACCES: permission denied, open '/Users/someone/x.jsonl'",
    });

    expect(Value.Check(SessionRejectedErrorSchema, body)).toBe(true);
    expect(body.reason).toBe("permission denied, open '<path>'");
    expect(errno).toEqual(['EACCES']);
  });
});

describe('splitErrno', () => {
  it('moves errno codes out of the text, for the log only', () => {
    expect(splitErrno("EACCES: permission denied, open '<path>'")).toEqual({
      text: "permission denied, open '<path>'",
      errno: ['EACCES'],
    });
  });

  it('leaves a reason with no errno code untouched', () => {
    expect(splitErrno('no price for model claude-x')).toEqual({
      text: 'no price for model claude-x',
      errno: [],
    });
  });

  it('does not mistake an ordinary upper-case word for an errno code', () => {
    expect(splitErrno('ERROR in EOF handling')).toEqual({
      text: 'ERROR in EOF handling',
      errno: [],
    });
  });

  it('never leaves the body empty when the reason was nothing but a code', () => {
    expect(splitErrno('EIO')).toEqual({ text: 'I/O failure (see the server log)', errno: ['EIO'] });
  });
});

describe('rejectionBody', () => {
  it('names the quarantine and what re-admits the session', () => {
    const body = rejectionBody({ code: 'quarantined', reason: 'no price for model m' });

    expect(Value.Check(SessionRejectedErrorSchema, body)).toBe(true);
    expect(body.code).toBe('quarantined');
    expect(body.reason).toBe('no price for model m');
    expect(body.error).toContain('quarantined');
    expect(body.error).toContain('pricing table');
    expect(body.error).toContain('no price for model m');
  });

  it('says a failing session will be retried', () => {
    const body = rejectionBody({ code: 'ingest-failing', reason: 'unexpected end of JSON' });

    expect(body.code).toBe('ingest-failing');
    expect(body.error).toContain('retried on the next pass');
    expect(body.error).toContain('unexpected end of JSON');
  });
});

/** Every per-session read endpoint, with the call that reaches its not-found arm. */
const ENDPOINTS = [
  '/api/sessions/SID',
  '/api/sessions/SID/tree',
  '/api/sessions/SID/events',
  '/api/sessions/SID/cost-analysis',
] as const;

const notFoundProvider: SubstrateProvider = {
  loadSession: () => ({ kind: 'session-not-found' }),
};

describe('per-session reads: rejected (409) vs unknown (404)', () => {
  let temp: TempDb | undefined;

  afterEach(() => {
    temp?.cleanup();
    temp = undefined;
  });

  function server(rejection: (id: string) => IngestRejection | undefined) {
    temp = createMigratedTempDb();
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 0,
      db: temp.db,
      substrateProvider: notFoundProvider,
      ingestRejection: rejection,
    });
    const lines: string[] = [];
    app.addHook('onRequest', (request, _reply, done) => {
      request.log.warn = ((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      }) as typeof request.log.warn;
      done();
    });
    return { app, lines };
  }

  it.each(ENDPOINTS)(
    '%s answers 409 with the code and reason for a quarantined session',
    async (path) => {
      const { app, lines } = server((id) =>
        id === 'SID'
          ? { code: 'quarantined', reason: "EACCES: permission denied, open '<path>'" }
          : undefined,
      );
      try {
        const response = await app.inject({ method: 'GET', url: path, headers: AUTH });

        expect(response.statusCode).toBe(409);
        const body = response.json<SessionRejectedErrorDto>();
        expect(Value.Check(SessionRejectedErrorSchema, body)).toBe(true);
        expect(body.code).toBe('quarantined');
        // The errno is an operator fact: the log carries it, the body does not.
        expect(body.reason).toBe("permission denied, open '<path>'");
        expect(JSON.stringify(body)).not.toContain('EACCES');
        expect(lines.join('\n')).toContain('EACCES');
        expect(lines.join('\n')).toContain('SID');
      } finally {
        await app.close();
      }
    },
  );

  it.each(ENDPOINTS)(
    '%s answers 409 ingest-failing for a session still being retried',
    async (path) => {
      const { app } = server(() => ({ code: 'ingest-failing', reason: 'no price for model m' }));
      try {
        const response = await app.inject({ method: 'GET', url: path, headers: AUTH });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          code: 'ingest-failing',
          reason: 'no price for model m',
        });
      } finally {
        await app.close();
      }
    },
  );

  it.each(ENDPOINTS)('%s keeps 404 for a session ingest never rejected', async (path) => {
    const { app } = server(() => undefined);
    try {
      const response = await app.inject({ method: 'GET', url: path, headers: AUTH });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Session not found.' });
    } finally {
      await app.close();
    }
  });

  it.each(ENDPOINTS.slice(0, 3))(
    '%s keeps serving the last good pass of a session quarantined after it',
    async (path) => {
      // A session can be quarantined at the pricing gate AFTER a clean ingest;
      // its rows from that pass are still there, and are still the truth as of
      // that pass. Rejection only replaces a 404, never a 200.
      const { app } = server(() => ({ code: 'quarantined', reason: 'no price' }));
      insertSession(temp!.db, 'SID');
      try {
        const response = await app.inject({ method: 'GET', url: path, headers: AUTH });

        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    },
  );

  it('keeps 404 when no rejection seam is wired at all', async () => {
    temp = createMigratedTempDb();
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0, db: temp.db });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sessions/SID',
        headers: AUTH,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('end to end: a corpus session that cannot be priced', () => {
  const SLUG = '-Users-synthetic-unpriceable-project';
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers 409 ingest-failing after the replay, then 409 quarantined once the budget is spent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-rejected-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agent.db');
    const corpusRoot = join(dir, 'projects');
    const db = openDatabase(dbPath);
    runMigrations(db);
    db.close();

    // Priced against `synthetic-model-a`, whose rows are deliberately NOT
    // seeded - the halt gate refuses the session on every pass.
    const fixture = getFixture('flat-tool-use');
    const sessionId = fixture.files
      .find((f) => !f.relativePath.includes('/'))!
      .relativePath.slice(0, -'.jsonl'.length);
    for (const f of fixture.files) {
      const rel = f.relativePath.includes('/')
        ? join(sessionId, ...f.relativePath.split('/'))
        : f.relativePath;
      const abs = join(corpusRoot, SLUG, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.lines.join('\n') + '\n');
    }

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      CLAUDE_PROJECTS_DIR: corpusRoot,
      DASHBOARD_POLL_INTERVAL_MS: '20',
    });
    try {
      const get = (url: string) => server.app.inject({ method: 'GET', url, headers: AUTH });

      // The replay was attempt 1 of the budget; the poll loop has not had a
      // turn yet (start() returns before its first interval can fire).
      const failing = await get(`/api/sessions/${sessionId}`);
      expect(failing.statusCode).toBe(409);
      const failingBody = failing.json<SessionRejectedErrorDto>();
      expect(failingBody.code).toBe('ingest-failing');
      expect(failingBody.reason).toContain('synthetic-model-a');
      // Corpus-relative at most: the temp directory never reaches the body.
      expect(JSON.stringify(failingBody)).not.toContain(dir);

      // An id nobody has ever seen is still simply not found.
      expect((await get('/api/sessions/00000000-0000-0000-0000-000000000000')).statusCode).toBe(
        404,
      );

      await vi.waitFor(
        async () => {
          const health = await get('/api/health');
          expect(health.json()).toMatchObject({ sessionsQuarantined: 1 });
        },
        { timeout: 5000, interval: 20 },
      );
      const quarantined = await get(`/api/sessions/${sessionId}/tree`);
      expect(quarantined.statusCode).toBe(409);
      expect(quarantined.json<SessionRejectedErrorDto>().code).toBe('quarantined');
    } finally {
      await server.close();
    }
  });
});
