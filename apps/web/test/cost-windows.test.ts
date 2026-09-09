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

/** Read an hour before `NOW_MS`: same UTC day, so the windows are measured. */
const OBSERVED_MS = Date.UTC(2026, 7, 15, 11, 0, 0);

describe('computeCostWindows', () => {
  it('names the UTC window boundaries from the injected clock', () => {
    const windows = computeCostWindows([], NOW_MS, OBSERVED_MS);
    expect(windows.todayUtc).toBe('2026-08-15');
    expect(windows.weekStartUtc).toBe('2026-08-09');
    expect(WEEK_WINDOW_DAYS).toBe(7);
  });

  it('returns zero totals for an empty perDay list', () => {
    const windows = computeCostWindows([], NOW_MS, OBSERVED_MS);
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
      OBSERVED_MS,
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
      Date.UTC(2026, 0, 3, 9, 0, 0),
    );
    expect(windows.todayUtc).toBe('2026-01-03');
    expect(windows.weekStartUtc).toBe('2025-12-28');
    expect(windows.last7Days.tokens).toBe(500);
    expect(windows.today.tokens).toBe(0);
  });

  /**
   * F-1. The three tests below are about one distinction the rows cannot make
   * on their own: a day with no spend and a day the snapshot predates are the
   * SAME empty set inside `perDay`. Only the moment of observation separates
   * them, so only these flags can stop a structural zero being rendered in the
   * format reserved for a measurement.
   */
  it('reports the window as measured when the rows were read on the same UTC day', () => {
    // Read at 00:00:01 UTC, examined at 23:59:59 the same day: nearly a full
    // day stale, and still a measurement - it covers part of today. Staleness
    // within the day understates the number; it does not invent it.
    const windows = computeCostWindows(
      [{ day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 }],
      Date.UTC(2026, 7, 15, 23, 59, 59),
      Date.UTC(2026, 7, 15, 0, 0, 1),
    );
    expect(windows.observedUtc).toBe('2026-08-15');
    expect(windows.todayObserved).toBe(true);
    expect(windows.today.costUsd).toBeCloseTo(0.1);
  });

  it('reports the today window as unobserved once the clock outlives the snapshot by a day', () => {
    // Read ten seconds before midnight, examined twenty seconds after it. The
    // rows are 30 s old - fresher than most - and yet no row in them CAN be
    // dated 2026-08-16, so the zero below is produced by the calendar, not by
    // the corpus. The two assertions together are the whole point: the total
    // is zero AND the caller is told that zero means nothing.
    const windows = computeCostWindows(
      [{ day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 }],
      Date.UTC(2026, 7, 16, 0, 0, 20),
      Date.UTC(2026, 7, 15, 23, 59, 50),
    );
    expect(windows.todayUtc).toBe('2026-08-16');
    expect(windows.observedUtc).toBe('2026-08-15');
    expect(windows.todayObserved).toBe(false);
    expect(windows.today).toEqual({ tokens: 0, costUsd: 0, unpricedTokens: 0 });
    // The week window still holds the measured day: it is a lower bound, not a
    // fiction, which is why the view degrades the two tiles differently.
    expect(windows.last7Days.tokens).toBe(1000);
  });

  it('leaves a future-dated row in the today bucket under an unobserved flag', () => {
    // The flag answers "was this read today?", not "is anything dated today?".
    // A writer whose clock runs ahead of the viewer's puts a row into the new
    // day before the viewer's clock gets there - so a false flag can sit over a
    // real figure. Pinned because the view branches on the difference: an empty
    // bucket here is unmeasurable, this one is merely incomplete.
    const windows = computeCostWindows(
      [{ day: '2026-08-16', tokens: 7000, costUsd: 0.7, unpricedTokens: 0 }],
      Date.UTC(2026, 7, 16, 0, 0, 20),
      Date.UTC(2026, 7, 15, 23, 59, 50),
    );
    expect(windows.todayObserved).toBe(false);
    expect(windows.today.tokens).toBe(7000);
  });

  /**
   * AMENDED 2026-09-03 (CA-5): the suite pinned that a future-dated row is
   * kept OUT of both windows, and nothing more - so the row was in no bucket
   * at all and the caller had no way to say it existed. A date the viewer's
   * clock says has not happened is evidence that the writing machine and the
   * reading machine disagree about when "today" is, which is exactly the fact
   * a tile labelled "today" owes its reader.
   */
  it('files a future-dated row in a bucket of its own instead of nowhere', () => {
    const windows = computeCostWindows(
      [
        { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
        { day: '2026-08-16', tokens: 16000, costUsd: 1.6, unpricedTokens: 400 },
        { day: '2027-01-01', tokens: 2000, costUsd: 0.25, unpricedTokens: 0 },
      ],
      NOW_MS,
      OBSERVED_MS,
    );
    // Unchanged: neither window may absorb a date that has not arrived.
    expect(windows.today.tokens).toBe(1000);
    expect(windows.last7Days.tokens).toBe(1000);
    // New: and the excluded spend is still reachable, so it can be disclosed.
    expect(windows.futureDated.tokens).toBe(18000);
    expect(windows.futureDated.costUsd).toBeCloseTo(1.85);
    expect(windows.futureDated.unpricedTokens).toBe(400);
  });

  it('keeps the future bucket empty when no row outruns the window clock', () => {
    const windows = computeCostWindows(
      [
        { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
        { day: '2026-08-08', tokens: 800, costUsd: 0.08, unpricedTokens: 0 },
        { day: 'unknown', tokens: 5, costUsd: 0, unpricedTokens: 5 },
      ],
      NOW_MS,
      OBSERVED_MS,
    );
    expect(windows.futureDated).toEqual({ tokens: 0, costUsd: 0, unpricedTokens: 0 });
  });

  it('stays quiet when the observation is stamped ahead of the window clock', () => {
    // Both readings come from one machine, so this should not happen. If it
    // ever does, a gap warning would be firing over data that IS present -
    // and a warning that cries wolf is worthless on the day it is right.
    const windows = computeCostWindows(
      [],
      Date.UTC(2026, 7, 15, 23, 59, 59),
      Date.UTC(2026, 7, 16, 0, 0, 1),
    );
    expect(windows.observedUtc).toBe('2026-08-16');
    expect(windows.todayObserved).toBe(true);
  });
});
