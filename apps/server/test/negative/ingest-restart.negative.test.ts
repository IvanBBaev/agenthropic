/**
 * WP-X4 negative-test catalogue — ingest / corpus / restart scenarios over
 * REAL disk corpora (mkdtemp roots; the real ~/.claude/projects is never
 * touched) and a real migrated SQLite db.
 *
 * Catalogue of record: docs/site/contributing/testing.md section 5 / 5.1:
 *
 *   #1 (token facet)  double ingest    -> no double token total
 *   #3 (db facet)     missing parent   -> parent_agent_id NULL, zero edges
 *   #8 (halt facet)   unpriced model   -> HALT before any write; isolation
 *   #9 (corpus facet) oversize file    -> skipped + surfaced, never a crash
 *   #10               server restart   -> resume, no dupes, watchdog 'unknown',
 *                                         events_raw untouchable
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PricingEntry } from '@agenthropic/core';
import { getFixture, type Fixture } from '@agenthropic/test-fixtures';
import {
  ingestSession,
  openDatabase,
  runCorpusIngest,
  runMigrations,
  start,
  type SkippedFile,
  type SqliteDatabase,
} from '../../src/index';
import { createMigratedTempDb, insertAgent, TEST_TOKEN } from '../helpers';

// --- shared scaffolding (mirrors apps/server/test/index.test.ts) ------------

const SLUG = '-Users-synthetic-negative-project';
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

/** Flat $1/MTok pricing for the synthetic fixture models. */
const PRICING: PricingEntry[] = ['synthetic-model-a', 'synthetic-model-b'].flatMap((model) =>
  BUCKETS.map((bucket) => ({
    model,
    bucket,
    usdPerMtok: 1,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  })),
);

function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function mainSessionIdOf(fixture: Fixture): string {
  const main = fixture.files.find((f) => !f.relativePath.includes('/'));
  return main!.relativePath.slice(0, -'.jsonl'.length);
}

/** Lay a fixture out on REAL disk the way Claude Code does (main + `<uuid>/` dir). */
function materializeFixture(corpusRoot: string, fixture: Fixture, sessionId: string): void {
  for (const f of fixture.files) {
    const rel = f.relativePath.includes('/')
      ? join(sessionId, ...f.relativePath.split('/'))
      : f.relativePath;
    const abs = join(corpusRoot, SLUG, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.lines.join('\n') + '\n');
  }
}

/** Migrate the db ahead of start() and seed prices for the fixture's models. */
function seedDb(dbPath: string): void {
  const db = openDatabase(dbPath);
  runMigrations(db);
  const insert = db.prepare(
    'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, 1, ?)',
  );
  for (const model of ['synthetic-model-a', 'synthetic-model-b']) {
    for (const bucket of BUCKETS) {
      insert.run(model, bucket, '2020-01-01');
    }
  }
  db.close();
}

function countRows(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function sumTokens(db: SqliteDatabase): number {
  return (
    db.prepare('SELECT COALESCE(SUM(tokens), 0) AS total FROM token_usage').get() as {
      total: number;
    }
  ).total;
}

/** The IngestDeps identity for direct ingestSession calls. */
function depsFor(db: SqliteDatabase) {
  return { db, pricing: PRICING, instance: 'negative-tests', hostId: 'test-host' };
}

describe('WP-X4 ingest/restart negative catalogue', () => {
  const dirs: string[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshDb(): SqliteDatabase {
    const tmp = createMigratedTempDb();
    cleanups.push(() => {
      tmp.cleanup();
    });
    return tmp.db;
  }

  // --- Scenario #1 (token facet) — double ingest, no double total -----------
  // Catalogue: "no duplicate normalized event or DOUBLE TOKEN TOTAL" — CD-2,
  // NFR-DATA-02, the P0 double-replay proof. The events_raw dedup facet lives
  // in hook-receiver.negative.test.ts.
  it('Scenario #1 — re-ingesting an unchanged session adds ZERO usage rows and ZERO tokens (CD-2, NFR-DATA-02)', () => {
    const db = freshDb();
    const fixture = getFixture('flat-tool-use');

    const first = ingestSession(fixture, depsFor(db));
    expect(first.ok).toBe(true);
    // 2 deduped messages x 5 buckets — zero-token buckets are stored too.
    expect(first.usageRowsInserted).toBe(10);
    const totalAfterFirst = sumTokens(db);
    expect(totalAfterFirst).toBeGreaterThan(0);

    const second = ingestSession(fixture, depsFor(db));
    expect(second.ok).toBe(true);
    expect(second.usageRowsInserted).toBe(0);
    expect(second.edgesInserted).toBe(0);
    expect(sumTokens(db)).toBe(totalAfterFirst); // the dollar substrate never doubles
    expect(countRows(db, 'token_usage')).toBe(10);
  });

  // --- Scenario #3 (db facet) — missing parent id ---------------------------
  // Catalogue: "orphan/pending reparent; no fake root" — CD-4 (self-ref
  // parent_agent_id), WP-D6 (orphan-safe self-FK), NFR-DATA-01. The parser
  // facet lives in packages/core/test/negative.
  it('Scenario #3 — an orphan persists with parent_agent_id NULL and ZERO edges (CD-4, WP-D6, NFR-DATA-01)', () => {
    const db = freshDb();
    const SESSION = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    const HEX = 'abcdef01';
    const substrate = {
      files: [
        {
          relativePath: `${SESSION}.jsonl`,
          lines: [
            jline({
              parentUuid: null,
              sessionId: SESSION,
              type: 'user',
              message: { role: 'user', content: 'Synthetic prompt, no Agent tool_use anywhere.' },
              uuid: 'cccccccc-0000-4000-8000-000000000001',
              timestamp: '2026-03-01T09:00:00.000Z',
            }),
          ],
        },
        {
          relativePath: `subagents/agent-${HEX}.jsonl`,
          lines: [
            jline({
              parentUuid: null,
              isSidechain: true,
              sessionId: SESSION,
              agentId: HEX,
              type: 'user',
              message: { role: 'user', content: 'Synthetic orphan task with no anchor.' },
              uuid: 'cccccccc-0000-4000-8000-000000000002',
              timestamp: '2026-03-01T09:00:02.000Z',
            }),
          ],
        },
      ],
    };

    const outcome = ingestSession(substrate, depsFor(db));
    expect(outcome.ok).toBe(true);

    const orphan = db.prepare('SELECT parent_agent_id, type FROM agents WHERE id = ?').get(HEX) as
      { parent_agent_id: string | null; type: string } | undefined;
    expect(orphan).toBeDefined();
    expect(orphan?.type).toBe('subagent');
    expect(orphan?.parent_agent_id).toBeNull(); // visible, honest — never a fake root
    expect(countRows(db, 'orchestration_edges')).toBe(0); // and never a fake edge
  });

  // --- Scenario #8 (halt facet) — unpriced model ----------------------------
  // Catalogue (hardened): "token counts shown; cost NOT silently zero" —
  // CD-3, CD-4, WP-C6. The halt gate runs BEFORE the write transaction:
  // an unpriceable session leaves the database completely untouched.
  it('Scenario #8 — an unpriced model HALTS ingest BEFORE any write (CD-3, CD-4, WP-C6)', () => {
    const db = freshDb();
    const fixture = getFixture('flat-tool-use');
    const unpriced = {
      files: fixture.files.map((f) => ({
        relativePath: f.relativePath,
        lines: f.lines.map((line) => line.replace(/synthetic-model-[ab]/g, 'unpriced-model-z')),
      })),
    };

    const outcome = ingestSession(unpriced, depsFor(db));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/refusing to price at \$0/);
    expect(outcome.error).toMatch(/unpriced-model-z/);

    // Not one partial row — sessions, agents, edges and usage all stay empty.
    expect(countRows(db, 'sessions')).toBe(0);
    expect(countRows(db, 'agents')).toBe(0);
    expect(countRows(db, 'orchestration_edges')).toBe(0);
    expect(countRows(db, 'token_usage')).toBe(0);
  });

  it('Scenario #8 — a poisoned session is ISOLATED: the healthy sibling still lands (CD-2, NFR-DATA-01)', () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-negative-isolation-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    const SESSION_BAD = 'dddddddd-4444-4444-8444-444444444444';

    const fixture = getFixture('flat-tool-use');
    materializeFixture(corpusRoot, fixture, mainSessionIdOf(fixture));
    const mainLines = fixture.files.find((f) => !f.relativePath.includes('/'))!.lines;
    writeFileSync(
      join(corpusRoot, SLUG, `${SESSION_BAD}.jsonl`),
      mainLines
        .map((line) =>
          line
            .replace(/synthetic-model-[ab]/g, 'unpriced-model-z')
            .replaceAll(mainSessionIdOf(fixture), SESSION_BAD),
        )
        .join('\n') + '\n',
    );

    const summary = runCorpusIngest({
      db,
      pricing: PRICING,
      env: { CLAUDE_PROJECTS_DIR: corpusRoot },
    });
    expect(summary.sessionsDiscovered).toBe(2);
    expect(summary.sessionsOk).toBe(1);
    expect(summary.sessionsFailed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.sessionId).toBe(SESSION_BAD);
    expect(summary.failures[0]?.error).toMatch(/refusing to price at \$0/);

    // The healthy session landed in full despite its poisoned sibling.
    expect(countRows(db, 'sessions')).toBe(1);
    expect(countRows(db, 'token_usage')).toBe(10);
  });

  // --- Scenario #9 (corpus facet) — huge payload ----------------------------
  // Catalogue: "rejected or truncated per policy; no UI lockup" — CD-10,
  // NFR-PERF-01. Corpus policy: an oversize transcript is SKIPPED and
  // SURFACED (onWarning + filesSkipped), while the rest of the session
  // ingests normally — never a crash, never a silent disappearance.
  it('Scenario #9 — an oversize agent transcript is skipped AND surfaced, session still lands (CD-10, NFR-PERF-01)', () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-negative-oversize-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');

    const fixture = getFixture('flat-tool-use');
    const sessionId = mainSessionIdOf(fixture);
    materializeFixture(corpusRoot, fixture, sessionId);
    // Pad the AGENT transcript past the limit; the main transcript stays
    // small so the session itself survives (built === null would silently
    // skip and never reach onWarning).
    appendFileSync(
      join(corpusRoot, SLUG, sessionId, 'subagents', 'agent-3fa9c2d1.jsonl'),
      jline({ pad: 'x'.repeat(8192) }) + '\n',
    );

    const warnings: SkippedFile[] = [];
    const summary = runCorpusIngest({
      db,
      pricing: PRICING,
      env: { CLAUDE_PROJECTS_DIR: corpusRoot },
      limits: { maxFileBytes: 4096 },
      onWarning: (skipped) => warnings.push(skipped),
    });

    expect(summary.sessionsOk).toBe(1); // no crash, no lockup, no lost session
    expect(summary.filesSkipped).toBeGreaterThanOrEqual(1);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        relativePath: 'subagents/agent-3fa9c2d1.jsonl',
        reason: 'oversize',
      }),
    );
    expect(countRows(db, 'sessions')).toBe(1);
  });

  // --- Scenario #10 — server restart mid-session ----------------------------
  // Catalogue: "resumes / marks stale via watchdog; raw events intact" —
  // CD-1 (replay-on-startup), NFR-OPS-01; refinement: stale agents surface as
  // the honest 'unknown', and events_raw is physically append-only (CD-4,
  // CD-7 "no UPDATE/DELETE path").
  it('Scenario #10 — kill + restart: no duplicates, appended usage lands once, stale agent goes unknown, events_raw intact (CD-1, NFR-OPS-01, CD-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-negative-restart-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agent.db');
    const corpusRoot = join(dir, 'projects');
    seedDb(dbPath);

    const fixture = getFixture('flat-tool-use');
    const sessionId = mainSessionIdOf(fixture);
    materializeFixture(corpusRoot, fixture, sessionId);

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env = {
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      CLAUDE_PROJECTS_DIR: corpusRoot,
      DASHBOARD_POLL_INTERVAL_MS: '600000', // park the poll loop; ticks come from start()
    };

    // ---- first life -------------------------------------------------------
    const first = await start(env);
    let hookRowCount: number;
    try {
      expect(countRows(first.db, 'sessions')).toBe(1);
      expect(countRows(first.db, 'token_usage')).toBe(10);

      const hook = await first.app.inject({
        method: 'POST',
        url: '/api/hooks/event',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        payload: { hook_event_name: 'SubagentStart', session_id: sessionId },
      });
      expect(hook.statusCode).toBe(202);
      expect(hook.json()).toEqual({ stored: true });
      hookRowCount = countRows(first.db, 'events_raw');
      expect(hookRowCount).toBeGreaterThanOrEqual(1);

      // A hook-announced agent whose Stop will never arrive: inserted AFTER
      // the replay tick, so it is still 'working' when the process dies.
      // (helpers stamp 2026-07-11 — long past the 10-minute window.)
      insertAgent(first.db, 'deadbea7', sessionId);
    } finally {
      await first.close(); // the "kill"
    }

    // ---- mid-downtime: the session grows on disk --------------------------
    appendFileSync(
      join(corpusRoot, SLUG, `${sessionId}.jsonl`),
      jline({
        parentUuid: 'aaaaaaaa-0000-4000-8000-000000000002',
        isSidechain: false,
        sessionId,
        type: 'assistant',
        message: {
          id: 'msg_synth_restart_0001',
          type: 'message',
          role: 'assistant',
          model: 'synthetic-model-a',
          content: [{ type: 'text', text: 'Synthetic turn appended while the server was down.' }],
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 7,
          },
        },
        uuid: 'aaaaaaaa-0000-4000-8000-000000000003',
        timestamp: '2026-01-15T11:00:00.000Z',
      }) + '\n',
    );

    // ---- second life ------------------------------------------------------
    const second = await start(env);
    try {
      // Resume, not duplicate: still ONE session; the appended message fans
      // out to exactly 5 new bucket rows (10 -> 15), the original 10 are NOT
      // re-inserted.
      expect(countRows(second.db, 'sessions')).toBe(1);
      expect(countRows(second.db, 'token_usage')).toBe(15);
      const appended = second.db
        .prepare('SELECT COUNT(*) AS n FROM token_usage WHERE message_id = ?')
        .get('msg_synth_restart_0001') as { n: number };
      expect(appended.n).toBe(5);

      // Raw events intact across the restart — nothing lost, nothing added.
      expect(countRows(second.db, 'events_raw')).toBe(hookRowCount);

      // The silent agent surfaced as the HONEST 'unknown' on the replay
      // tick's watchdog sweep; the terminal fixture agent was left alone.
      const stale = second.db.prepare('SELECT status FROM agents WHERE id = ?').get('deadbea7') as {
        status: string;
      };
      expect(stale.status).toBe('unknown');
      const fixtureChild = second.db
        .prepare('SELECT status FROM agents WHERE id = ?')
        .get('3fa9c2d1') as { status: string };
      expect(fixtureChild.status).toBe('completed');

      // CD-4 / CD-7: events_raw has NO update or delete path — the schema
      // triggers abort both, so "intact" is physics, not convention.
      expect(() =>
        second.db.prepare("UPDATE events_raw SET event_type = 'tampered'").run(),
      ).toThrow(/events_raw is append-only/);
      expect(() => second.db.prepare('DELETE FROM events_raw').run()).toThrow(
        /events_raw is append-only/,
      );
    } finally {
      await second.close();
    }
  });
});
