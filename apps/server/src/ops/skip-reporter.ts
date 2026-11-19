/**
 * The skipped-file reporter: rate-limited, counted log lines for corpus files ingest skips.
 *
 * Moved out of the composition root `index.ts` (ARC-4, 2026-11-19), which
 * re-exports it; `index.ts` keeps only the wiring in `start()`.
 */
import type { SkipReason, SkippedFile } from '../corpus/fs-port';

/**
 * How long one (file, reason, code) skip stays silent after being logged, and
 * likewise the per-pass aggregate line. A permanently oversize transcript is
 * re-skipped on EVERY poll tick (~3s), and a log line per tick is how an
 * operator learns to ignore the log; once per interval keeps the fact loud
 * without the spam (review H-2).
 */
export const SKIP_RELOG_INTERVAL_MS = 5 * 60_000;

/** `oversize=2, unreadable=1` - deterministic order, for logs and tests. */
function formatSkipCounters(counters: ReadonlyMap<SkipReason, number>): string {
  return [...counters]
    .map(([reason, count]) => `${reason}=${String(count)}`)
    .sort()
    .join(', ');
}

/**
 * WP-IN5 skip visibility (review H-2). `runCorpusIngest` reports every file it
 * declines to read (oversize, unreadable, empty, symlink...) through
 * `onWarning`, and a skipped transcript means FROZEN dollar totals for that
 * session - so the report must reach the operator. This reporter is what the
 * composition root wires into that seam: a structured, rate-limited log line
 * per skipped file, a rate-limited aggregate line per ingesting pass, and
 * cumulative per-reason counters exposed on {@link RunningServer.skipCounters}.
 *
 * `relativePath` is slug-relative (never absolute) and goes to the local
 * server log only - same exposure as the replay-failure line that already
 * prints the project slug.
 */
export interface SkipReporter {
  /** Count one skipped file; log it unless the same skip logged recently. */
  onSkip(skipped: SkippedFile): void;
  /** Aggregate line for a pass that skipped files; rate-limited, 0 is silent. */
  onTickSkips(filesSkipped: number): void;
  /**
   * Cumulative skip EVENTS by reason since boot, served as `ingestSkips` on
   * `/api/health`. A file declined again on a later pass counts again (a live
   * transcript that stays over the size cap is re-skipped each time its
   * session is re-read), so this is not a count of distinct files.
   */
  counters(): Readonly<Partial<Record<SkipReason, number>>>;
}

export function createSkipReporter(
  options: {
    readonly logError?: (line: string) => void;
    readonly nowMs?: () => number;
    readonly relogIntervalMs?: number;
  } = {},
): SkipReporter {
  const logError = options.logError ?? console.error;
  const nowMs = options.nowMs ?? Date.now;
  const relogIntervalMs = options.relogIntervalMs ?? SKIP_RELOG_INTERVAL_MS;
  const counters = new Map<SkipReason, number>();
  const lastLoggedAt = new Map<string, number>();

  function admit(key: string): boolean {
    const now = nowMs();
    const last = lastLoggedAt.get(key);
    if (last !== undefined && now - last < relogIntervalMs) {
      return false;
    }
    lastLoggedAt.set(key, now);
    return true;
  }

  return {
    onSkip(skipped: SkippedFile): void {
      counters.set(skipped.reason, (counters.get(skipped.reason) ?? 0) + 1);
      // The newline is unforgeable in a relativePath (path segments come from
      // directory entries), so the key cannot collide across files.
      if (admit(`${skipped.reason}\n${skipped.code ?? ''}\n${skipped.relativePath}`)) {
        const code = skipped.code === undefined ? '' : `, ${skipped.code}`;
        logError(
          `corpus ingest: skipped ${skipped.relativePath} (${skipped.reason}${code}) - ` +
            `this file's records are NOT in the dashboard totals ` +
            `(the session's other files, if any, still are).`,
        );
      }
    },
    onTickSkips(filesSkipped: number): void {
      // '\n' cannot start a per-file key (a reason never contains one).
      if (filesSkipped > 0 && admit('\ntick')) {
        logError(
          `corpus watcher: ${String(filesSkipped)} file(s) skipped this pass; ` +
            `skips since boot: ${formatSkipCounters(counters)}.`,
        );
      }
    },
    counters(): Readonly<Partial<Record<SkipReason, number>>> {
      return Object.fromEntries(counters) as Partial<Record<SkipReason, number>>;
    },
  };
}
