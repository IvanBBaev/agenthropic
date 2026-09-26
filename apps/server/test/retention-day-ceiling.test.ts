/**
 * Retention day windows have a ceiling.
 *
 * A window is turned into a cutoff with `new Date(now - days * 86_400_000)`,
 * and a Date outside +/-8.64e15 ms is invalid: `toISOString()` throws. A window
 * of about 1e8 days used to pass validation, boot the server, and then fail
 * every retention run. Because the runner prunes rows before it prunes backup
 * files, that failure also stopped the backup rule, which was valid, and
 * backups piled up. The only trace was one logged error a day. The ceiling
 * rejects such a window when the config is loaded.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import {
  assertRetentionPolicy,
  cutoffFor,
  MAX_RETENTION_DAYS,
  NO_RETENTION,
} from '../src/retention';
import { TEST_TOKEN } from './helpers';

const ABOVE = String(MAX_RETENTION_DAYS + 1);
const HUGE = '999999999';

describe('retention day ceiling', () => {
  it('is 100 years', () => {
    expect(MAX_RETENTION_DAYS).toBe(36_500);
  });

  it('yields a valid cutoff at the ceiling', () => {
    const now = new Date('2026-09-24T00:00:00.000Z');

    expect(cutoffFor(now, { maxAgeDays: MAX_RETENTION_DAYS })).toMatch(/^\d{4}-/);
  });

  describe('loadConfig', () => {
    it.each(['DASHBOARD_RETENTION_EVENTS_DAYS', 'DASHBOARD_RETENTION_BACKUP_DAYS'])(
      'accepts %s at the ceiling',
      (name) => {
        expect(() =>
          loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, [name]: String(MAX_RETENTION_DAYS) }),
        ).not.toThrow();
      },
    );

    it.each([
      ['DASHBOARD_RETENTION_EVENTS_DAYS', ABOVE],
      ['DASHBOARD_RETENTION_EVENTS_DAYS', HUGE],
      ['DASHBOARD_RETENTION_BACKUP_DAYS', ABOVE],
      ['DASHBOARD_RETENTION_BACKUP_DAYS', HUGE],
    ])('rejects %s=%s', (name, raw) => {
      expect(() => loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, [name]: raw })).toThrow(
        new RegExp(`Invalid ${name} .*up to 36500`),
      );
    });

    it('still accepts 0 as the off switch', () => {
      expect(() =>
        loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_RETENTION_EVENTS_DAYS: '0' }),
      ).not.toThrow();
    });
  });

  describe('assertRetentionPolicy', () => {
    const over = MAX_RETENTION_DAYS + 1;

    it('rejects events.maxAgeDays above the ceiling', () => {
      expect(() =>
        assertRetentionPolicy({ ...NO_RETENTION, events: { maxAgeDays: over } }),
      ).toThrow(/events\.maxAgeDays.*up to 36500/);
    });

    it('rejects tokenUsage.maxAgeDays above the ceiling', () => {
      expect(() =>
        assertRetentionPolicy({
          ...NO_RETENTION,
          tokenUsage: { maxAgeDays: over, acknowledgeCostLoss: true },
        }),
      ).toThrow(/tokenUsage\.maxAgeDays.*up to 36500/);
    });

    it('rejects backupFiles.maxAgeDays above the ceiling', () => {
      expect(() =>
        assertRetentionPolicy({
          ...NO_RETENTION,
          backupFiles: { directory: '/tmp/x', maxAgeDays: over, keepMinimum: 1 },
        }),
      ).toThrow(/backupFiles\.maxAgeDays.*up to 36500/);
    });

    it('accepts every window at the ceiling', () => {
      expect(() =>
        assertRetentionPolicy({
          ...NO_RETENTION,
          events: { maxAgeDays: MAX_RETENTION_DAYS },
          tokenUsage: { maxAgeDays: MAX_RETENTION_DAYS, acknowledgeCostLoss: true },
          backupFiles: { directory: '/tmp/x', maxAgeDays: MAX_RETENTION_DAYS, keepMinimum: 1 },
        }),
      ).not.toThrow();
    });

    it('leaves maxRowsPerRun and keepMinimum without the day ceiling', () => {
      expect(() =>
        assertRetentionPolicy({
          ...NO_RETENTION,
          maxRowsPerRun: over,
          backupFiles: { directory: '/tmp/x', maxAgeDays: 1, keepMinimum: over },
        }),
      ).not.toThrow();
    });
  });
});
