/**
 * The shared UI clock (review item M-10).
 *
 * Every assertion here is about an OBSERVABLE consequence - a rendered reading
 * that moves, two components rendering the same reading, a timer that is gone
 * after the last unmount. Asserting that `setInterval` was called would prove
 * nothing about the defect, which was a stale value on screen.
 *
 * Fake timers are mandatory: the interval is the subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { CLOCK_INTERVAL_MS, useNowMs } from '../src/clock';

/** Renders the raw reading, so a tick is visible in the DOM. */
function Probe({ label }: { readonly label: string }) {
  const nowMs = useNowMs();
  return <span data-testid={label}>{String(nowMs)}</span>;
}

function readingOf(label: string): number {
  return Number(screen.getByTestId(label).textContent);
}

/** Let React flush the mount effect (where the subscription is made). */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const START = Date.UTC(2026, 7, 21, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useNowMs', () => {
  it('advances the rendered reading on every tick, with nothing else happening', async () => {
    render(<Probe label="a" />);
    await settle();
    expect(readingOf('a')).toBe(START);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
    });
    expect(readingOf('a')).toBe(START + CLOCK_INTERVAL_MS);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS * 3);
    });
    expect(readingOf('a')).toBe(START + CLOCK_INTERVAL_MS * 4);
  });

  it('does not move the reading before a full interval has elapsed', async () => {
    render(<Probe label="a" />);
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS - 1);
    });
    // A reading that jumped early would be as invented as one that froze.
    expect(readingOf('a')).toBe(START);
  });

  it('serves every consumer one reading from one interval', async () => {
    const idle = vi.getTimerCount();
    render(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );
    await settle();

    // The honesty property: two panels can never disagree about "now",
    // because there is exactly one timer and one cached reading behind them.
    expect(vi.getTimerCount()).toBe(idle + 1);
    expect(readingOf('a')).toBe(readingOf('b'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
    });
    expect(readingOf('a')).toBe(START + CLOCK_INTERVAL_MS);
    expect(readingOf('b')).toBe(readingOf('a'));
  });

  it('keeps ticking while one consumer of two unmounts, and stops with the last', async () => {
    const idle = vi.getTimerCount();
    const first = render(<Probe label="a" />);
    const second = render(<Probe label="b" />);
    await settle();
    expect(vi.getTimerCount()).toBe(idle + 1);

    first.unmount();
    expect(vi.getTimerCount()).toBe(idle + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
    });
    expect(readingOf('b')).toBe(START + CLOCK_INTERVAL_MS);

    second.unmount();
    // No consumer, no timer: an unmounted tree never leaves one ticking.
    expect(vi.getTimerCount()).toBe(idle);
  });

  it('hands a remount the current time, not the reading it stopped on', async () => {
    const view = render(<Probe label="a" />);
    await settle();
    view.unmount();

    // Hours pass with nothing mounted, so no tick refreshes the cache.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    });
    render(<Probe label="a" />);
    await settle();

    expect(readingOf('a')).toBe(START + 4 * 60 * 60 * 1000);
  });
});

describe('CLOCK_INTERVAL_MS', () => {
  it('stays inside the 90 s window that formatRelativeTime calls "just now"', () => {
    // Above 90 s the label would outlive its own definition on screen - the
    // exact staleness M-10 is about. This pins the ceiling the constant's
    // PROVISIONAL note names.
    expect(CLOCK_INTERVAL_MS).toBeLessThan(90_000);
    expect(CLOCK_INTERVAL_MS).toBeGreaterThan(0);
  });
});
