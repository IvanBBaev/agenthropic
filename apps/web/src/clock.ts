/**
 * The dashboard's shared UI clock (review item M-10).
 *
 * Two views paint facts derived from the current time that nothing else
 * re-renders: the live board's relative-time labels ("just now", "2m ago") and
 * the cost view's UTC-day windows ("Today (UTC) 2026-08-21"). Both used to read
 * `Date.now()` once per render, so on a quiet stream a recency label froze
 * mid-sentence, and a tab left open across UTC midnight kept yesterday's totals
 * under a "today" label. A stale reading presented as the current one is
 * exactly the class of claim this dashboard exists not to make, so the clock is
 * a first-class module rather than a timer bolted onto one view.
 *
 * ONE interval serves every subscriber, for two reasons beyond frugality:
 *   - per-view timers start at different moments and would drift apart; two
 *     panels disagreeing about what "now" is would be its own honesty defect,
 *     and this shape makes that state unrepresentable;
 *   - the interval exists only while something is subscribed. It starts on the
 *     first mount and is cleared when the last consumer unmounts, so a torn-down
 *     view tree never leaves a timer ticking behind it.
 *
 * The cached reading is refreshed when the clock restarts after an idle period:
 * otherwise the first new subscriber would be handed whatever the time was when
 * the last one left - a stale value, which is the very thing being fixed.
 *
 * The pattern (module-level source of truth + `useSyncExternalStore`) is the
 * one `router.ts` already uses for the hash route.
 */
import { useSyncExternalStore } from 'react';

/**
 * Tick cadence for every time-derived label in the app. PROVISIONAL.
 *
 * The value is set by the FINEST-grained consumer, the live board's relative
 * time: `formatRelativeTime`'s coarsest boundary is the 90 s "just now" window,
 * so a 30 s tick leaves a label at most one third of that window behind the
 * truth, and never lets "just now" survive its own definition.
 *
 * The other consumer, the cost view's UTC-day windows, only has to notice a
 * once-a-day boundary, so the same interval serves it a fortiori. A second,
 * slower timer for it would save a handful of re-renders an hour and buy back
 * the problem this module deletes - two clocks that can disagree.
 *
 * Reasons to revisit: a profile showing the tick itself costs something
 * measurable (lower the frequency, but never above 90 s, past which a "just
 * now" label is provably stale on screen), or a view arriving that needs
 * second-level precision (which would need its own faster clock, not a change
 * here).
 *
 * AMENDED 2026-09-07 (CL-1). "a 30 s tick leaves a label at most one third of
 * that window behind the truth, and never lets 'just now' survive its own
 * definition" was stated as a property of this constant. It is not one this
 * constant can hold on its own: a browser throttles background-tab intervals
 * to a minute or more and freezes them outright in a frozen/bfcached tab, so
 * the bound holds only while the tab is FOREGROUNDED. A dashboard left on a
 * second monitor or behind another tab - which is how this one is meant to be
 * used - could therefore return to the reader still saying "just now" about a
 * stream that went quiet an hour ago. The bound is now enforced rather than
 * assumed: `subscribe` re-reads the clock on `visibilitychange`, so the first
 * paint a returning reader sees is a fresh reading, not a frozen one.
 */
export const CLOCK_INTERVAL_MS = 30_000;

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
let nowMs = Date.now();

function tick(): void {
  nowMs = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0) {
    // Restarting from idle: the cached reading is as old as the last tick
    // before the clock stopped, so take a fresh one before handing it out.
    nowMs = Date.now();
    timer = setInterval(tick, CLOCK_INTERVAL_MS);
    // CL-1. The interval alone cannot hold the staleness bound this module
    // promises: a background tab has its timers throttled or stopped, and the
    // reader who switches back is shown whatever the last tick before that
    // managed to record. Re-reading on the visibility change makes the moment
    // a stale label would otherwise be BELIEVED the moment it is refreshed.
    // Deliberately unconditional: ticking on the way out is a wasted read,
    // while branching on `visibilityState` would buy an untestable arm.
    document.addEventListener('visibilitychange', tick);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    }
  };
}

function getSnapshot(): number {
  return nowMs;
}

/**
 * The current time in epoch milliseconds, re-rendering the caller every
 * `CLOCK_INTERVAL_MS`. Every caller in the app receives the SAME reading from
 * the SAME tick - "now" is one fact, not one per view.
 */
export function useNowMs(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * The time an EVENT happened, for stamping something that just occurred - a
 * response landing, a click - rather than for rendering a duration.
 *
 * It deliberately bypasses the store. The store's reading is up to
 * `CLOCK_INTERVAL_MS` old by design, which is harmless for a "3 minutes ago"
 * label and wrong for a stamp: a response that arrives 10 s after a tick would
 * be recorded 10 s before it happened, and within half a minute of UTC
 * midnight that mis-stamps the DAY. This exists so that the exception is one
 * named function instead of a `Date.now()` sprinkled through views - the rule
 * the module protects is that nothing RENDERS from an ad-hoc reading, not that
 * `Date.now` is never called.
 */
export function readNowMs(): number {
  return Date.now();
}
