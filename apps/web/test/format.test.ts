/**
 * Pure formatter tests (WP-U6..U9): deterministic display vocabulary shared
 * by all four views.
 */
import { describe, expect, it } from 'vitest';
import {
  agentTypeLabel,
  AHEAD_OF_CLOCK,
  formatRelativeMs,
  formatRelativeTime,
  formatTokens,
  formatUsd,
  FUTURE_SKEW_TOLERANCE_MS,
  projectLabel,
  shortId,
  UNREADABLE_TIMESTAMP,
  UNREADABLE_TOKENS,
  UNREADABLE_USD,
} from '../src/format';

describe('formatTokens', () => {
  it('refuses to shape a figure that is not a number (F-5)', () => {
    // Every payload reaches this function through an unchecked `body as T`
    // cast in api.ts, so the parameter type is a claim about the SERVER, not a
    // guarantee about the value. A field the server renamed or stopped sending
    // arrives here as `undefined` and used to throw on `.toLocaleString`,
    // taking the whole page down; NaN and Infinity did not throw at all, they
    // rendered - as `NaN` and `InfinityM`, in a column of real counts.
    const absent = undefined as unknown as number;
    expect(formatTokens(absent)).toBe(UNREADABLE_TOKENS);
    expect(formatTokens(null as unknown as number)).toBe(UNREADABLE_TOKENS);
    expect(formatTokens(Number.NaN)).toBe(UNREADABLE_TOKENS);
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe(UNREADABLE_TOKENS);
    // Worded like its dollar counterpart - subject, then state - so neither
    // can be mistaken for an amount.
    expect(UNREADABLE_TOKENS).not.toMatch(/\d/);
  });

  it('groups digits below 10k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(9999)).toBe('9,999');
  });

  it('compacts thousands and millions', () => {
    expect(formatTokens(56_800)).toBe('56.8k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });

  it('rounds before picking the unit, so a boundary value promotes instead of reading 1000.0', () => {
    expect(formatTokens(999_949)).toBe('999.9k');
    expect(formatTokens(999_950)).toBe('1.0M');
    expect(formatTokens(999_949_999)).toBe('999.9M');
    expect(formatTokens(999_950_000)).toBe('1.0B');
    expect(formatTokens(2_500_000_000)).toBe('2.5B');
    // The top tier has nowhere to promote to, so it keeps counting in B.
    expect(formatTokens(1_234_500_000_000)).toBe('1234.5B');
  });

  it('renders negative zero as a plain zero', () => {
    expect(formatTokens(-0)).toBe('0');
    expect(formatTokens(-5)).toBe('-5');
  });
});

describe('formatUsd', () => {
  it('renders an exact zero as $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('keeps four decimals for sub-cent amounts so tiny costs never read as $0.00', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
  });

  it('marks a positive amount below the four-decimal floor as <$0.0001, never $0.0000', () => {
    // 0.00005.toFixed(4) is '0.0000' - the same string as the honest zero.
    // A real-but-tiny cost must stay visibly non-zero.
    expect(formatUsd(0.00005)).toBe('<$0.0001');
  });

  it('renders the floor boundary itself with its real digits', () => {
    expect(formatUsd(0.0001)).toBe('$0.0001');
  });

  it('never claims a negative delta is a tiny positive cost', () => {
    expect(formatUsd(-0.0042)).toBe('$-0.0042');
  });

  it('uses cents precision otherwise', () => {
    expect(formatUsd(1.239)).toBe('$1.24');
  });

  /**
   * F-10. The sub-cent floor was guarded with `costUsd > 0 &&`, so it defended
   * one side of zero and left the other open. These pin the symmetry: whatever
   * shape a magnitude gets above zero, the same magnitude gets below it.
   */
  it('marks a tiny NEGATIVE amount too, instead of printing $-0.0000', () => {
    // Four zeros and a minus sign read as "essentially nothing" - the exact
    // misreading the positive arm exists to prevent.
    expect(formatUsd(-0.00005)).toBe('>-$0.0001');
    expect(formatUsd(-1e-9)).toBe('>-$0.0001');
  });

  it('gives a negative bill the same precision as the positive one', () => {
    // Not cosmetic: every negative used to fall through the sub-cent arm, so a
    // -$12.50 bill printed as `$-12.5000` - four decimals is the house style
    // for "too small to see", and this amount is not.
    expect(formatUsd(-12.5)).toBe('$-12.50');
    expect(formatUsd(12.5)).toBe('$12.50');
  });

  it('refuses to render a figure that is not a number', () => {
    // `toFixed` renders these happily, and `$NaN` in one cell of twenty
    // correct ones scrolls past unnoticed.
    expect(formatUsd(Number.NaN)).toBe(UNREADABLE_USD);
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe(UNREADABLE_USD);
    expect(formatUsd(Number.NEGATIVE_INFINITY)).toBe(UNREADABLE_USD);
    expect(UNREADABLE_USD).not.toContain('$');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');

  /**
   * AMENDED 2026-09-23 (B2). This pinned BOTH gaps at `null`, which is the
   * defect rather than the guarantee: the sole caller renders `null` as the
   * words `no timestamp`, so a row carrying a timestamp this build cannot read
   * was reported as a row that has never been active. The durable guarantee -
   * never invent an age out of a value that has none - is unchanged and still
   * asserted; the two gaps are now said apart.
   */
  it('never invents an age, and says an absent timestamp apart from an unreadable one', () => {
    expect(formatRelativeTime(null, now)).toBeNull();
    expect(formatRelativeTime('not-a-date', now)).toBe(UNREADABLE_TIMESTAMP);
    // Neither an age nor a reassurance: it must not be mistakable for either
    // vocabulary this module owns.
    expect(UNREADABLE_TIMESTAMP).not.toContain('ago');
    expect(UNREADABLE_TIMESTAMP).not.toContain('now');
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

  /**
   * F-13. `seconds < 90` had no lower bound, so a timestamp three days in the
   * FUTURE - a machine whose clock jumped, a mis-parsed timezone - rendered as
   * `just now`, the most reassuring string the function owns, over the least
   * trustworthy value it had. These pin the band as symmetric.
   */
  it('names a timestamp further ahead than skew can explain, instead of calling it fresh', () => {
    expect(formatRelativeTime('2026-08-01T12:00:00.000Z', now)).toBe(AHEAD_OF_CLOCK);
    expect(AHEAD_OF_CLOCK).not.toContain('ago');
    expect(AHEAD_OF_CLOCK).not.toContain('now');
  });

  it('still forgives skew inside the tolerance, on both sides of the clock', () => {
    const inside = new Date(now + FUTURE_SKEW_TOLERANCE_MS).toISOString();
    const outside = new Date(now + FUTURE_SKEW_TOLERANCE_MS + 1000).toISOString();
    expect(formatRelativeTime(inside, now)).toBe('just now');
    expect(formatRelativeTime(outside, now)).toBe(AHEAD_OF_CLOCK);
    // The same 90 s the past side uses - one band, not a bounded past and an
    // unbounded future.
    expect(FUTURE_SKEW_TOLERANCE_MS).toBe(90_000);
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

describe('formatRelativeMs', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');

  it('speaks the same vocabulary as its ISO sibling, band for band', () => {
    // Same instants, both spellings - the split exists to spare the caller a
    // round-trip, not to give the app a second set of words for one age.
    for (const ago of [0, 89_000, 5 * 60_000, 3 * 3_600_000, 4 * 86_400_000]) {
      const at = now - ago;
      expect(formatRelativeMs(at, now)).toBe(formatRelativeTime(new Date(at).toISOString(), now));
    }
  });

  it('names each band at its boundary', () => {
    expect(formatRelativeMs(now, now)).toBe('just now');
    expect(formatRelativeMs(now - 89_999, now)).toBe('just now');
    expect(formatRelativeMs(now - 90_000, now)).toBe('1m ago');
    expect(formatRelativeMs(now - 59 * 60_000, now)).toBe('59m ago');
    expect(formatRelativeMs(now - 60 * 60_000, now)).toBe('1h ago');
    expect(formatRelativeMs(now - 23 * 3_600_000, now)).toBe('23h ago');
    expect(formatRelativeMs(now - 24 * 3_600_000, now)).toBe('1d ago');
  });

  it('refuses to date a reading the clock has not reached yet', () => {
    expect(formatRelativeMs(now + FUTURE_SKEW_TOLERANCE_MS, now)).toBe('just now');
    expect(formatRelativeMs(now + FUTURE_SKEW_TOLERANCE_MS + 1, now)).toBe(AHEAD_OF_CLOCK);
  });
});

/**
 * The vanished subject (2026-09-23, lane-P). Each of these three helpers
 * exists to put a NAME on screen - in a `<code>` element, in a project column,
 * in an agent-identity cell. All three have arms that pass a served string
 * straight through, and `''` is a served string: the element renders, the name
 * slot is empty, and the row claims to be about something it never names.
 */
describe('a name slot the server left blank (lane-P)', () => {
  it('names a blank id instead of rendering an empty code element', () => {
    expect(shortId('')).toBe('blank id ("")');
  });

  it('makes a whitespace-only id visible', () => {
    expect(shortId('   ')).toBe('blank id ("   ")');
  });

  it('keeps naming the gap when the project slug is the empty string', () => {
    // `null` is already handled - the slug that is present but says nothing
    // is the one that slipped through, because `??` only catches null.
    expect(projectLabel('')).toBe('blank project slug ("")');
    expect(projectLabel('  ')).toBe('blank project slug ("  ")');
    expect(projectLabel(null)).toBe('project unknown');
  });

  it('keeps naming the gap when an agent type is the empty string', () => {
    expect(agentTypeLabel('', null)).toBe('blank type ("")');
    expect(agentTypeLabel(null, '')).toBe('blank type ("")');
    expect(agentTypeLabel(null, null)).toBe('type unrecorded');
  });

  it('falls through a blank subagent type to a real agent type', () => {
    // A blank in the preferred field must not hide a usable value in the
    // fallback field - that would turn a recorded fact into a gap.
    expect(agentTypeLabel('', 'general-purpose')).toBe('general-purpose');
  });
});
