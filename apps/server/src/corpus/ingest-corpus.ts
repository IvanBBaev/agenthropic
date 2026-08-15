/**
 * WP-IN5 corpus ingest runner — the top-level orchestrator that turns the
 * on-disk `~/.claude/projects` corpus into persisted rows. It resolves the
 * (read-only) corpus root and instance identity, enumerates sessions, then for
 * each session builds its substrate and drives {@link ingestSession} inside a
 * per-session try/catch, folding every {@link IngestOutcome} into one aggregate
 * {@link CorpusIngestSummary}.
 *
 * Isolation is the load-bearing property: one poisoned session (a non-JSON
 * line, an unpriceable model, a build that yields nothing) is counted and
 * skipped, never allowed to sink the rest of the corpus. ingestSession itself
 * already prices BEFORE its transaction (the halt gate) and never rethrows, so
 * the per-session catch here is belt-and-braces. TWO things abort the whole
 * run: a {@link ContainmentError} escaping buildSessionSubstrate /
 * enumerateSessions (a crafted corpus is a stop-everything signal), and an
 * UNREADABLE corpus root (a plain Error) — returning the empty summary there
 * would report a root this runner could not even list as a quiet, fully
 * ingested corpus. The watcher's tick catch turns that throw into an honest
 * read-error outcome and retries next poll.
 *
 * The runner writes ZERO bytes to the corpus and is idempotent end-to-end
 * (ingestSession upserts and INSERT-OR-IGNOREs), so a re-run over an unchanged
 * corpus reports the same ok count with zero new edges / usage rows.
 */
import type { PricingEntry, SessionSubstrate } from '@agenthropic/core';
import type { SqliteDatabase } from '../db/connection';
import type { AgentStatusChangedEvent, SessionIngestedEvent } from '../ingest/ingest-events';
import { ingestSession, type IngestDeps, type IngestOutcome } from '../ingest/ingest-session';
import { resolveCorpusRoot } from './corpus-paths';
import { buildSessionSubstrate, enumerateSessions } from './disk-substrate';
import {
  DEFAULT_READ_LIMITS,
  type CorpusFs,
  type ReadLimits,
  type SessionRef,
  type SkippedFile,
} from './fs-port';
import { resolveIdentity } from './identity';
import { nodeCorpusFs } from './node-corpus-fs';

/** The ingest entry point the runner drives — injectable so tests can stub it. */
export type IngestFn = (substrate: SessionSubstrate, deps: IngestDeps) => IngestOutcome;

export interface CorpusIngestDeps {
  readonly db: SqliteDatabase;
  readonly pricing: readonly PricingEntry[];
  readonly env: Record<string, string | undefined>;
  /** Read-only filesystem port; defaults to the production {@link nodeCorpusFs}. */
  readonly fs?: CorpusFs;
  /** Ingest function; defaults to the real {@link ingestSession}. */
  readonly ingest?: IngestFn;
  /** Home directory resolver (for the default corpus root); defaults to `os.homedir`. */
  readonly homedir?: () => string;
  /** Read-limit overrides; merged over {@link DEFAULT_READ_LIMITS}. */
  readonly limits?: Partial<ReadLimits>;
  /** Clock forwarded to ingestSession's edge stamp; defaults to wall time. */
  readonly now?: () => string;
  /** Optional sink for per-file skip diagnostics (never affects the summary). */
  readonly onWarning?: (skipped: SkippedFile) => void;
  /**
   * Admission predicate applied right after enumeration — the tail-follow
   * watcher passes only changed sessions through. `sessionsDiscovered` counts
   * the ADMITTED refs (the pass's actual working set), not the raw enumeration.
   */
  readonly sessionFilter?: (ref: SessionRef) => boolean;
  /** Fired after each successfully ingested session (WP-IN5 live loop seam). */
  readonly onSessionIngested?: (event: SessionIngestedEvent) => void;
  /**
   * Fired once per M-13 status transition the projection committed while
   * inserting an agent for the first time — the same live-loop seam as
   * `onSessionIngested`, for the other half of what an ingest can change.
   * Ordered AFTER the session's own event on purpose: a client learns that the
   * agent exists before it is told the agent's status settled.
   */
  readonly onStatusReconciled?: (event: AgentStatusChangedEvent) => void;
  /**
   * Fired once per session that hit the M-12 ownership rule, with the number of
   * messages skipped. Counts only, never ids — same posture as the writer's own
   * log line: a collision is an operator-visible integrity signal, not a
   * payload channel.
   */
  readonly onUsageCollisions?: (collisions: number) => void;
}

/** One session that failed to ingest, with the surfaced reason. */
export interface CorpusIngestFailure {
  readonly sessionId: string;
  readonly projectSlug: string;
  readonly error: string;
}

/** Aggregate result of a whole-corpus ingest pass. */
export interface CorpusIngestSummary {
  readonly sessionsDiscovered: number;
  readonly sessionsOk: number;
  readonly sessionsFailed: number;
  readonly sessionsSkipped: number;
  readonly agentsUpserted: number;
  readonly edgesInserted: number;
  readonly usageRowsInserted: number;
  readonly filesSkipped: number;
  readonly totalCostUsd: number;
  readonly failures: readonly CorpusIngestFailure[];
}

function emptySummary(): CorpusIngestSummary {
  return {
    sessionsDiscovered: 0,
    sessionsOk: 0,
    sessionsFailed: 0,
    sessionsSkipped: 0,
    agentsUpserted: 0,
    edgesInserted: 0,
    usageRowsInserted: 0,
    filesSkipped: 0,
    totalCostUsd: 0,
    failures: [],
  };
}

export function runCorpusIngest(deps: CorpusIngestDeps): CorpusIngestSummary {
  const fs = deps.fs ?? nodeCorpusFs();
  const ingest = deps.ingest ?? ingestSession;
  const limits: ReadLimits = { ...DEFAULT_READ_LIMITS, ...deps.limits };
  const now = deps.now ?? ((): string => new Date().toISOString());

  const corpusRoot = resolveCorpusRoot(deps.env, fs, deps.homedir);
  if (corpusRoot === null) {
    return emptySummary(); // no corpus on this machine yet → nothing to do
  }

  const { instance, hostId } = resolveIdentity(deps.env);
  const enumeration = enumerateSessions(fs, corpusRoot);
  if (enumeration.kind === 'unreadable-root') {
    throw new Error(`corpus root unreadable (${enumeration.code ?? 'unknown'})`);
  }
  const refs =
    deps.sessionFilter === undefined
      ? enumeration.refs
      : enumeration.refs.filter(deps.sessionFilter);

  let filesSkipped = 0;

  // Enumeration-level exclusions (today: `duplicate-session`, review M-14) are
  // reported BEFORE the per-session loop and regardless of `sessionFilter` — a
  // shadowed copy is a corpus-level fact, not a property of any admitted ref.
  for (const skipped of enumeration.skipped) {
    filesSkipped += 1;
    deps.onWarning?.(skipped);
  }

  let sessionsOk = 0;
  let sessionsFailed = 0;
  let sessionsSkipped = 0;
  let agentsUpserted = 0;
  let edgesInserted = 0;
  let usageRowsInserted = 0;
  let totalCostUsd = 0;
  const failures: CorpusIngestFailure[] = [];

  for (const ref of refs) {
    const built = buildSessionSubstrate(fs, ref, limits);

    // Warnings first, and for BOTH outcomes. They used to be reported only when
    // the session survived, so an unreadable transcript was announced when a
    // sibling subagent happened to save the session and silently swallowed when
    // it did not - the total loss reported less than the partial one.
    for (const skipped of built.skipped) {
      filesSkipped += 1;
      deps.onWarning?.(skipped);
    }

    if (built.kind === 'no-substrate') {
      sessionsSkipped += 1;
      continue;
    }

    let outcome: IngestOutcome;
    try {
      outcome = ingest(built.substrate, {
        db: deps.db,
        pricing: deps.pricing,
        instance,
        hostId,
        projectSlug: built.projectSlug,
        now,
      });
    } catch (err) {
      // Belt-and-braces: ingestSession contracts never to throw, but the runner
      // must still isolate a would-be throw to this one session.
      sessionsFailed += 1;
      failures.push({
        sessionId: ref.sessionId,
        projectSlug: ref.projectSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (outcome.ok) {
      sessionsOk += 1;
      agentsUpserted += outcome.agentsUpserted;
      edgesInserted += outcome.edgesInserted;
      usageRowsInserted += outcome.usageRowsInserted;
      totalCostUsd += outcome.costUsd ?? 0;
      deps.onSessionIngested?.({
        type: 'session-ingested',
        sessionId: outcome.sessionId ?? ref.sessionId,
        projectSlug: built.projectSlug,
        agentsUpserted: outcome.agentsUpserted,
        edgesInserted: outcome.edgesInserted,
        usageRowsInserted: outcome.usageRowsInserted,
        costUsd: outcome.costUsd,
      });
      for (const reconciled of outcome.statusReconciliations) {
        deps.onStatusReconciled?.(reconciled);
      }
      if (outcome.crossSessionUsageCollisions > 0) {
        deps.onUsageCollisions?.(outcome.crossSessionUsageCollisions);
      }
    } else {
      sessionsFailed += 1;
      failures.push({
        sessionId: outcome.sessionId ?? ref.sessionId,
        projectSlug: ref.projectSlug,
        error: outcome.error ?? 'unknown ingest failure',
      });
    }
  }

  return {
    sessionsDiscovered: refs.length,
    sessionsOk,
    sessionsFailed,
    sessionsSkipped,
    agentsUpserted,
    edgesInserted,
    usageRowsInserted,
    filesSkipped,
    totalCostUsd,
    failures,
  };
}
