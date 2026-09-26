import { describe, expect, it } from 'vitest';
import { DEFAULT_DB_PATH, loadConfig } from '../src/config';
import { TEST_TOKEN } from './helpers';

/**
 * Numeric env parsing must accept plain decimal digits only. `Number()` is far
 * more lenient: whitespace becomes 0, and hex / exponent / decimal-point forms
 * become integers. A blank `DASHBOARD_RETENTION_EVENTS_DAYS=' '` silently turned
 * pruning OFF, and a blank `DASHBOARD_PORT=' '` silently bound a random port.
 */
describe('config numeric parsing is strict', () => {
  const numericKeys = [
    'DASHBOARD_PORT',
    'DASHBOARD_POLL_INTERVAL_MS',
    'DASHBOARD_WATCHDOG_MINUTES',
    'DASHBOARD_RETENTION_EVENTS_DAYS',
    'DASHBOARD_RETENTION_BACKUP_DAYS',
    'DASHBOARD_RETENTION_BACKUP_KEEP_MIN',
  ] as const;
  const malformed = [' ', '\t', '0x10', '1e2', '12.0', '+5', ' 7 '];

  for (const key of numericKeys) {
    for (const raw of malformed) {
      it(`refuses ${key}=${JSON.stringify(raw)}`, () => {
        expect(() => loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, [key]: raw })).toThrow(
          new RegExp(`Invalid ${key}`),
        );
      });
    }
  }

  it('still accepts plain decimal digits', () => {
    const config = loadConfig({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_POLL_INTERVAL_MS: '2147483647',
      DASHBOARD_RETENTION_EVENTS_DAYS: '0',
    });
    expect(config.port).toBe(0);
    expect(config.pollIntervalMs).toBe(2_147_483_647);
    expect(config.retention.eventsDays).toBe(0);
  });

  it('refuses a poll interval above the timer ceiling (Node clamps it to 1 ms)', () => {
    expect(() =>
      loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_POLL_INTERVAL_MS: '2147483648' }),
    ).toThrow(/Invalid DASHBOARD_POLL_INTERVAL_MS/);
  });
});

describe('config DASHBOARD_DB_PATH house rule', () => {
  it('treats an empty DASHBOARD_DB_PATH as unset, never as an anonymous temp DB', () => {
    const config = loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_DB_PATH: '' });
    expect(config.dbPath).toBe(DEFAULT_DB_PATH);
  });
});
