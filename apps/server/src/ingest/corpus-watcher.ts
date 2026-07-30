/**
 * WP-IN5 tail-follow + WP-IN10 replay + WP-IN12 watchdog — the live corpus
 * loop. A polling watcher (plain `setInterval`, deliberately NOT `fs.watch`:
 * polling is deterministic, cheap at this corpus size, and immune to the
 * platform-specific event coalescing that loses appends) that on every tick:
 *
 *  1. re-enumerates the corpus and fingerprints every session (lstat only,
 *     via {@link fingerprintSession} — no file content is read to detect change);
 *  2. re-ingests ONLY the sessions whose fingerprint differs from the previous
 *     tick, through {@link runCorpusIngest} with a `sessionFilter` (idempotent,
 *     per-session failure isolation);
 *  3. runs the watchdog sweep, transitioning silent non-terminal agents to
 *     'unknown'.
 *
 * The FIRST tick is the WP-IN10 replay-on-startup: the fingerprint map starts
 * empty, so every discovered session is "changed" and the whole corpus is
 * ingested once, idempotently. Fingerprints are captured BEFORE the ingest
 * pass, so an append landing mid-pass is never lost — the session simply
 * re-ingests on the next tick.
 *
 * Concurrency: better-sqlite3 makes a tick fully synchronous, so two passes
 * can only overlap through re-entrancy (a callback calling `tick()`); a simple
 * in-flight flag makes the inner call a no-op. Error posture: a transient I/O
 * error skips the tick (retried next poll); {@link ContainmentError} — a
 * crafted / compromised corpus — permanently stops the watcher and surfaces
 * through `onFatal` (the composition root turns it into a loud non-zero exit).
 */
import type { PricingEntry } from '@agenthropic/core';
import { resolveCorpusRoot } from '../corpus/corpus-paths';
import { enumerateSessions } from '../corpus/disk-substrate';
import { fingerprintSession } from '../corpus/fingerprint';
import {
  ContainmentError,
  DEFAULT_READ_LIMITS,
  type CorpusFs,
  type ReadLimits,
  type SkippedFile,
} from '../corpus/fs-port';
import { runCorpusIngest, type CorpusIngestSummary, type IngestFn } from '../corpus/ingest-corpus';
import { nodeCorpusFs } from '../corpus/node-corpus-fs';
import type { SqliteDatabase } from '../db/connection';
import type { IngestEvent } from './ingest-events';
import { runWatchdogSweep } from './watchdog';

export interface CorpusWatcherDeps {
  readonly db: SqliteDatabase;
  readonly pricing: readonly PricingEntry[];
  /** Env map forwarded to root/identity resolution (never `process.env` in tests). */
  readonly env: Record<string, string | undefined>;
  /** Poll cadence for {@link CorpusWatcher.start}; `tick()` can also be driven manually. */
  readonly intervalMs: number;
  /** Inactivity window (ms) after which a non-terminal agent becomes 'unknown'. */
  readonly watchdogThresholdMs: number;
  /** Read-only filesystem port; defaults to the production {@link nodeCorpusFs}. */
  readonly fs?: CorpusFs;
  /** Home directory resolver (for the default corpus root); defaults to `os.homedir`. */
  readonly homedir?: () => string;
  /** Read-limit overrides; merged over {@link DEFAULT_READ_LIMITS}. */
  readonly limits?: Partial<ReadLimits>;
  /** ISO clock forwarded to ingestSession's edge stamp; defaults to wall time. */
  readonly now?: () => string;
  /** Epoch-ms clock for the watchdog; defaults to `Date.now` (injectable for tests). */
  readonly nowMs?: () => number;
  /** Ingest function forwarded to the runner; defaults to the real ingestSession. */
  readonly ingest?: IngestFn;
  /** The live-loop seam: session-ingested and agent-status-changed events. */
  readonly onIngestEvent?: (event: IngestEvent) => void;
  /** Per-file skip diagnostics forwarded from the runner. */
  readonly onWarning?: (skipped: SkippedFile) => void;
  /**
   * Fired when a {@link ContainmentError} escapes a pass. The watcher has
   * ALREADY stopped itself when this runs — the handler decides process fate.
   */
  readonly onFatal?: (error: ContainmentError) => void;
}

export interface CorpusWatcher {
  /**
   * Run one poll pass now. Returns the ingest summary, or `null` when nothing
   * was ingested (no change, no corpus root, overlap-skip, stopped, or a
   * transient error that will be retried next tick).
   */
  tick(): CorpusIngestSummary | null;
  /** Begin polling every `intervalMs`. Idempotent; a stopped watcher stays stopped. */
  start(): void;
  /** Stop polling permanently (clearInterval). Idempotent; wired into server close. */
  stop(): void;
}

export function createCorpusWatcher(deps: CorpusWatcherDeps): CorpusWatcher {
  const fs = deps.fs ?? nodeCorpusFs();
  const limits: ReadLimits = { ...DEFAULT_READ_LIMITS, ...deps.limits };
  const nowMs = deps.nowMs ?? Date.now;

  /** sessionId → fingerprint as of the last completed enumeration. */
  const fingerprints = new Map<string, string>();
  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Enumerate, diff fingerprints, ingest the changed set. Throws ContainmentError only. */
  function ingestChanged(): CorpusIngestSummary | null {
    const corpusRoot = resolveCorpusRoot(deps.env, fs, deps.homedir);
    if (corpusRoot === null) {
      // No corpus (yet / any more): forget every fingerprint so a reappearing
      // corpus replays from scratch — over-ingesting is safe, ingest is idempotent.
      fingerprints.clear();
      return null;
    }

    const refs = enumerateSessions(fs, corpusRoot);
    const changed = new Set<string>();
    const next = new Map<string, string>();
    for (const ref of refs) {
      const fingerprint = fingerprintSession(fs, ref, limits);
      next.set(ref.sessionId, fingerprint);
      if (fingerprints.get(ref.sessionId) !== fingerprint) {
        changed.add(ref.sessionId);
      }
    }
    // Replace (not merge): a vanished session's stale fingerprint must not
    // survive, or its reappearance would be mistaken for "unchanged".
    fingerprints.clear();
    for (const [sessionId, fingerprint] of next) {
      fingerprints.set(sessionId, fingerprint);
    }

    if (changed.size === 0) {
      return null;
    }
    return runCorpusIngest({
      db: deps.db,
      pricing: deps.pricing,
      env: deps.env,
      fs,
      homedir: deps.homedir,
      limits,
      now: deps.now,
      ingest: deps.ingest,
      onWarning: deps.onWarning,
      sessionFilter: (ref) => changed.has(ref.sessionId),
      onSessionIngested: deps.onIngestEvent,
    });
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    stopped = true;
  }

  function tick(): CorpusIngestSummary | null {
    if (stopped || inFlight) {
      return null; // never two passes at once; a stopped watcher does nothing
    }
    inFlight = true;
    try {
      let summary: CorpusIngestSummary | null = null;
      try {
        summary = ingestChanged();
      } catch (error) {
        if (error instanceof ContainmentError) {
          stop(); // a crafted corpus is a stop-everything signal — no more polls
          deps.onFatal?.(error);
          return null;
        }
        // Transient I/O trouble (e.g. EACCES resolving the root): skip this
        // pass, retry next tick. The watchdog below still runs — agent
        // staleness must surface even while the corpus is unreadable.
        summary = null;
      }
      for (const transition of runWatchdogSweep(deps.db, nowMs(), deps.watchdogThresholdMs)) {
        deps.onIngestEvent?.(transition);
      }
      return summary;
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (stopped || timer !== null) {
      return;
    }
    timer = setInterval(() => {
      tick();
    }, deps.intervalMs);
  }

  return { tick, start, stop };
}
