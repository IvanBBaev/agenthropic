/**
 * UX-15 (2026-11-19): coalesce bursts of refetch requests.
 *
 * Every `session-ingested` frame used to bump a view's reload counter at once,
 * so an active multi-agent session - several ingests a second - re-read the
 * whole session list once per frame. Each re-read aborts the one before it, so
 * nothing went wrong, but the server did the work every time.
 *
 * A coalescer fires at most once per interval and never loses a request:
 *   - the first request after a quiet interval fires at once, so a lone ingest
 *     is shown as quickly as before;
 *   - requests that arrive within the interval after a fire are folded into
 *     ONE trailing fire at the end of that interval, so the last ingest of a
 *     burst is always read.
 */

/** Minimum time between two coalesced refetches of the same view. PROVISIONAL. */
export const INGEST_REFETCH_INTERVAL_MS = 2000;

export interface CoalescerClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const browserClock: CoalescerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

export interface Coalescer {
  /** Ask for a fire: now if the interval has passed, otherwise at its end. */
  request(): void;
  /** Drop a pending trailing fire; later requests still work. */
  cancel(): void;
}

export function createCoalescer(
  fire: () => void,
  intervalMs: number = INGEST_REFETCH_INTERVAL_MS,
  clock: CoalescerClock = browserClock,
): Coalescer {
  let lastFireAt = Number.NEGATIVE_INFINITY;
  let pending: unknown = null;

  const fireNow = (): void => {
    pending = null;
    lastFireAt = clock.now();
    fire();
  };

  return {
    request(): void {
      if (pending !== null) return;
      const wait = lastFireAt + intervalMs - clock.now();
      if (wait <= 0) {
        fireNow();
        return;
      }
      pending = clock.setTimeout(fireNow, wait);
    },
    cancel(): void {
      if (pending === null) return;
      clock.clearTimeout(pending);
      pending = null;
    },
  };
}
