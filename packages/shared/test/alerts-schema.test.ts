import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  AlertKindSchema,
  AlertsConfigSchema,
  DEFAULT_ALERTS_PER_MINUTE,
  InMemoryAlertSink,
  MAX_ALERTS_PER_MINUTE,
  TelegramTargetConfigSchema,
  alertsConfigProblems,
  type AlertNotification,
  type AlertsConfig,
} from '../src/index';

const target = {
  id: 'phone',
  kind: 'telegram',
  tokenRef: 'env:AGENTHROPIC_TELEGRAM_TOKEN',
  chatId: '123456789',
};

const validConfig: AlertsConfig = {
  targets: [{ ...target, kind: 'telegram' }],
  rules: [
    { id: 'big-spend', kind: 'cost_threshold', targetId: 'phone', thresholdUsd: 5 },
    { id: 'stuck', kind: 'stuck_agent', targetId: 'phone' },
    { id: 'errors', kind: 'error', targetId: 'phone', enabled: false },
  ],
};

describe('AlertsConfigSchema (WP-A1, AD-2)', () => {
  it('accepts a full config with every rule kind', () => {
    expect(Value.Check(AlertsConfigSchema, validConfig)).toBe(true);
    expect(alertsConfigProblems(validConfig)).toEqual([]);
  });

  it('accepts an empty config (alerting configured but no rules yet)', () => {
    expect(Value.Check(AlertsConfigSchema, { targets: [], rules: [] })).toBe(true);
  });

  it('rejects unknown top-level keys (a typo must be loud)', () => {
    expect(Value.Check(AlertsConfigSchema, { ...validConfig, rule: [] })).toBe(false);
  });

  it('rejects a rule kind outside AD-5', () => {
    const config = { targets: [target], rules: [{ id: 'x', kind: 'webhook', targetId: 'phone' }] };
    expect(Value.Check(AlertsConfigSchema, config)).toBe(false);
  });

  it('rejects a cost rule without a positive threshold', () => {
    for (const thresholdUsd of [0, -1, undefined]) {
      const rule = { id: 'c', kind: 'cost_threshold', targetId: 'phone', thresholdUsd };
      expect(Value.Check(AlertsConfigSchema, { targets: [target], rules: [rule] })).toBe(false);
    }
  });

  it('rejects a threshold field on a status rule', () => {
    const rule = { id: 's', kind: 'stuck_agent', targetId: 'phone', thresholdUsd: 1 };
    expect(Value.Check(AlertsConfigSchema, { targets: [target], rules: [rule] })).toBe(false);
  });
});

describe('TelegramTargetConfigSchema (AD-3, AD-4)', () => {
  it.each(['env:TELEGRAM_TOKEN', 'env:_x1', 'file:/Users/me/.config/agenthropic/telegram.token'])(
    'accepts tokenRef %s',
    (tokenRef) => {
      expect(Value.Check(TelegramTargetConfigSchema, { ...target, tokenRef })).toBe(true);
    },
  );

  it.each([
    '123456:ABC-raw-bot-token',
    'env:',
    'env:1BAD',
    'env:BAD-NAME',
    'file:relative/path',
    'file:',
    'https://api.telegram.org/bot123/sendMessage',
    'ENV:TOKEN',
  ])('rejects tokenRef %s (never an inline secret or URL)', (tokenRef) => {
    expect(Value.Check(TelegramTargetConfigSchema, { ...target, tokenRef })).toBe(false);
  });

  it('rejects any URL-bearing field - the host is a constant in code', () => {
    expect(
      Value.Check(TelegramTargetConfigSchema, { ...target, url: 'http://169.254.169.254/' }),
    ).toBe(false);
    expect(Value.Check(TelegramTargetConfigSchema, { ...target, kind: 'webhook' })).toBe(false);
  });

  it.each(['123456789', '-1001234567890', '@my_channel'])('accepts chatId %s', (chatId) => {
    expect(Value.Check(TelegramTargetConfigSchema, { ...target, chatId })).toBe(true);
  });

  it.each(['', 'abc', '@ab', '12 34', 'http://x'])('rejects chatId %j', (chatId) => {
    expect(Value.Check(TelegramTargetConfigSchema, { ...target, chatId })).toBe(false);
  });

  it.each(['Phone', '-x', 'a b', 'a'.repeat(65), ''])('rejects id %j', (id) => {
    expect(Value.Check(TelegramTargetConfigSchema, { ...target, id })).toBe(false);
  });

  it('bounds maxPerMinute to 1..MAX_ALERTS_PER_MINUTE integers', () => {
    expect(DEFAULT_ALERTS_PER_MINUTE).toBeLessThanOrEqual(MAX_ALERTS_PER_MINUTE);
    const check = (maxPerMinute: number): boolean =>
      Value.Check(TelegramTargetConfigSchema, { ...target, maxPerMinute });
    expect(check(1)).toBe(true);
    expect(check(MAX_ALERTS_PER_MINUTE)).toBe(true);
    expect(check(0)).toBe(false);
    expect(check(MAX_ALERTS_PER_MINUTE + 1)).toBe(false);
    expect(check(2.5)).toBe(false);
  });
});

describe('alertsConfigProblems (cross-references)', () => {
  it('reports duplicate ids and dangling target references, all at once', () => {
    const config: AlertsConfig = {
      targets: [{ ...validConfig.targets[0]! }, { ...validConfig.targets[0]!, chatId: '42' }],
      rules: [
        { id: 'r', kind: 'error', targetId: 'phone' },
        { id: 'r', kind: 'stuck_agent', targetId: 'laptop' },
      ],
    };
    expect(alertsConfigProblems(config)).toEqual([
      'duplicate target id "phone"',
      'duplicate rule id "r"',
      'rule "r" names unknown target "laptop"',
    ]);
  });
});

describe('AlertKindSchema', () => {
  it('admits exactly the three AD-5 kinds', () => {
    for (const kind of ['cost_threshold', 'stuck_agent', 'error']) {
      expect(Value.Check(AlertKindSchema, kind)).toBe(true);
    }
    expect(Value.Check(AlertKindSchema, 'unknown')).toBe(false);
  });
});

describe('InMemoryAlertSink (AlertSinkPort test double)', () => {
  const notification: AlertNotification = {
    kind: 'error',
    alertEventId: 'ev-1',
    ruleId: 'errors',
    sessionId: 's-1',
    agentId: 'a-1',
    firedAt: '2026-10-24T10:00:00.000Z',
  };

  it('defaults to always-sent and records what it was handed', async () => {
    const sink = new InMemoryAlertSink('phone');
    expect(sink.targetId).toBe('phone');
    expect(sink.kind).toBe('telegram');
    await expect(sink.send(notification)).resolves.toEqual({ kind: 'sent' });
    expect(sink.sent()).toEqual([notification]);
  });

  it('replays a scripted outcome sequence and repeats the last one', async () => {
    const sink = new InMemoryAlertSink('phone', [
      { kind: 'retryable', reason: 'HTTP 503' },
      { kind: 'terminal', reason: 'HTTP 403' },
    ]);
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(await sink.send(notification));
    expect(outcomes.map((o) => o.kind)).toEqual(['retryable', 'terminal', 'terminal']);
    expect(sink.sent()).toHaveLength(3);
  });

  it('refuses an empty outcome script', () => {
    expect(() => new InMemoryAlertSink('phone', [])).toThrow(/at least one outcome/);
  });
});
