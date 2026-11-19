/**
 * OPS-20 (2026-11-19) - self-observability for /api/health: resident memory
 * and event-loop lag, read at request time. The SSE client count is the
 * server's own (see buildServer); everything here is about the process.
 *
 * Event-loop lag comes from `monitorEventLoopDelay`, which records the time
 * between two runs of a libuv timer firing every `resolutionMs`. An idle loop
 * therefore records about `resolutionMs` per sample; the lag is what is left
 * over. The histogram is rotated every `windowMs` so a stall an hour ago does
 * not stay in the p99 forever, and health reports the last complete window -
 * a probe always reads a full window, never a few samples just after a reset.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { HealthDto } from '@agenthropic/shared';

/** Sampling interval of the event-loop timer. */
export const LOOP_LAG_RESOLUTION_MS = 20;
/** Length of one reporting window. */
export const LOOP_LAG_WINDOW_MS = 60_000;

const NS_PER_MS = 1_000_000;

/** The health fields this module supplies. */
export type SelfMetrics = Pick<HealthDto, 'rssBytes' | 'eventLoopLagP99Ms' | 'eventLoopLagMaxMs'>;

/** Lag over one window, in milliseconds past the sampling interval. */
export interface LoopLagWindow {
  readonly p99Ms: number;
  readonly maxMs: number;
}

/** The slice of Node's `IntervalHistogram` the monitor uses. */
export interface LoopDelayHistogram {
  readonly count: number;
  readonly max: number;
  percentile(percentile: number): number;
  enable(): boolean;
  disable(): boolean;
  reset(): void;
}

export interface LoopLagMonitor {
  /** The last complete window, else the current one; null before any sample. */
  snapshot(): LoopLagWindow | null;
  /** Disable the histogram and clear the rotation timer. Idempotent. */
  stop(): void;
}

export interface LoopLagMonitorOptions {
  readonly resolutionMs?: number;
  readonly windowMs?: number;
  /** Test seam: the histogram; defaults to `monitorEventLoopDelay`. */
  readonly histogram?: LoopDelayHistogram;
}

export function startLoopLagMonitor(options: LoopLagMonitorOptions = {}): LoopLagMonitor {
  const resolutionMs = options.resolutionMs ?? LOOP_LAG_RESOLUTION_MS;
  const windowMs = options.windowMs ?? LOOP_LAG_WINDOW_MS;
  const histogram = options.histogram ?? monitorEventLoopDelay({ resolution: resolutionMs });
  const read = (): LoopLagWindow | null =>
    histogram.count === 0
      ? null
      : {
          p99Ms: lagMs(histogram.percentile(99), resolutionMs),
          maxMs: lagMs(histogram.max, resolutionMs),
        };
  let lastWindow: LoopLagWindow | null = null;
  histogram.enable();
  const timer = setInterval(() => {
    // A window without samples (the loop never ran the timer) keeps the
    // previous answer; in practice the rotation itself could not run then.
    lastWindow = read() ?? lastWindow;
    histogram.reset();
  }, windowMs);
  // Health telemetry must never keep the process alive.
  timer.unref();
  let stopped = false;
  return {
    snapshot: () => lastWindow ?? read(),
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      histogram.disable();
    },
  };
}

/** Nanoseconds between timer runs -> milliseconds of lag, 0.1 ms precision. */
function lagMs(delayNs: number, resolutionMs: number): number {
  const lag = delayNs / NS_PER_MS - resolutionMs;
  return lag <= 0 ? 0 : Math.round(lag * 10) / 10;
}

/**
 * Assemble the OPS-20 health fields. `rss` is a seam so the assembly is
 * tested without depending on the test process's memory.
 */
export function selfMetrics(input: {
  readonly loopLag: LoopLagMonitor;
  readonly rss?: () => number;
}): SelfMetrics {
  const rss = input.rss ?? (() => process.memoryUsage.rss());
  const lag = input.loopLag.snapshot();
  return {
    rssBytes: rss(),
    ...(lag === null ? {} : { eventLoopLagP99Ms: lag.p99Ms, eventLoopLagMaxMs: lag.maxMs }),
  };
}
