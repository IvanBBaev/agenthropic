/**
 * Review M-18 - cross-session usage-ownership visibility. The M-12 rule gives a
 * `message_id` to the session that ingested it FIRST; a resume/fork replay of
 * the same conversation deliberately does not re-count that spend. That is
 * correct, but silent: the second session's dollar total is legitimately lower
 * than its transcript suggests, and nothing on the running server said why.
 * This file pins the counter that closes the gap - at the `buildServer` seam
 * (present / absent / a genuine zero) and end-to-end through the real
 * composition root over a corpus that actually collides.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFixture, type Fixture } from '@agenthropic/test-fixtures';
import { openDatabase, runMigrations, start } from '../src/index';
import { buildServer } from '../src/server';
import { TEST_TOKEN } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

describe('/api/health cross-session usage collisions (review M-18)', () => {
  it("mirrors the seam's answer", async () => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0, usageCollisions: () => 4 });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });

      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({
        status: 'ok',
        schemaVersion: 0,
        crossSessionUsageCollisions: 4,
      });
    } finally {
      await app.close();
    }
  });

  it('reports a genuine zero rather than hiding it', async () => {
    // Zero here is a FACT the seam observed ("nothing collided since boot"), not
    // the absence of an answer - the omission rule below is about the latter.
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0, usageCollisions: () => 0 });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });

      expect(health.json()).toEqual({
        status: 'ok',
        schemaVersion: 0,
        crossSessionUsageCollisions: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('omits the field entirely when no ingest seam is wired', async () => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 0 });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });

      expect(health.json()).toEqual({ status: 'ok', schemaVersion: 0 });
    } finally {
      await app.close();
    }
  });
});

describe('the collision counter over a really colliding corpus (M-12 -> M-18)', () => {
  const SLUG = '-Users-synthetic-collision-project';
  /** The resumed/forked copy: a different session uuid, the SAME message ids. */
  const FORK_ID = '99999999-9999-4999-8999-999999999999';
  const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** The bare no-slash `<uuid>.jsonl` main is the only file enumeration keys on. */
  function mainSessionIdOf(fixture: Fixture): string {
    const main = fixture.files.find((f) => !f.relativePath.includes('/'));
    return main!.relativePath.slice(0, -'.jsonl'.length);
  }

  function write(corpusRoot: string, relativePath: string, body: string): void {
    const abs = join(corpusRoot, SLUG, relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  function seedDb(dbPath: string): void {
    const db = openDatabase(dbPath);
    runMigrations(db);
    const insert = db.prepare(
      'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, 1, ?)',
    );
    for (const bucket of BUCKETS) {
      insert.run('synthetic-model-a', bucket, '2020-01-01');
    }
    db.close();
  }

  it('counts the skipped messages and surfaces the running total on /api/health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-collision-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agent.db');
    const corpusRoot = join(dir, 'projects');
    seedDb(dbPath);

    const fixture = getFixture('flat-tool-use');
    const sessionId = mainSessionIdOf(fixture);
    for (const f of fixture.files) {
      const rel = f.relativePath.includes('/')
        ? join(sessionId, ...f.relativePath.split('/'))
        : f.relativePath;
      write(corpusRoot, rel, f.lines.join('\n') + '\n');
    }
    // The fork: the same main transcript re-keyed to a NEW session uuid. Only
    // the sessionId field is rewritten (split/join on the literal uuid, not a
    // regex), so every message id stays byte-equal — which is exactly what a
    // real `--resume` replay looks like on disk, and what M-12 keys on.
    const mainLines = fixture.files.find((f) => !f.relativePath.includes('/'))!.lines;
    write(
      corpusRoot,
      `${FORK_ID}.jsonl`,
      mainLines.map((line) => line.split(sessionId).join(FORK_ID)).join('\n') + '\n',
    );

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      CLAUDE_PROJECTS_DIR: corpusRoot,
      DASHBOARD_POLL_INTERVAL_MS: '600000', // park the poll loop far away
    });
    try {
      // Both sessions ingest successfully — a collision is not a failure.
      const sessions = await server.app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: AUTH,
      });
      expect((sessions.json() as { sessions: unknown[] }).sessions).toHaveLength(2);

      // The owner keeps its rows; the fork's duplicate message contributes none.
      const rows = (
        server.db
          .prepare('SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ?')
          .get(FORK_ID) as { n: number }
      ).n;
      expect(rows).toBe(0);

      const health = await server.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: AUTH,
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        status: 'ok',
        crossSessionUsageCollisions: 1,
      });
      // The log line and the counter are complements, not substitutes: the line
      // says it happened once, the counter still says it when the scrollback is
      // gone. Neither carries a message id — a collision is an integrity
      // signal, not a payload channel.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('owned by another session'));
    } finally {
      await server.close();
    }
  });
});
