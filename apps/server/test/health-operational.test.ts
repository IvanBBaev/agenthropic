/**
 * R11 / OPS-5 + OPS-6 - /api/health says whether the dashboard is WORKING,
 * not only whether it is up: when the corpus was last read and whether it is
 * in trouble, when the database was last backed up and whether the last
 * attempt failed, how big the database and its WAL are, and how hook
 * deliveries ended since boot. `status` keeps its two values. Each unknown
 * field is omitted, never faked. Plus the DASHBOARD_LOG_LEVEL knob.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventStorePort } from '@agenthropic/shared';
import { InMemoryEventStore } from '@agenthropic/shared';
import { DEFAULT_LOG_LEVEL, loadConfig } from '../src/config';
import {
  errorDeliveryOutcome,
  HOOK_EVENT_PATH,
  registerHookRoutes,
  type HookDeliveryOutcome,
} from '../src/hooks/routes';
import { newestBackupTime, operationalHealth, scheduleDailyBackups, start } from '../src/index';
import { NO_RETENTION } from '../src/retention/policy';
import { createRetentionRunner } from '../src/retention/runner';
import { buildLoggerOptions, buildServer } from '../src/server';
import { createMigratedTempDb, TEST_TOKEN } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const HOOK_BODY = { hook_event_name: 'Stop', session_id: 'session-1' };
const ZERO = { stored: 0, duplicate: 0, unauthorized: 0, rejected: 0, failed: 0 };

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthropic-r11-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the operationalHealth seam on buildServer', () => {
  it('spreads what the seam returns next to the existing fields', async () => {
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 3,
      operationalHealth: () => ({
        lastTickAt: '2026-11-08T10:00:00.000Z',
        corpusTrouble: 'read-error',
        lastBackupAt: '2026-11-08T03:00:00.000Z',
        lastBackupError: 'disk full',
        dbBytes: 4096,
        walBytes: 0,
        hookDeliveries: { ...ZERO, stored: 2 },
      }),
    });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({
        status: 'ok',
        schemaVersion: 3,
        lastTickAt: '2026-11-08T10:00:00.000Z',
        corpusTrouble: 'read-error',
        lastBackupAt: '2026-11-08T03:00:00.000Z',
        lastBackupError: 'disk full',
        dbBytes: 4096,
        walBytes: 0,
        hookDeliveries: { ...ZERO, stored: 2 },
      });
    } finally {
      await app.close();
    }
  });

  it('an empty answer adds nothing, and no seam adds nothing', async () => {
    for (const app of [
      buildServer({ token: TEST_TOKEN, schemaVersion: 0, operationalHealth: () => ({}) }),
      buildServer({ token: TEST_TOKEN, schemaVersion: 0 }),
    ]) {
      try {
        const health = await app.inject({ method: 'GET', url: '/api/health', headers: AUTH });
        expect(health.json()).toEqual({ status: 'ok', schemaVersion: 0 });
      } finally {
        await app.close();
      }
    }
  });
});

describe('operationalHealth()', () => {
  it('reports every known field', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'agent.db');
    writeFileSync(dbPath, Buffer.alloc(100));
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(30));
    const counters = { ...ZERO, failed: 1 };
    const result = operationalHealth({
      dbPath,
      ingest: { lastTickAt: new Date('2026-11-08T10:00:00.000Z'), corpusTrouble: 'no-corpus-root' },
      backup: { lastBackupAt: new Date('2026-11-08T03:00:00.000Z'), lastError: 'disk full' },
      hookDeliveries: counters,
    });
    expect(result).toEqual({
      lastTickAt: '2026-11-08T10:00:00.000Z',
      corpusTrouble: 'no-corpus-root',
      lastBackupAt: '2026-11-08T03:00:00.000Z',
      lastBackupError: 'disk full',
      dbBytes: 100,
      walBytes: 30,
      hookDeliveries: { ...ZERO, failed: 1 },
    });
    // A snapshot, not the live counter object.
    counters.failed = 5;
    expect(result.hookDeliveries?.failed).toBe(1);
  });

  it('omits what is unknown; a missing WAL is a genuine 0', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'agent.db');
    writeFileSync(dbPath, Buffer.alloc(10));
    expect(
      operationalHealth({
        dbPath,
        ingest: { lastTickAt: null, corpusTrouble: null },
        backup: { lastBackupAt: null, lastError: null },
        hookDeliveries: ZERO,
      }),
    ).toEqual({ dbBytes: 10, walBytes: 0, hookDeliveries: ZERO });
    expect(
      operationalHealth({
        dbPath: join(dir, 'missing.db'),
        ingest: null,
        backup: null,
        hookDeliveries: ZERO,
      }),
    ).toEqual({ hookDeliveries: ZERO });
  });
});

describe('newestBackupTime()', () => {
  it('is null for a missing directory and for one without backups', () => {
    const dir = tempDir();
    expect(newestBackupTime(join(dir, 'nope'))).toBeNull();
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'agenthropic-x.db.partial'), 'x');
    expect(newestBackupTime(dir)).toBeNull();
  });

  it('answers the newest backup mtime and skips a file that vanished', () => {
    const dir = tempDir();
    const older = join(dir, 'agenthropic-2026-11-01T03-00-00-000Z.db');
    const newer = join(dir, 'agenthropic-2026-11-02T03-00-00-000Z-pre-migration-v3.db');
    writeFileSync(older, 'x');
    writeFileSync(newer, 'x');
    utimesSync(older, new Date('2026-11-01T03:00:00Z'), new Date('2026-11-01T03:00:00Z'));
    utimesSync(newer, new Date('2026-11-02T03:00:00Z'), new Date('2026-11-02T03:00:00Z'));
    // A dangling symlink: listed by readdir, refused by stat.
    symlinkSync(join(dir, 'gone'), join(dir, 'agenthropic-dangling.db'));
    expect(newestBackupTime(dir)?.toISOString()).toBe('2026-11-02T03:00:00.000Z');
  });
});

describe('BackupScheduler.state()', () => {
  it('starts from the seed, records a failure, and a success clears it', async () => {
    const temp = createMigratedTempDb();
    const seed = new Date('2026-11-07T03:00:00.000Z');
    const cycle = new Date('2026-11-08T03:00:00.000Z');
    let fail = true;
    const scheduler = scheduleDailyBackups(
      temp.db,
      join(temp.dir, 'backups'),
      createRetentionRunner(temp.db, NO_RETENTION),
      {
        intervalMs: 60_000,
        now: () => cycle,
        backup: () => (fail ? Promise.reject(new Error('disk full')) : Promise.resolve()),
        log: () => undefined,
        logError: () => undefined,
        lastBackupAt: seed,
      },
    );
    try {
      expect(scheduler.state()).toEqual({ lastBackupAt: seed, lastError: null });
      await scheduler.runOnce();
      expect(scheduler.state()).toEqual({ lastBackupAt: seed, lastError: 'disk full' });
      fail = false;
      await scheduler.runOnce();
      expect(scheduler.state()).toEqual({ lastBackupAt: cycle, lastError: null });
    } finally {
      scheduler.stop();
      temp.cleanup();
    }
  });

  it('has no last backup without a seed', () => {
    const temp = createMigratedTempDb();
    const scheduler = scheduleDailyBackups(
      temp.db,
      join(temp.dir, 'backups'),
      createRetentionRunner(temp.db, NO_RETENTION),
    );
    try {
      expect(scheduler.state()).toEqual({ lastBackupAt: null, lastError: null });
    } finally {
      scheduler.stop();
      temp.cleanup();
    }
  });
});

describe('hook delivery outcomes', () => {
  it('maps error statuses', () => {
    expect(errorDeliveryOutcome(401)).toBe('unauthorized');
    expect(errorDeliveryOutcome(400)).toBe('rejected');
    expect(errorDeliveryOutcome(413)).toBe('rejected');
    expect(errorDeliveryOutcome(500)).toBe('failed');
  });

  async function appWith(store: EventStorePort, outcomes: HookDeliveryOutcome[]) {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, { eventStore: store, onDelivery: (o) => outcomes.push(o) });
    await app.ready();
    return app;
  }

  it('counts stored, duplicate, unauthorized and rejected deliveries', async () => {
    const outcomes: HookDeliveryOutcome[] = [];
    const app = await appWith(new InMemoryEventStore(), outcomes);
    try {
      const post = (headers: Record<string, string>, payload?: unknown) =>
        app.inject({ method: 'POST', url: HOOK_EVENT_PATH, headers, payload: payload as never });
      expect((await post(AUTH, HOOK_BODY)).statusCode).toBe(202);
      expect((await post(AUTH, HOOK_BODY)).statusCode).toBe(202);
      expect((await post({}, HOOK_BODY)).statusCode).toBe(401);
      expect((await post(AUTH)).statusCode).toBe(400);
      expect(outcomes).toEqual(['stored', 'duplicate', 'unauthorized', 'rejected']);
    } finally {
      await app.close();
    }
  });

  it('counts a throwing append as failed', async () => {
    const outcomes: HookDeliveryOutcome[] = [];
    const store: EventStorePort = {
      append: () => {
        throw new Error('SQLITE_FULL');
      },
      readAll: () => [],
    } as unknown as EventStorePort;
    const app = await appWith(store, outcomes);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOOK_EVENT_PATH,
        headers: AUTH,
        payload: HOOK_BODY,
      });
      expect(response.statusCode).toBe(500);
      expect(outcomes).toEqual(['failed']);
    } finally {
      await app.close();
    }
  });

  it('a route without the seam still answers every status', async () => {
    const app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, { eventStore: new InMemoryEventStore() });
    try {
      const response = await app.inject({ method: 'POST', url: HOOK_EVENT_PATH });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('DASHBOARD_LOG_LEVEL (OPS-6)', () => {
  it("defaults to 'warn'", () => {
    expect(DEFAULT_LOG_LEVEL).toBe('warn');
    expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN }).logLevel).toBe('warn');
    expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_LOG_LEVEL: '' }).logLevel).toBe(
      'warn',
    );
  });

  it('accepts a pino level and refuses anything else', () => {
    expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_LOG_LEVEL: 'debug' }).logLevel).toBe(
      'debug',
    );
    expect(() => loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_LOG_LEVEL: 'loud' })).toThrow(
      /Invalid DASHBOARD_LOG_LEVEL "loud"/,
    );
  });

  it('buildLoggerOptions maps true to info, silent to off, and keeps the redaction', () => {
    expect(buildLoggerOptions('silent')).toBe(false);
    expect(buildLoggerOptions(true)).toMatchObject({ level: 'info' });
    const options = buildLoggerOptions('warn') as {
      level: string;
      serializers: { req: (r: { method: string; url: string }) => { url: string } };
    };
    expect(options.level).toBe('warn');
    expect(options.serializers.req({ method: 'GET', url: '/api/stream?token=abc' }).url).toBe(
      '/api/stream?token=REDACTED',
    );
  });
});

describe('the R11 fields through start()', () => {
  function quiet(): void {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  }

  it('ingest off: sizes, a seeded backup time and live hook counters; no tick fields', async () => {
    quiet();
    const dir = tempDir();
    const dbPath = join(dir, 'agent.db');
    mkdirSync(join(dir, 'backups'));
    const backup = join(dir, 'backups', 'agenthropic-2026-11-07T03-00-00-000Z.db');
    writeFileSync(backup, 'x');
    utimesSync(backup, new Date('2026-11-07T03:00:00Z'), new Date('2026-11-07T03:00:00Z'));
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      DASHBOARD_INGEST: '0',
      DASHBOARD_LOG_LEVEL: 'silent',
    });
    try {
      await server.app.inject({
        method: 'POST',
        url: HOOK_EVENT_PATH,
        headers: AUTH,
        payload: HOOK_BODY,
      });
      await server.app.inject({ method: 'POST', url: HOOK_EVENT_PATH, payload: HOOK_BODY });
      const health = (
        await server.app.inject({ method: 'GET', url: '/api/health', headers: AUTH })
      ).json() as Record<string, unknown>;
      expect(health['status']).toBe('ok');
      expect(health['lastBackupAt']).toBe('2026-11-07T03:00:00.000Z');
      expect(health['dbBytes']).toBeGreaterThan(0);
      expect(health['walBytes']).toEqual(expect.any(Number));
      expect(health['hookDeliveries']).toEqual({ ...ZERO, stored: 1, unauthorized: 1 });
      expect(health).not.toHaveProperty('lastTickAt');
      expect(health).not.toHaveProperty('corpusTrouble');
      expect(health).not.toHaveProperty('lastBackupError');
    } finally {
      await server.close();
    }
  });

  it('ingest on: the last tick time, and the corpus trouble while the root is missing', async () => {
    quiet();
    const dir = tempDir();
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'agent.db'),
      CLAUDE_PROJECTS_DIR: join(dir, 'no-such-projects'),
      DASHBOARD_POLL_INTERVAL_MS: '600000',
      DASHBOARD_LOG_LEVEL: 'silent',
    });
    try {
      const health = (
        await server.app.inject({ method: 'GET', url: '/api/health', headers: AUTH })
      ).json() as Record<string, unknown>;
      expect(health['corpusTrouble']).toBe('no-corpus-root');
      expect(typeof health['lastTickAt']).toBe('string');
      expect(health).not.toHaveProperty('lastBackupAt');
    } finally {
      await server.close();
    }
  });
});
