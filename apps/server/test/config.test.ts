import { describe, expect, it } from 'vitest';
import { DEFAULT_DB_PATH, DEFAULT_PORT, HOST, loadConfig } from '../src/config';
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

  it('applies defaults for port and dbPath', () => {
    const config = loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN });
    expect(config).toEqual({ token: TEST_TOKEN, port: DEFAULT_PORT, dbPath: DEFAULT_DB_PATH });
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
});
