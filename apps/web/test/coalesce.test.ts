/**
 * UX-15: the refetch coalescer fires a lone request at once, folds a burst into
 * one trailing fire per interval, and never loses the last request.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCoalescer, INGEST_REFETCH_INTERVAL_MS, type CoalescerClock } from '../src/coalesce';

/** A hand-driven clock: `advance` moves time and runs every timer now due. */
function manualClock(): CoalescerClock & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe('createCoalescer (UX-15)', () => {
  it('fires the first request at once', () => {
    const fire = vi.fn();
    const coalescer = createCoalescer(fire, 2000, manualClock());

    coalescer.request();

    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('folds a burst inside the interval into one trailing fire at its end', () => {
    const clock = manualClock();
    const fire = vi.fn();
    const coalescer = createCoalescer(fire, 2000, clock);

    coalescer.request();
    clock.advance(100);
    coalescer.request();
    coalescer.request();
    clock.advance(500);
    coalescer.request();
    expect(fire).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(1);

    clock.advance(1399);
    expect(fire).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(clock.pending()).toBe(0);
  });

  it('counts the next interval from the trailing fire', () => {
    const clock = manualClock();
    const fire = vi.fn();
    const coalescer = createCoalescer(fire, 2000, clock);

    coalescer.request();
    clock.advance(10);
    coalescer.request();
    clock.advance(1990);
    expect(fire).toHaveBeenCalledTimes(2);

    // 1 ms after the trailing fire: still inside its interval, so deferred.
    clock.advance(1);
    coalescer.request();
    expect(fire).toHaveBeenCalledTimes(2);
    clock.advance(1999);
    expect(fire).toHaveBeenCalledTimes(3);
  });

  it('fires at once again after a quiet interval', () => {
    const clock = manualClock();
    const fire = vi.fn();
    const coalescer = createCoalescer(fire, 2000, clock);

    coalescer.request();
    clock.advance(2000);
    coalescer.request();

    expect(fire).toHaveBeenCalledTimes(2);
    expect(clock.pending()).toBe(0);
  });

  it('cancel drops the pending fire and later requests still work', () => {
    const clock = manualClock();
    const fire = vi.fn();
    const coalescer = createCoalescer(fire, 2000, clock);

    coalescer.cancel();
    coalescer.request();
    clock.advance(10);
    coalescer.request();
    coalescer.cancel();
    clock.advance(5000);
    expect(fire).toHaveBeenCalledTimes(1);

    coalescer.request();
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('defaults to the browser clock and the shared interval', () => {
    vi.useFakeTimers();
    try {
      const fire = vi.fn();
      const coalescer = createCoalescer(fire);

      coalescer.request();
      coalescer.request();
      expect(fire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(INGEST_REFETCH_INTERVAL_MS - 1);
      expect(fire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(fire).toHaveBeenCalledTimes(2);

      coalescer.request();
      coalescer.cancel();
      vi.advanceTimersByTime(INGEST_REFETCH_INTERVAL_MS);
      expect(fire).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
