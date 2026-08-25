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
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearInterval(timer);
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
