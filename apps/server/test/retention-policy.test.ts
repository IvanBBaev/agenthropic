import { describe, expect, it } from 'vitest';
import {
  assertRetentionPolicy,
  DEFAULT_BACKUP_KEEP_MINIMUM,
  DEFAULT_MAX_ROWS_PER_RUN,
  isNoOpPolicy,
  loadRetentionPolicy,
  NO_RETENTION,
  RETENTION_PROTECTED_TABLES,
  RetentionPolicyError,
  type RetentionPolicy,
} from '../src/retention/policy';

describe('retention policy (WP-D10 mechanism; policy value awaits OPEN-1)', () => {
  describe('the default is a no-op', () => {
    it('an environment with no DASHBOARD_RETENTION_* variable yields NO_RETENTION', () => {
      expect(loadRetentionPolicy({})).toEqual(NO_RETENTION);
    });

    it('unrelated variables do not switch retention on', () => {
      expect(loadRetentionPolicy({ HOME: '/tmp', DASHBOARD_TOKEN: 'x', PATH: '/usr/bin' })).toEqual(
        NO_RETENTION,
      );
    });

    it('NO_RETENTION deletes nothing anywhere', () => {
      expect(NO_RETENTION.events).toBeNull();
      expect(NO_RETENTION.tokenUsage).toBeNull();
      expect(NO_RETENTION.backupFiles).toBeNull();
      expect(NO_RETENTION.rawEvents).toBe('keep-forever');
      expect(isNoOpPolicy(NO_RETENTION)).toBe(true);
    });

    it('any configured rule makes the policy non-no-op', () => {
      expect(isNoOpPolicy({ ...NO_RETENTION, events: { maxAgeDays: 1 } })).toBe(false);
      expect(
        isNoOpPolicy({
          ...NO_RETENTION,
          tokenUsage: { maxAgeDays: 1, acknowledgeCostLoss: true },
        }),
      ).toBe(false);
      expect(
        isNoOpPolicy({
          ...NO_RETENTION,
          backupFiles: { directory: '/tmp/x', maxAgeDays: 1, keepMinimum: 1 },
        }),
      ).toBe(false);
    });
  });

  describe('the substrate and the DAG are protected', () => {
    it('lists events_raw, the DAG tables, pricing and schema version', () => {
      expect(RETENTION_PROTECTED_TABLES).toEqual([
        'events_raw',
        'sessions',
        'agents',
        'orchestration_edges',
        'model_pricing',
        'schema_version',
      ]);
    });
  });

  describe('OPEN-1 is expressible either way, and the unbuilt branch is loud', () => {
    it('accepts keep-forever (the implemented branch)', () => {
      expect(
        loadRetentionPolicy({ DASHBOARD_RETENTION_RAW_EVENTS: 'keep-forever' }).rawEvents,
      ).toBe('keep-forever');
    });

    it('parses archive-segments but refuses it with an explanation, not a silent ignore', () => {
      expect(() =>
        loadRetentionPolicy({ DASHBOARD_RETENTION_RAW_EVENTS: 'archive-segments' }),
      ).toThrow(/DECLARED but NOT IMPLEMENTED/);
      expect(() =>
        loadRetentionPolicy({ DASHBOARD_RETENTION_RAW_EVENTS: 'archive-segments' }),
      ).toThrow(/OPEN-1/);
    });

    it('rejects an unknown raw-event strategy', () => {
      expect(() => loadRetentionPolicy({ DASHBOARD_RETENTION_RAW_EVENTS: 'delete-rows' })).toThrow(
        RetentionPolicyError,
      );
    });
  });

  describe('cost honesty: token_usage needs an explicit acknowledgement', () => {
    it('refuses a token_usage rule without the acknowledgement flag', () => {
      expect(() => loadRetentionPolicy({ DASHBOARD_RETENTION_TOKEN_USAGE_DAYS: '30' })).toThrow(
        /acknowledgeCostLoss/,
      );
    });

    it('accepts it once acknowledged', () => {
      const policy = loadRetentionPolicy({
        DASHBOARD_RETENTION_TOKEN_USAGE_DAYS: '30',
        DASHBOARD_RETENTION_TOKEN_USAGE_ACK_COST_LOSS: '1',
      });
      expect(policy.tokenUsage).toEqual({ maxAgeDays: 30, acknowledgeCostLoss: true });
    });

    it('accepts the "true" spelling and rejects a typo rather than reading it as false', () => {
      expect(
        loadRetentionPolicy({
          DASHBOARD_RETENTION_TOKEN_USAGE_DAYS: '30',
          DASHBOARD_RETENTION_TOKEN_USAGE_ACK_COST_LOSS: 'true',
        }).tokenUsage?.acknowledgeCostLoss,
      ).toBe(true);
      expect(() =>
        loadRetentionPolicy({
          DASHBOARD_RETENTION_TOKEN_USAGE_DAYS: '30',
          DASHBOARD_RETENTION_TOKEN_USAGE_ACK_COST_LOSS: 'yes',
        }),
      ).toThrow(/expected 1\/true\/0\/false/);
    });

    it('treats the explicit "off" spellings as off (and therefore refuses the rule)', () => {
      for (const raw of ['0', 'false', '']) {
        expect(() =>
          loadRetentionPolicy({
            DASHBOARD_RETENTION_TOKEN_USAGE_DAYS: '30',
            DASHBOARD_RETENTION_TOKEN_USAGE_ACK_COST_LOSS: raw,
          }),
        ).toThrow(/acknowledgeCostLoss/);
      }
    });

    it('assertRetentionPolicy closes the loophole for hand-built objects', () => {
      const sneaky: RetentionPolicy = {
        ...NO_RETENTION,
        tokenUsage: { maxAgeDays: 7, acknowledgeCostLoss: false },
      };
      expect(() => assertRetentionPolicy(sneaky)).toThrow(RetentionPolicyError);
    });
  });

  describe('numbers are parsed strictly - a typo in a deletion policy never falls back', () => {
    it.each([
      ['DASHBOARD_RETENTION_EVENTS_DAYS', '0'],
      ['DASHBOARD_RETENTION_EVENTS_DAYS', '-1'],
      ['DASHBOARD_RETENTION_EVENTS_DAYS', '1.5'],
      ['DASHBOARD_RETENTION_EVENTS_DAYS', 'thirty'],
      ['DASHBOARD_RETENTION_MAX_ROWS_PER_RUN', '0'],
      ['DASHBOARD_RETENTION_BACKUP_KEEP_MIN', 'x'],
    ])('rejects %s=%s', (name, value) => {
      expect(() => loadRetentionPolicy({ [name]: value })).toThrow(RetentionPolicyError);
    });

    it('an empty string means unset, not zero', () => {
      expect(loadRetentionPolicy({ DASHBOARD_RETENTION_EVENTS_DAYS: '' })).toEqual(NO_RETENTION);
    });

    it('applies the documented defaults for the bounds', () => {
      const policy = loadRetentionPolicy({ DASHBOARD_RETENTION_EVENTS_DAYS: '90' });
      expect(policy.events).toEqual({ maxAgeDays: 90 });
      expect(policy.maxRowsPerRun).toBe(DEFAULT_MAX_ROWS_PER_RUN);
    });

    it('honours an explicit run bound', () => {
      expect(
        loadRetentionPolicy({
          DASHBOARD_RETENTION_EVENTS_DAYS: '90',
          DASHBOARD_RETENTION_MAX_ROWS_PER_RUN: '500',
        }).maxRowsPerRun,
      ).toBe(500);
    });

    it('rejects invalid numbers on hand-built policies too', () => {
      expect(() => assertRetentionPolicy({ ...NO_RETENTION, maxRowsPerRun: 0 })).toThrow(
        /maxRowsPerRun/,
      );
      expect(() => assertRetentionPolicy({ ...NO_RETENTION, events: { maxAgeDays: -3 } })).toThrow(
        /events.maxAgeDays/,
      );
    });
  });

  describe('backup-file rule', () => {
    it('refuses a day count without a directory rather than guessing one', () => {
      expect(() => loadRetentionPolicy({ DASHBOARD_RETENTION_BACKUP_DAYS: '14' })).toThrow(
        /refusing to guess/,
      );
    });

    it('builds the rule with the safety floor defaulted to 1', () => {
      const policy = loadRetentionPolicy({
        DASHBOARD_RETENTION_BACKUP_DAYS: '14',
        DASHBOARD_RETENTION_BACKUP_DIR: '/var/backups/agenthropic',
      });
      expect(policy.backupFiles).toEqual({
        directory: '/var/backups/agenthropic',
        maxAgeDays: 14,
        keepMinimum: DEFAULT_BACKUP_KEEP_MINIMUM,
      });
      expect(DEFAULT_BACKUP_KEEP_MINIMUM).toBeGreaterThanOrEqual(1);
    });

    it('honours an explicit keep-minimum', () => {
      expect(
        loadRetentionPolicy({
          DASHBOARD_RETENTION_BACKUP_DAYS: '14',
          DASHBOARD_RETENTION_BACKUP_DIR: '/var/backups/agenthropic',
          DASHBOARD_RETENTION_BACKUP_KEEP_MIN: '3',
        }).backupFiles?.keepMinimum,
      ).toBe(3);
    });

    it('a directory alone configures nothing (no implicit day count)', () => {
      expect(loadRetentionPolicy({ DASHBOARD_RETENTION_BACKUP_DIR: '/var/backups' })).toEqual(
        NO_RETENTION,
      );
    });

    it('rejects hand-built rules with an empty directory or a zero floor', () => {
      expect(() =>
        assertRetentionPolicy({
          ...NO_RETENTION,
          backupFiles: { directory: '', maxAgeDays: 1, keepMinimum: 1 },
        }),
      ).toThrow(/directory must not be empty/);
      expect(() =>
        assertRetentionPolicy({
          ...NO_RETENTION,
          backupFiles: { directory: '/tmp/x', maxAgeDays: 1, keepMinimum: 0 },
        }),
      ).toThrow(/keepMinimum/);
      expect(() =>
        assertRetentionPolicy({
          ...NO_RETENTION,
          backupFiles: { directory: '/tmp/x', maxAgeDays: 0, keepMinimum: 1 },
        }),
      ).toThrow(/maxAgeDays/);
    });
  });

  it('RetentionPolicyError is identifiable by name', () => {
    const error = new RetentionPolicyError('nope');
    expect(error.name).toBe('RetentionPolicyError');
    expect(error).toBeInstanceOf(Error);
  });
});
