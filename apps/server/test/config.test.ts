import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DB_PATH,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PORT,
  DEFAULT_WATCHDOG_MINUTES,
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
