import { isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DB_PATH,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PORT,
  DEFAULT_RETENTION_BACKUP_DAYS,
  DEFAULT_RETENTION_BACKUP_KEEP_MIN,
  DEFAULT_RETENTION_EVENTS_DAYS,
  DEFAULT_WATCHDOG_MINUTES,
  DEFAULT_WEB_ROOT,
  HOST,
  loadConfig,
} from '../src/config';
import { TEST_TOKEN } from './helpers';

describe('config (WP-U0)', () => {
  it('exports the bind host as the loopback constant with no config path', () => {
    expect(HOST).toBe('127.0.0.1');
  });

  it('throws without DASHBOARD_TOKEN - the server never starts without auth', () => {
    expect(() => loadConfig({})).toThrow(/DASHBOARD_TOKEN/);
  });

  it('throws on an empty DASHBOARD_TOKEN', () => {
    expect(() => loadConfig({ DASHBOARD_TOKEN: '' })).toThrow(/DASHBOARD_TOKEN/);
  });

  it('throws on a too-short DASHBOARD_TOKEN', () => {
    expect(() => loadConfig({ DASHBOARD_TOKEN: 'short' })).toThrow(/too short/);
  });

  it('applies defaults for every optional key', () => {
    const config = loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN });
    expect(config).toEqual({
      token: TEST_TOKEN,
      port: DEFAULT_PORT,
      dbPath: DEFAULT_DB_PATH,
      ingestEnabled: true,
      corpusRoot: null,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      watchdogMinutes: DEFAULT_WATCHDOG_MINUTES,
      webRoot: DEFAULT_WEB_ROOT,
      retention: {
        eventsDays: DEFAULT_RETENTION_EVENTS_DAYS,
        backupDays: DEFAULT_RETENTION_BACKUP_DAYS,
        backupKeepMinimum: DEFAULT_RETENTION_BACKUP_KEEP_MIN,
      },
    });
  });

  describe('web root (single-port static site)', () => {
    it('defaults to the built SPA directory, resolved from this module - never from cwd', () => {
      // Derived independently, from the TEST file's own URL: `src/config.ts`
      // and `test/config.test.ts` sit one level below `apps/server`, so the
      // same `../../web/dist` hop must land on the same absolute directory. If
      // the default were ever computed from `process.cwd()`, this equality
      // would hold only when the suite happened to run from `apps/server`.
      const fromThisModule = fileURLToPath(new URL('../../web/dist', import.meta.url));
      expect(DEFAULT_WEB_ROOT).toBe(fromThisModule);
      expect(isAbsolute(DEFAULT_WEB_ROOT)).toBe(true);
      expect(DEFAULT_WEB_ROOT.endsWith(join('apps', 'web', 'dist'))).toBe(true);
      // Nothing relative, and no leftover URL escaping in the path.
      expect(DEFAULT_WEB_ROOT).not.toContain(`${sep}..${sep}`);
      expect(DEFAULT_WEB_ROOT).not.toContain('%2');
    });

    it('reads DASHBOARD_WEB_ROOT as the override', () => {
      const config = loadConfig({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_WEB_ROOT: '/tmp/fake-web-root',
      });
      expect(config.webRoot).toBe('/tmp/fake-web-root');
    });

    it('treats an empty DASHBOARD_WEB_ROOT as unset (never cwd)', () => {
      expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_WEB_ROOT: '' }).webRoot).toBe(
        DEFAULT_WEB_ROOT,
      );
    });
  });

  it('reads DASHBOARD_PORT and DASHBOARD_DB_PATH overrides', () => {
    const config = loadConfig({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: '/tmp/x/agent.db',
    });
    expect(config.port).toBe(0);
    expect(config.dbPath).toBe('/tmp/x/agent.db');
  });

  it('treats an empty DASHBOARD_PORT as the default', () => {
    expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_PORT: '' }).port).toBe(DEFAULT_PORT);
  });

  it.each(['abc', '-1', '65536', '12.5'])('rejects invalid DASHBOARD_PORT %s', (raw) => {
    expect(() => loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_PORT: raw })).toThrow(
      /Invalid DASHBOARD_PORT/,
    );
  });

  describe('ingest keys (WP-IN10/IN5/IN12)', () => {
    it.each(['1', 'true', ''])('DASHBOARD_INGEST %j keeps ingest enabled', (raw) => {
      expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_INGEST: raw }).ingestEnabled).toBe(
        true,
      );
    });

    it.each(['0', 'false'])('DASHBOARD_INGEST %j disables ingest', (raw) => {
      expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_INGEST: raw }).ingestEnabled).toBe(
        false,
      );
    });

    it.each(['yes', 'no', '2', 'off'])('rejects unparseable DASHBOARD_INGEST %s', (raw) => {
      expect(() => loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_INGEST: raw })).toThrow(
        /Invalid DASHBOARD_INGEST/,
      );
    });

    it('reads CLAUDE_PROJECTS_DIR as the corpus root override', () => {
      const config = loadConfig({
        DASHBOARD_TOKEN: TEST_TOKEN,
        CLAUDE_PROJECTS_DIR: '/tmp/fake-corpus',
      });
      expect(config.corpusRoot).toBe('/tmp/fake-corpus');
    });

    it('treats an empty CLAUDE_PROJECTS_DIR as unset (never cwd)', () => {
      expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, CLAUDE_PROJECTS_DIR: '' }).corpusRoot).toBe(
        null,
      );
    });

    it('reads DASHBOARD_POLL_INTERVAL_MS and DASHBOARD_WATCHDOG_MINUTES overrides', () => {
      const config = loadConfig({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_POLL_INTERVAL_MS: '250',
        DASHBOARD_WATCHDOG_MINUTES: '3',
      });
      expect(config.pollIntervalMs).toBe(250);
      expect(config.watchdogMinutes).toBe(3);
    });

    it('treats empty numeric overrides as the defaults', () => {
      const config = loadConfig({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_POLL_INTERVAL_MS: '',
        DASHBOARD_WATCHDOG_MINUTES: '',
      });
      expect(config.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
      expect(config.watchdogMinutes).toBe(DEFAULT_WATCHDOG_MINUTES);
    });

    it.each(['0', '-5', 'abc', '2.5'])('rejects invalid DASHBOARD_POLL_INTERVAL_MS %s', (raw) => {
      expect(() =>
        loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_POLL_INTERVAL_MS: raw }),
      ).toThrow(/Invalid DASHBOARD_POLL_INTERVAL_MS/);
    });

    it.each(['0', '-1', 'soon', '1.5'])('rejects invalid DASHBOARD_WATCHDOG_MINUTES %s', (raw) => {
      expect(() =>
        loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_WATCHDOG_MINUTES: raw }),
      ).toThrow(/Invalid DASHBOARD_WATCHDOG_MINUTES/);
    });
  });
});

describe('retention keys (WP-D10, D3 signed 2026-09-08)', () => {
  it('ships the signed numbers as defaults: 90 / 30 / 7', () => {
    expect(DEFAULT_RETENTION_EVENTS_DAYS).toBe(90);
    expect(DEFAULT_RETENTION_BACKUP_DAYS).toBe(30);
    expect(DEFAULT_RETENTION_BACKUP_KEEP_MIN).toBe(7);
    expect(loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN }).retention).toEqual({
      eventsDays: 90,
      backupDays: 30,
      backupKeepMinimum: 7,
    });
  });

  it('parses explicit windows and floor', () => {
    expect(
      loadConfig({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_RETENTION_EVENTS_DAYS: '180',
        DASHBOARD_RETENTION_BACKUP_DAYS: '60',
        DASHBOARD_RETENTION_BACKUP_KEEP_MIN: '3',
      }).retention,
    ).toEqual({ eventsDays: 180, backupDays: 60, backupKeepMinimum: 3 });
  });

  it('treats an empty string as unset', () => {
    expect(
      loadConfig({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_RETENTION_EVENTS_DAYS: '',
        DASHBOARD_RETENTION_BACKUP_DAYS: '',
        DASHBOARD_RETENTION_BACKUP_KEEP_MIN: '',
        DASHBOARD_RETENTION_TOKEN_USAGE_DAYS: '',
      }).retention,
    ).toEqual({ eventsDays: 90, backupDays: 30, backupKeepMinimum: 7 });
  });

  it('0 is the documented off switch for both windows', () => {
    expect(
      loadConfig({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_RETENTION_EVENTS_DAYS: '0',
        DASHBOARD_RETENTION_BACKUP_DAYS: '0',
      }).retention,
    ).toEqual({ eventsDays: 0, backupDays: 0, backupKeepMinimum: 7 });
  });

  it.each(['-1', 'abc', '2.5'])('rejects DASHBOARD_RETENTION_EVENTS_DAYS %s', (raw) => {
    expect(() =>
      loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_RETENTION_EVENTS_DAYS: raw }),
    ).toThrow(/Invalid DASHBOARD_RETENTION_EVENTS_DAYS .*non-negative integer \(0 disables\)/);
  });

  it.each(['-1', 'abc', '2.5'])('rejects DASHBOARD_RETENTION_BACKUP_DAYS %s', (raw) => {
    expect(() =>
      loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_RETENTION_BACKUP_DAYS: raw }),
    ).toThrow(/Invalid DASHBOARD_RETENTION_BACKUP_DAYS .*non-negative integer/);
  });

  it.each(['0', '-1', 'x', '1.5'])(
    'rejects DASHBOARD_RETENTION_BACKUP_KEEP_MIN %s: the floor is at least one file',
    (raw) => {
      expect(() =>
        loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_RETENTION_BACKUP_KEEP_MIN: raw }),
      ).toThrow(/Invalid DASHBOARD_RETENTION_BACKUP_KEEP_MIN .*positive integer/);
    },
  );

  it('refuses DASHBOARD_RETENTION_TOKEN_USAGE_DAYS loudly: token_usage is never pruned', () => {
    expect(() =>
      loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_RETENTION_TOKEN_USAGE_DAYS: '30' }),
    ).toThrow(/DASHBOARD_RETENTION_TOKEN_USAGE_DAYS is set, but token_usage is never pruned/);
  });
});
