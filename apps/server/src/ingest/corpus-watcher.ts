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
 *     per-session failure isolation), plus any session whose earlier pass
 *     could not read one of its files, on a capped backoff - lstat cannot see
 *     a read recover;
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
 * are bounded: after {@link MAX_INGEST_ATTEMPTS} consecutive failed passes,
 * WHATEVER the bytes did in between, the session is QUARANTINED — its
 * fingerprint is committed, which stops the every-poll retry — and from then
 * on a byte change re-reads it only on a schedule that doubles, 1, 2, 4...
 * passes apart up to {@link REREAD_BACKOFF_CAP_PASSES}, until a read succeeds.
 * The budget deliberately does NOT restart on new bytes: a LIVE transcript
 * that Claude Code appends to every few seconds changed its fingerprint on
 * every poll, so a fingerprint-keyed budget reset to 1/3 each pass and the
 * watcher re-parsed the whole file, and failed, every 3 s for as long as the
 * session ran (observed 2026-09-26: 17 s ticks against one refused
 * transcript). A pricing-table change is the one thing that DOES hand back a
 * fresh budget: pricing is resolved once per pass (when `pricing` is a
 * resolver), and a content change re-admits every session parked by a spent
 * or partly spent budget, because the canonical cure for a halt-gate failure
 * is seeding the missing pricing row, and that row must unblock the watcher
 * without a restart (review M-2). A permanently unparseable file therefore
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
import type { EnumeratedSessions } from '../corpus/fs-port';
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
 * How many consecutive failed passes a session gets before it is quarantined,
 * counted whether or not its bytes moved between them. Small on purpose: the
 * retry exists for a transient cause (a half-written line), not as a
 * substitute for fixing the corpus. A pricing row that arrives is NOT left to this budget: a pricing
 * table change re-admits every parked session with a fresh budget, so a
 * session that burned all attempts against a missing price is retried the
 * moment the row is seeded.
 */
export const MAX_INGEST_ATTEMPTS = 3;

/**
 * Largest gap, in passes, between re-reads of a session whose files could not
 * be read, and between re-reads of a QUARANTINED session whose bytes keep
 * changing. Both back off 1, 2, 4, 8... passes and stop doubling here. Neither
 * ever gives up, because a file that recovers must be picked up without a
 * restart. The backoff exists because a file that NEVER recovers (chmod 000),
 * or a live transcript the halt gate refuses on every pass, would otherwise
 * cost a full re-parse, database writes and a session-ingested event, which
 * makes every open dashboard refetch, on every poll forever. At 32 the
 * worst-case pickup delay stays bounded (32 x the poll interval), and a
 * permanent fault costs about 3% of the passes an every-poll retry would.
 */
export const REREAD_BACKOFF_CAP_PASSES = 32;

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
  /**
   * 1-based count of consecutive failed passes, capped at
   * {@link MAX_INGEST_ATTEMPTS}: a quarantined session that is re-read on its
   * backoff schedule and fails again reports the spent budget, not a fourth
   * attempt it never had.
   */
  readonly attempt: number;
  /**
   * False once the session is quarantined: it is no longer retried on every
   * pass. A byte change re-reads it on the doubling schedule, and a pricing
   * table change re-admits it at once with a fresh budget.
   */
  readonly willRetry: boolean;
}

/**
 * How much of the corpus this process is currently NOT carrying.
 *
 * A failed session has no rows, so every dollar figure the read API computes
 * silently omits its spend — and omits it in the direction that flatters,
 * because a total that is missing sessions always looks SMALLER, never larger.
 * A per-failure log line and an SSE event announce the moment it happens, but
 * neither survives a page reload, so a dashboard opened afterwards presents an
 * incomplete total as a complete one. This is the standing number that closes
 * that gap.
 *
 * Two figures rather than one because they mean different things to a reader:
 * `failing` will be retried on the next pass and may resolve itself, while
 * `quarantined` is re-read only on a backoff schedule when its bytes change,
 * or at once when the pricing table does — that one needs a human.
 */
export interface IngestExclusions {
  /** Sessions whose latest ingest attempt failed; includes the quarantined. */
  readonly failing: number;
  /** Subset of `failing` whose retry budget is spent (see MAX_INGEST_ATTEMPTS). */
  readonly quarantined: number;
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
  /**
   * Pricing table, or a resolver called once per pass. The composition root
   * passes a resolver so a row seeded while the server runs is priced on the
   * very next tick — a boot-time snapshot left the watcher burning its whole
   * retry budget against a stale table (review M-2). When the resolved CONTENT
   * changes, every session parked by a failure budget is re-admitted with a
   * fresh budget.
   */
  readonly pricing: readonly PricingEntry[] | (() => readonly PricingEntry[]);
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
   * Per-session count of messages the M-12 ownership rule skipped, forwarded
   * from the runner. Counts only, never ids — the composition root accumulates
   * them into the figure /api/health reports.
   */
  readonly onUsageCollisions?: (collisions: number) => void;
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
  /**
   * Fired after every pass that actually RAN (never the 'stopped'/'overlapped'
   * short-circuits) with its wall-clock duration — the M-15 seam that lets
   * /api/health report how long the corpus poll actually takes, so a poll that
   * grows past the interval is visible before it starves the event loop.
   */
  readonly onTickDuration?: (durationMs: number) => void;
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
  /**
   * How many sessions the corpus has that this process could not ingest — the
   * spend every dollar total is currently missing. See {@link IngestExclusions}.
   */
  exclusions(): IngestExclusions;
}

/**
 * Order-independent content fingerprint of the pricing table. Equality of
 * fingerprints is what "the pricing table did not change" means to the
 * watcher, so it hangs on every field cost resolution reads and on nothing
 * else (not row order, not object identity across reloads).
 *
 * NUL separates the fields because it is the one byte a model id, a bucket or
 * an ISO timestamp can never contain, so no pair of distinct rows can collide
 * on a concatenation. It is spelled `\0` rather than typed as a raw byte for a
 * reason worth keeping: a literal NUL in the source makes the whole file
 * BINARY to grep, ripgrep and `git diff`, which silently skip it - the file
 * stops being searchable and its diffs stop being reviewable, while compiling
 * and testing exactly as before.
 */
export function pricingContentFingerprint(pricing: readonly PricingEntry[]): string {
  return pricing
    .map(
      (entry) =>
        `${entry.model}\0${entry.bucket}\0${String(entry.usdPerMtok)}\0${entry.effectiveFrom}`,
    )
    .sort()
    .join('\n');
}

export function createCorpusWatcher(deps: CorpusWatcherDeps): CorpusWatcher {
  const fs = deps.fs ?? nodeCorpusFs();
  const limits: ReadLimits = { ...DEFAULT_READ_LIMITS, ...deps.limits };
  const nowMs = deps.nowMs ?? Date.now;

  /** sessionId → fingerprint of the last SUCCESSFULLY handled enumeration. */
  const fingerprints = new Map<string, string>();
  /**
   * sessionId → consecutive failed passes (the retry budget), and, once the
   * budget is spent, the re-read schedule a byte change is held to: `gap`
   * doubles up to {@link REREAD_BACKOFF_CAP_PASSES} and `dueAt` is the first
   * pass a change may be read on. Both are 0 while the session is still
   * within budget, where every pass retries it anyway.
   */
  const attempts = new Map<string, { count: number; gap: number; dueAt: number }>();
  /**
   * sessionId → re-read schedule for sessions whose last pass could not read
   * one of their files (EACCES, EIO, EMFILE...) and did not fail. Such a
   * session is forced back into `changed` once `pass` reaches `dueAt`, with
   * `gap` doubling up to {@link REREAD_BACKOFF_CAP_PASSES}, until a pass reads
   * it cleanly. The fingerprint alone cannot do this: it lstat()s and never
   * reads, so a file that becomes readable again with the same size and mtime
   * fingerprints exactly as before, and the lost content would wait for a
   * restart. A fingerprint change still re-reads at once, whatever the
   * schedule says. Bounded by the sessions on disk: an entry clears on a clean
   * read, on the session leaving the disk, and on a full replay.
   */
  const rereadSchedule = new Map<string, { gap: number; dueAt: number }>();
  /**
   * sessionId → project slug the session was last enumerated under. Lets a
   * pass that could not read a slug tell "hidden by that fault" from "left the
   * disk" (see {@link accountedFor}). A session known only from a hydrated
   * checkpoint has no entry until this process enumerates it.
   */
  const slugs = new Map<string, string>();
  /** Passes that reached the fingerprint diff; the clock the backoff counts in. */
  let pass = 0;
  /** Corpus root the persisted checkpoint was hydrated from; null = not yet. */
  let hydratedRoot: string | null = null;
  /** Pricing content seen by the previous pass; null = no pass yet. */
  let pricingFingerprint: string | null = null;
  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Resolve pricing for THIS pass and re-admit parked sessions when the table
   * changed. Both halves of a quarantine must be undone: the retry budget
   * (`attempts`) AND the committed fingerprint — quarantine works by
   * committing, so clearing the budget alone would leave the session reading
   * as "unchanged" and it would never be retried.
   */
  function resolvePricingForPass(): readonly PricingEntry[] {
    const pricing = typeof deps.pricing === 'function' ? deps.pricing() : deps.pricing;
    const fingerprint = pricingContentFingerprint(pricing);
    if (pricingFingerprint !== null && pricingFingerprint !== fingerprint) {
      for (const sessionId of attempts.keys()) {
        fingerprints.delete(sessionId);
      }
      attempts.clear();
    }
    pricingFingerprint = fingerprint;
    return pricing;
  }

  /**
   * Drop bookkeeping for sessions that are no longer on disk: a vanished
   * session's stale entry must not survive, or its reappearance would be
   * mistaken for "unchanged" (or inherit a spent retry budget).
   */
  function pruneMissing<T>(map: Map<string, T>, present: ReadonlySet<string>): void {
    for (const sessionId of [...map.keys()]) {
      if (!present.has(sessionId)) {
        map.delete(sessionId);
      }
    }
  }

  /**
   * The sessions this pass may keep state for: those it enumerated, plus the
   * known sessions the enumeration could not LOOK at. A slug directory whose
   * listing or probe failed, or a main transcript whose probe failed, hides
   * its sessions for the pass without saying they are gone; forgetting them
   * would prune their fingerprints and drop their persisted checkpoints, and
   * the moment the fault cleared every session under the slug would be read
   * again in full (or replayed from scratch after a restart). So a known
   * session is held while the slug it was last seen under, or its own
   * transcript, is reported unreadable. A session this process has never
   * enumerated (hydrated from a checkpoint) has no slug to match and is held
   * whenever anything at all was unreadable; the first clean pass prunes what
   * really left. A pass with no unreadable entries prunes exactly as before.
   */
  function accountedFor(
    enumeration: EnumeratedSessions,
    next: ReadonlyMap<string, string>,
  ): Set<string> {
    const present = new Set(next.keys());
    const unreadable = new Set<string>();
    for (const skipped of enumeration.skipped) {
      if (skipped.reason === 'unreadable') {
        unreadable.add(skipped.relativePath);
      }
    }
    if (unreadable.size === 0) {
      return present;
    }
    for (const sessionId of [
      ...fingerprints.keys(),
      ...attempts.keys(),
      ...rereadSchedule.keys(),
    ]) {
      if (present.has(sessionId)) {
        continue;
      }
      const slug = slugs.get(sessionId);
      if (
        slug === undefined ||
        unreadable.has(slug) ||
        unreadable.has(`${slug}/${sessionId}.jsonl`)
      ) {
        present.add(sessionId);
      }
    }
    return present;
  }

  /**
   * Commit fingerprints and update the retry budget from the pass result: a
   * session that succeeded (or produced no substrate) commits and clears its
   * budget; a session that failed keeps its old fingerprint so the next tick
   * retries it, until the budget runs out and it is quarantined. A quarantined
   * session that was re-read (its bytes moved and its schedule came due) and
   * failed again stays quarantined with a doubled gap.
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
      const prior = attempts.get(sessionId) ?? { count: 0, gap: 0, dueAt: 0 };
      const count = prior.count + 1;
      const quarantined = count >= MAX_INGEST_ATTEMPTS;
      let backoff = { gap: 0, dueAt: 0 };
      if (quarantined) {
        // Quarantine by committing: a permanently unparseable file must not be
        // re-read on every poll. A later append re-reads it on the schedule,
        // whose gap doubles on every re-read that fails again. The gap is 0
        // while the budget is being spent, so the first re-read after
        // quarantine is due on the very next pass.
        fingerprints.set(sessionId, fingerprint);
        const gap = Math.min(Math.max(prior.gap * 2, 1), REREAD_BACKOFF_CAP_PASSES);
        backoff = { gap, dueAt: pass + gap };
      }
      attempts.set(sessionId, { count, ...backoff });
      deps.onIngestFailure?.({
        sessionId,
        reason: sanitizeFailureReason(reason),
        attempt: Math.min(count, MAX_INGEST_ATTEMPTS),
        willRetry: !quarantined,
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
      rereadSchedule.clear();
      slugs.clear();
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
      slugs.clear();
      for (const [sessionId, fingerprint] of deps.checkpoints.load(corpusRoot)) {
        fingerprints.set(sessionId, fingerprint);
      }
      hydratedRoot = corpusRoot;
    }

    // Resolved BEFORE the fingerprint diff so a pricing change re-admits
    // parked sessions into THIS pass, not the next one.
    const pricing = resolvePricingForPass();

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
    pass += 1;
    const changed = new Set<string>();
    const next = new Map<string, string>();
    for (const ref of enumeration.refs) {
      const fingerprint = fingerprintSession(fs, ref, limits);
      next.set(ref.sessionId, fingerprint);
      slugs.set(ref.sessionId, ref.projectSlug);
      if (fingerprints.get(ref.sessionId) !== fingerprint) {
        // New bytes, or a session this process has never settled. Read it now,
        // unless it is quarantined and its backoff schedule is not yet due: a
        // live transcript the halt gate refuses changes on every poll, and
        // re-reading it every time is the hot loop quarantine exists to stop.
        const parked = attempts.get(ref.sessionId);
        if (parked === undefined || parked.count < MAX_INGEST_ATTEMPTS || pass >= parked.dueAt) {
          changed.add(ref.sessionId);
        }
        continue;
      }
      const reread = rereadSchedule.get(ref.sessionId);
      if (reread !== undefined && pass >= reread.dueAt) {
        changed.add(ref.sessionId);
      }
    }
    // Computed BEFORE the prune so the held sessions' own entries still exist
    // to be matched against the unreadable paths.
    const present = accountedFor(enumeration, next);
    pruneMissing(fingerprints, present);
    pruneMissing(attempts, present);
    pruneMissing(rereadSchedule, present);
    pruneMissing(slugs, present);

    if (changed.size === 0) {
      return { kind: 'unchanged' };
    }
    // Which sessions this pass actually PROJECTED — the only ones a checkpoint
    // may be written for. Taken from the runner's success event rather than
    // from the summary counts, because the counts are aggregates.
    const projectedIds = new Set<string>();
    // Sessions projected WITHOUT a file the build could not read (EIO, EACCES,
    // EMFILE...). Their fingerprint already covers that file (lstat works where
    // the read failed), so a checkpoint would make a restart skip the session
    // for good - a restart without the store would have recovered the file.
    const readIncomplete = new Set<string>();
    const summary = runCorpusIngest({
      db: deps.db,
      pricing,
      env: deps.env,
      fs,
      homedir: deps.homedir,
      limits,
      now: deps.now,
      ingest: deps.ingest,
      onWarning: deps.onWarning,
      onUsageCollisions: deps.onUsageCollisions,
      onSessionFilesSkipped: (ref, skipped) => {
        if (skipped.some((file) => file.reason === 'unreadable')) {
          readIncomplete.add(ref.sessionId);
        }
      },
      sessionFilter: (ref) => changed.has(ref.sessionId),
      onSessionIngested: (event) => {
        projectedIds.add(event.sessionId);
        deps.onIngestEvent?.(event);
      },
      // The M-13 replay is an agent-status-changed event like any watchdog
      // transition, so it rides the SAME seam — handed over directly rather
      // than wrapped, which keeps this loop free of a branch that only the
      // hook-before-row corpus could ever exercise.
      onStatusReconciled: deps.onIngestEvent,
    });
    const checkpointable = settlePass(changed, next, summary, projectedIds);
    for (const sessionId of readIncomplete) {
      checkpointable.delete(sessionId);
    }
    // settlePass has just committed the fingerprint of every read-incomplete
    // session that did not fail, so without a schedule the next pass would see
    // it as unchanged. A session that FAILED is left to the retry budget
    // instead: it re-reads every pass until quarantine and on the budget's own
    // backoff after that, and a second schedule would reopen the very loop
    // that quarantine exists to close. The gap keeps doubling across a
    // byte-change re-read too: new bytes say nothing about whether the fault
    // has gone.
    for (const sessionId of changed) {
      if (readIncomplete.has(sessionId) && !attempts.has(sessionId)) {
        const prior = rereadSchedule.get(sessionId);
        const gap = prior === undefined ? 1 : Math.min(prior.gap * 2, REREAD_BACKOFF_CAP_PASSES);
        rereadSchedule.set(sessionId, { gap, dueAt: pass + gap });
      } else {
        rereadSchedule.delete(sessionId);
      }
    }
    // `present`, not the enumerated set: a session hidden by an unreadable slug
    // keeps its persisted checkpoint, as it keeps its in-memory fingerprint.
    deps.checkpoints?.commit(corpusRoot, checkpointable, present);
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
    const startedAtMs = nowMs();
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
      // In the finally so even a containment-halt pass reports its cost.
      deps.onTickDuration?.(nowMs() - startedAtMs);
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

  /**
   * Read straight off the retry budget rather than off a counter maintained
   * alongside it. `attempts` is already the exact set of sessions whose latest
   * pass failed: `settlePass` deletes an entry the moment a session succeeds,
   * `pruneMissing` drops sessions that left the disk, and a pricing change or a
   * vanished corpus root clears it wholesale. A parallel counter would have to
   * mirror all four of those and would drift the first time one was forgotten -
   * and a drifted count here is worse than none, because it would assert
   * coverage the database does not have.
   */
  function exclusions(): IngestExclusions {
    let quarantined = 0;
    for (const { count } of attempts.values()) {
      if (count >= MAX_INGEST_ATTEMPTS) {
        quarantined += 1;
      }
    }
    return { failing: attempts.size, quarantined };
  }

  return { tick, start, stop, exclusions };
}
