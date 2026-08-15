/**
 * computeCostWindows (review item M-9): today / last-7-days aggregation over
 * the served perDay rows. The suite pins the boundary honesty - the day basis
 * is UTC, the week window is inclusive of its first day, future-dated rows are
 * excluded, and 'unknown' rows land in their own bucket instead of a window.
 */
import { describe, expect, it } from 'vitest';
import { computeCostWindows, WEEK_WINDOW_DAYS } from '../src/views/cost-windows';

/** Noon UTC, so no off-by-one lurks near a midnight boundary. */
const NOW_MS = Date.UTC(2026, 7, 15, 12, 0, 0);

describe('computeCostWindows', () => {
  it('names the UTC window boundaries from the injected clock', () => {
    const windows = computeCostWindows([], NOW_MS);
    expect(windows.todayUtc).toBe('2026-08-15');
    expect(windows.weekStartUtc).toBe('2026-08-09');
    expect(WEEK_WINDOW_DAYS).toBe(7);
  });

  it('returns zero totals for an empty perDay list', () => {
    const windows = computeCostWindows([], NOW_MS);
    expect(windows.today).toEqual({ tokens: 0, costUsd: 0, unpricedTokens: 0 });
    expect(windows.last7Days).toEqual({ tokens: 0, costUsd: 0, unpricedTokens: 0 });
    expect(windows.unknownDay).toEqual({ tokens: 0, costUsd: 0, unpricedTokens: 0 });
  });

  it('files each row into exactly the windows its UTC date sits in', () => {
    const windows = computeCostWindows(
      [
        // Today: counted in BOTH windows.
        { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 100 },
        // Mid-window day.
        { day: '2026-08-12', tokens: 2000, costUsd: 0.2, unpricedTokens: 0 },
        // The first day of the window - inclusive.
        { day: '2026-08-09', tokens: 4000, costUsd: 0.4, unpricedTokens: 500 },
        // One day before the window - excluded.
        { day: '2026-08-08', tokens: 8000, costUsd: 0.8, unpricedTokens: 0 },
        // Future-dated (clock skew between writer and viewer) - excluded.
        { day: '2026-08-16', tokens: 16000, costUsd: 1.6, unpricedTokens: 0 },
        // No timestamp at all - outside every window, in its own bucket.
        { day: 'unknown', tokens: 32000, costUsd: 0, unpricedTokens: 32000 },
      ],
      NOW_MS,
    );
    expect(windows.today).toEqual({ tokens: 1000, costUsd: 0.1, unpricedTokens: 100 });
    expect(windows.last7Days.tokens).toBe(7000);
    expect(windows.last7Days.costUsd).toBeCloseTo(0.7);
    expect(windows.last7Days.unpricedTokens).toBe(600);
    expect(windows.unknownDay).toEqual({ tokens: 32000, costUsd: 0, unpricedTokens: 32000 });
  });

  it('crosses month and year boundaries via real date math, not string tricks', () => {
    const windows = computeCostWindows(
      [{ day: '2025-12-28', tokens: 500, costUsd: 0.05, unpricedTokens: 0 }],
      Date.UTC(2026, 0, 3, 12, 0, 0),
    );
    expect(windows.todayUtc).toBe('2026-01-03');
    expect(windows.weekStartUtc).toBe('2025-12-28');
    expect(windows.last7Days.tokens).toBe(500);
    expect(windows.today.tokens).toBe(0);
  });
});
