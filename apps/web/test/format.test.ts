/**
 * Pure formatter tests (WP-U6..U9): deterministic display vocabulary shared
 * by all four views.
 */
import { describe, expect, it } from 'vitest';
import { formatRelativeTime, formatTokens, formatUsd, shortId } from '../src/format';

describe('formatTokens', () => {
  it('groups digits below 10k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(9999)).toBe('9,999');
  });

  it('compacts thousands and millions', () => {
    expect(formatTokens(56_800)).toBe('56.8k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});

describe('formatUsd', () => {
  it('renders an exact zero as $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('keeps four decimals for sub-cent amounts so tiny costs never read as $0.00', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
  });

  it('uses cents precision otherwise', () => {
    expect(formatUsd(1.239)).toBe('$1.24');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');

  it('returns null for a null or unparseable timestamp - never invents one', () => {
    expect(formatRelativeTime(null, now)).toBeNull();
    expect(formatRelativeTime('not-a-date', now)).toBeNull();
  });

  it('reads fresh timestamps (and small negative skew) as just now', () => {
    expect(formatRelativeTime('2026-07-29T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-29T12:00:05.000Z', now)).toBe('just now');
  });

  it('scales through minutes, hours and days', () => {
    expect(formatRelativeTime('2026-07-29T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatRelativeTime('2026-07-29T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-07-27T12:00:00.000Z', now)).toBe('2d ago');
  });
});

describe('shortId', () => {
  it('truncates long ids to eight chars with an ellipsis', () => {
    expect(shortId('aaaaaaaa-1111-2222-3333-444444444444')).toBe('aaaaaaaa…');
  });

  it('keeps short ids whole', () => {
    expect(shortId('main')).toBe('main');
  });
});
