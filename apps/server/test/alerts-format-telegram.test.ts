/** WP-A6 - the Telegram message formatter: plain text, ids and figures only. */
import type { AlertNotification } from '@agenthropic/shared';
import { describe, expect, it } from 'vitest';
import { formatTelegram, MAX_FIELD_LENGTH } from '../src/alerts/format-telegram';

const base = {
  alertEventId: 'evt-1',
  ruleId: 'cost-5',
  sessionId: 'sess-abc',
  firedAt: '2026-10-24T10:00:00.000Z',
};

describe('formatTelegram', () => {
  it('renders cost_threshold with two-decimal dollar figures', () => {
    expect(
      formatTelegram({ ...base, kind: 'cost_threshold', costUsd: 5.004, thresholdUsd: 5 }),
    ).toBe(
      [
        '[agenthropic] Cost threshold reached',
        'Session: sess-abc',
        'Cost: $5.00 (threshold $5.00)',
        'Rule: cost-5',
        'Fired: 2026-10-24T10:00:00.000Z',
        'Event: evt-1',
      ].join('\n'),
    );
    expect(
      formatTelegram({ ...base, kind: 'cost_threshold', costUsd: 12.345, thresholdUsd: 0.1 }),
    ).toContain('Cost: $12.35 (threshold $0.10)');
  });

  it('renders stuck_agent', () => {
    expect(
      formatTelegram({
        ...base,
        kind: 'stuck_agent',
        agentId: 'agent-7',
        lastSeenAt: '2026-10-24T09:00:00.000Z',
      }),
    ).toBe(
      [
        '[agenthropic] Agent appears stuck',
        'Session: sess-abc',
        'Agent: agent-7',
        'Last seen: 2026-10-24T09:00:00.000Z',
        'Rule: cost-5',
        'Fired: 2026-10-24T10:00:00.000Z',
        'Event: evt-1',
      ].join('\n'),
    );
  });

  it('renders error', () => {
    expect(formatTelegram({ ...base, kind: 'error', agentId: 'agent-9' })).toBe(
      [
        '[agenthropic] Agent ended in error',
        'Session: sess-abc',
        'Agent: agent-9',
        'Rule: cost-5',
        'Fired: 2026-10-24T10:00:00.000Z',
        'Event: evt-1',
      ].join('\n'),
    );
  });

  it('falls back to a generic message for a kind outside the union instead of throwing', () => {
    const bogus = { ...base, kind: 'bogus' } as unknown as AlertNotification;
    expect(formatTelegram(bogus)).toBe(
      [
        '[agenthropic] Alert',
        'Session: sess-abc',
        'Rule: cost-5',
        'Fired: 2026-10-24T10:00:00.000Z',
        'Event: evt-1',
      ].join('\n'),
    );
  });

  it('neutralises control characters so an id cannot forge a line', () => {
    const text = formatTelegram({
      ...base,
      kind: 'error',
      agentId: 'a\nRule: forged\r\u0000\u2028x',
    });
    expect(text.split('\n')).toHaveLength(6);
    expect(text).toContain('Agent: a Rule: forged   x');
  });

  it('caps long ids with an ellipsis', () => {
    const long = 'x'.repeat(MAX_FIELD_LENGTH + 50);
    const text = formatTelegram({ ...base, kind: 'error', agentId: long });
    expect(text).toContain(`Agent: ${'x'.repeat(MAX_FIELD_LENGTH)}…\n`);
    const exact = 'y'.repeat(MAX_FIELD_LENGTH);
    expect(formatTelegram({ ...base, kind: 'error', agentId: exact })).toContain(
      `Agent: ${exact}\n`,
    );
  });

  it('emits no markup syntax of its own', () => {
    const text = formatTelegram({ ...base, kind: 'cost_threshold', costUsd: 1, thresholdUsd: 1 });
    expect(text).not.toMatch(/[<>*_`]/);
  });
});
