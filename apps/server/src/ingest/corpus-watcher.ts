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
 * REPLAY CHECKPOINT (opt-in). Supply `checkpoints` and the fingerprint map is
 * hydrated from the database on the first tick against a corpus root, so a
 * RESTART re-reads only the sessions whose bytes moved while the process was
 * down. Omit it and the watcher behaves exactly as it always has: every boot
 * replays the whole corpus. The dep is optional on purpose — the unconditional
 * replay is the fail-safe path and stays the default, and it is the path the P0
 * double-replay proof exercises. A checkpoint may change how much WORK a boot
 * does; it may never change what the boot RESULTS in, which is why only a
 * session that this process successfully projected is ever checkpointed (a
 * failure, a quarantine or a session that yielded no substrate is not) and why
 * the store re-verifies that the session row still exists before handing a
 * fingerprint back.
 *
 * FAILURE POSTURE. A fingerprint is COMMITTED only for a session that did not
 * fail: a failed session stays "changed" and is retried on the next tick.
 * (Committing unconditionally made a failure terminal — the session would be
 * retried only if its file changed again, and never once it ended, so the
 * dashboard silently showed nothing while /api/health still said "ok".) Retries
 * are bounded: after {@link MAX_INGEST_ATTEMPTS} consecutive failures against
 * the SAME fingerprint the session is QUARANTINED — its fingerprint is
 * committed, which stops the retry loop, and it is re-admitted (with a fresh
 * budget) as soon as its file changes. A permanently unparseable file therefore
 * costs a bounded number of passes, not a hot loop. Every failure is reported
 * through `onIngestFailure` with a SANITIZED reason (see
 * {@link sanitizeFailureReason}) — session id and reason, never the substrate.
 * Sessions that yield no substrate at all (`sessionsSkipped`) are not failures
 * and are not retried.
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
import type { ReplayCheckpointStore } from '../db/replay-checkpoints';
import type { IngestEvent } from './ingest-events';
import { runWatchdogSweep } from './watchdog';

/**
 * How many consecutive failed passes a session gets against one unchanged
 * fingerprint before it is quarantined. Small on purpose: the retry exists for
 * a transient cause (a pricing row that arrives, a half-written line), not as a
 * substitute for fixing the corpus.
 */
export const MAX_INGEST_ATTEMPTS = 3;

/** Maximum length of a reported failure reason, after sanitization. */
const MAX_REASON_LENGTH = 300;

/**
 * A per-session ingest failure, in the only shape allowed to leave the ingest
 * boundary: WHICH session and WHY. Never the payload, never the file path,
 * never transcript content — a failure report is liveness diagnostics, and
 * (CD-1) nothing derived from it may become structure.
 */
export interface IngestFailureReport {
  /** The session that failed (already known to the dashboard as an id). */
  readonly sessionId: string;
  /** Sanitized reason: single-line, path-free, length-capped. */
  readonly reason: string;
  /** 1-based count of consecutive failures against this fingerprint. */
  readonly attempt: number;
  /** False once the session is quarantined until its file changes again. */
  readonly willRetry: boolean;
}

/**
 * Make an arbitrary error message safe to log and to broadcast over SSE:
 * absolute paths (which on this machine encode the user's home directory and
 * project names) collapse to `<path>`, all whitespace collapses to single
 * spaces so a reason can never forge a second log line, and the result is
 * length-capped. An ordinary halt-gate refusal survives verbatim.
 */
export function sanitizeFailureReason(reason: string): string {
  const withoutPaths = reason.replace(/(?:\/[\w.@%+-]+){2,}/g, '<path>');
  const singleLine = withoutPaths.replace(/\s+/g, ' ').trim();
  return singleLine.length > MAX_REASON_LENGTH
    ? `${singleLine.slice(0, MAX_REASON_LENGTH - 3)}...`
    : singleLine;
}

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
  /**
   * Persisted replay checkpoint. When supplied, the fingerprint map is hydrated
   * from it on the first tick against a corpus root, so a restart skips the
   * sessions whose bytes have not moved. When omitted (the default, and what the
   * P0 double-replay proof runs), every restart replays the whole corpus.
   */
  readonly checkpoints?: ReplayCheckpointStore;
  /** The live-loop seam: session-ingested and agent-status-changed events. */
  readonly onIngestEvent?: (event: IngestEvent) => void;
  /** Per-file skip diagnostics forwarded from the runner. */
  readonly onWarning?: (skipped: SkippedFile) => void;
  /**
   * Fired once per failed session per pass — including the startup replay.
   * This is the ONLY place an ingest failure becomes visible, so a silent
   * dashboard always has a matching report.
   */
  readonly onIngestFailure?: (report: IngestFailureReport) => void;
  /**
   * Fired when a {@link ContainmentError} escapes a pass. The watcher has
   * ALREADY stopped itself when this runs — the handler decides process fate.
   */
  readonly onFatal?: (error: ContainmentError) => void;
  /**
   * Fired with the outcome of every SCHEDULED pass (the {@link CorpusWatcher.start}
   * interval only — a manual `tick()` already hands its outcome to the caller).
   * This is the seam that lets the composition root see a background pass fail:
   * without it, every post-boot 'read-error' was computed and then discarded,
   * so a corpus that became unreadable mid-flight degraded the dashboard with
   * zero operator-visible evidence.
   */
  readonly onTickOutcome?: (outcome: TickOutcome) => void;
}

/**
 * The result of one pass. Six of the seven arms carry no summary — but they are
 * six DIFFERENT facts about the corpus and the watcher, and a caller that wants
 * to log, alert on or test one of them must be able to tell them apart. This
 * used to be `CorpusIngestSummary | null`, which merged "the corpus is fully
 * checkpointed and quiet" with "there is no corpus root" and with "the root
 * could not be read" — the same collapse of distinct facts that the dashboard
 * forbids for agent status ('unknown' is never `null`). The union costs one
 * field and buys the composition root a truthful boot line.
 */
export type TickOutcome =
  /** A pass ran and ingested the changed sessions. */
  | { readonly kind: 'ingested'; readonly summary: CorpusIngestSummary }
  /** A pass ran; every session on disk matched its committed fingerprint. */
  | { readonly kind: 'unchanged' }
  /** No corpus root resolved (not configured, or gone) — fingerprints reset. */
  | { readonly kind: 'no-corpus-root' }
  /** Re-entrant call while a pass was in flight; this call did nothing. */
  | { readonly kind: 'overlapped' }
  /** The watcher was already stopped; polling is over. */
  | { readonly kind: 'stopped' }
  /** Transient I/O trouble; the pass was skipped and retries next tick. */
  | { readonly kind: 'read-error'; readonly reason: string }
  /** A {@link ContainmentError} escaped: the watcher stopped itself, for good. */
  | { readonly kind: 'containment-halt' };

/** The summary of a pass that ingested, or `null` for every other outcome. */
export function tickSummary(outcome: TickOutcome): CorpusIngestSummary | null {
  return outcome.kind === 'ingested' ? outcome.summary : null;
}

export interface CorpusWatcher {
  /**
   * Run one poll pass now. Always reports WHY the pass ended as it did — see
   * {@link TickOutcome}; use {@link tickSummary} when only the summary matters.
   */
  tick(): TickOutcome;
  /** Begin polling every `intervalMs`. Idempotent; a stopped watcher stays stopped. */
  start(): void;
  /** Stop polling permanently (clearInterval). Idempotent; wired into server close. */
  stop(): void;
}

export function createCorpusWatcher(deps: CorpusWatcherDeps): CorpusWatcher {
  const fs = deps.fs ?? nodeCorpusFs();
  const limits: ReadLimits = { ...DEFAULT_READ_LIMITS, ...deps.limits };
  const nowMs = deps.nowMs ?? Date.now;

  /** sessionId → fingerprint of the last SUCCESSFULLY handled enumeration. */
  const fingerprints = new Map<string, string>();
  /** sessionId → consecutive failures against one fingerprint (retry budget). */
  const attempts = new Map<string, { fingerprint: string; count: number }>();
  /** Corpus root the persisted checkpoint was hydrated from; null = not yet. */
  let hydratedRoot: string | null = null;
  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Drop bookkeeping for sessions that are no longer on disk: a vanished
   * session's stale entry must not survive, or its reappearance would be
   * mistaken for "unchanged" (or inherit a spent retry budget).
   */
  function pruneMissing<T>(map: Map<string, T>, present: Map<string, string>): void {
    for (const sessionId of [...map.keys()]) {
      if (!present.has(sessionId)) {
        map.delete(sessionId);
      }
    }
  }

  /**
   * Commit fingerprints and update the retry budget from the pass result: a
   * session that succeeded (or produced no substrate) commits and clears its
   * budget; a session that failed keeps its old fingerprint so the next tick
   * retries it, until the budget runs out and it is quarantined.
   *
   * Returns the subset that may also be CHECKPOINTED to disk: the sessions this
   * pass actually projected (`projectedIds`, fed by the runner's per-session
   * success event). Deliberately narrower than the in-memory commit set:
   *  - a session that yielded no substrate has no session row to prove the
   *    checkpoint against, so persisting it would be a promise nothing backs;
   *  - a QUARANTINED session is never persisted, so a restart hands it a fresh
   *    retry budget exactly as it does today. Quarantine is a within-process
   *    circuit breaker, not a permanent verdict.
   */
  function settlePass(
    changed: ReadonlySet<string>,
    next: Map<string, string>,
    summary: CorpusIngestSummary,
    projectedIds: ReadonlySet<string>,
  ): Map<string, string> {
    const reasons = new Map<string, string>();
    for (const failure of summary.failures) {
      reasons.set(failure.sessionId, failure.error);
    }
    const checkpointable = new Map<string, string>();
    for (const [sessionId, fingerprint] of next) {
      if (!changed.has(sessionId)) {
        continue; // untouched this pass: its fingerprint is already committed
      }
      const reason = reasons.get(sessionId);
      if (reason === undefined) {
        fingerprints.set(sessionId, fingerprint);
        attempts.delete(sessionId);
        if (projectedIds.has(sessionId)) {
          checkpointable.set(sessionId, fingerprint);
        }
        continue;
      }
      const prior = attempts.get(sessionId);
      const attempt = prior?.fingerprint === fingerprint ? prior.count + 1 : 1;
      const willRetry = attempt < MAX_INGEST_ATTEMPTS;
      attempts.set(sessionId, { fingerprint, count: attempt });
      if (!willRetry) {
        // Quarantine by committing: an unchanged, permanently unparseable file
        // must not be re-read forever. A later append re-admits it.
        fingerprints.set(sessionId, fingerprint);
      }
      deps.onIngestFailure?.({
        sessionId,
        reason: sanitizeFailureReason(reason),
        attempt,
        willRetry,
      });
    }
    return checkpointable;
  }

  /**
   * Enumerate, diff fingerprints, ingest the changed set. Throws
   * ContainmentError only; every other end is named in the returned outcome.
   */
  function ingestChanged(): Extract<
    TickOutcome,
    { kind: 'ingested' | 'unchanged' | 'no-corpus-root' | 'read-error' }
  > {
    const corpusRoot = resolveCorpusRoot(deps.env, fs, deps.homedir);
    if (corpusRoot === null) {
      // No corpus (yet / any more): forget every fingerprint and retry budget so
      // a reappearing corpus replays from scratch — over-ingesting is safe,
      // ingest is idempotent.
      fingerprints.clear();
      attempts.clear();
      hydratedRoot = null;
      return { kind: 'no-corpus-root' };
    }

    // First tick against this root (a fresh process, or a root that changed
    // underneath us): adopt the persisted fingerprints. `load` returns only
    // checkpoints that are current-revision, same-scope and still backed by a
    // session row, and an empty map on any doubt — so the worst case here is
    // the full replay this watcher would have done anyway.
    if (deps.checkpoints !== undefined && hydratedRoot !== corpusRoot) {
      fingerprints.clear();
      attempts.clear();
      for (const [sessionId, fingerprint] of deps.checkpoints.load(corpusRoot)) {
        fingerprints.set(sessionId, fingerprint);
      }
      hydratedRoot = corpusRoot;
    }

    const enumeration = enumerateSessions(fs, corpusRoot);
    if (enumeration.kind === 'unreadable-root') {
      // The root exists but its listing failed. Crucially, NOTHING is pruned:
      // a failed enumeration proves nothing about which sessions are gone, and
      // dropping fingerprints here would replay (or worse, forget) sessions
      // that never moved. Report the trouble and retry next tick.
      return {
        kind: 'read-error',
        reason: `corpus root unreadable (${enumeration.code ?? 'unknown'})`,
      };
    }
    const changed = new Set<string>();
    const next = new Map<string, string>();
    for (const ref of enumeration.refs) {
      const fingerprint = fingerprintSession(fs, ref, limits);
      next.set(ref.sessionId, fingerprint);
      if (fingerprints.get(ref.sessionId) !== fingerprint) {
        changed.add(ref.sessionId);
      }
    }
    pruneMissing(fingerprints, next);
    pruneMissing(attempts, next);

    if (changed.size === 0) {
      return { kind: 'unchanged' };
    }
    // Which sessions this pass actually PROJECTED — the only ones a checkpoint
    // may be written for. Taken from the runner's success event rather than
    // from the summary counts, because the counts are aggregates.
    const projectedIds = new Set<string>();
    const summary = runCorpusIngest({
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
      onSessionIngested: (event) => {
        projectedIds.add(event.sessionId);
        deps.onIngestEvent?.(event);
      },
    });
    const checkpointable = settlePass(changed, next, summary, projectedIds);
    deps.checkpoints?.commit(corpusRoot, checkpointable, new Set(next.keys()));
    return { kind: 'ingested', summary };
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    stopped = true;
  }

  function tick(): TickOutcome {
    // Never two passes at once, and a stopped watcher does nothing — but those
    // are two different reasons and the caller is told which.
    if (stopped) {
      return { kind: 'stopped' };
    }
    if (inFlight) {
      return { kind: 'overlapped' };
    }
    inFlight = true;
    try {
      let outcome: TickOutcome;
      try {
        outcome = ingestChanged();
      } catch (error) {
        if (error instanceof ContainmentError) {
          stop(); // a crafted corpus is a stop-everything signal — no more polls
          deps.onFatal?.(error);
          return { kind: 'containment-halt' };
        }
        // Transient I/O trouble (e.g. EACCES resolving the root): skip this
        // pass, retry next tick. The watchdog below still runs — agent
        // staleness must surface even while the corpus is unreadable. The
        // reason travels with the outcome (sanitized: path-free, single-line,
        // capped) so the operator is told WHAT failed, not just that something
        // did.
        outcome = {
          kind: 'read-error',
          reason: sanitizeFailureReason(error instanceof Error ? error.message : String(error)),
        };
      }
      for (const transition of runWatchdogSweep(deps.db, nowMs(), deps.watchdogThresholdMs)) {
        deps.onIngestEvent?.(transition);
      }
      return outcome;
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (stopped || timer !== null) {
      return;
    }
    timer = setInterval(() => {
      // Tick FIRST, report second: `deps.onTickOutcome?.(tick())` would
      // short-circuit past the tick itself whenever the seam is absent.
      const outcome = tick();
      deps.onTickOutcome?.(outcome);
    }, deps.intervalMs);
  }

  return { tick, start, stop };
}
