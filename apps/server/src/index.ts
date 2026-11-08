/**
 * @agenthropic/server - composition root (WP-U0 + WP-IN10 live loop).
 *
 * loadConfig (mandatory DASHBOARD_TOKEN) -> openDatabase (WAL asserted) ->
 * prepareSchema (downgrade guard, pre-migration backup, runMigrations) -> listen
 * on the constant loopback host -> verify every bound address is loopback or
 * shut down hard -> corpus replay (the watcher's first
 * tick, when ingest is enabled) -> start the poll loop. The replay runs AFTER
 * the bind (review M-16): on a large corpus it takes seconds, and a probe that
 * hits the port during it should see 'replaying' on /api/health rather than
 * connection refused.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { getSessionProjectSlug } from './api/queries';
import { createSubstrateProvider } from './api/substrate-provider';
import { HOST, loadConfig } from './config';
import type { SkipReason, SkippedFile } from './corpus/fs-port';
import type { CorpusIngestSummary } from './corpus/ingest-corpus';
import { nodeCorpusFs } from './corpus/node-corpus-fs';
import { createTailCachingFs } from './corpus/tail-cache';
import { backupDatabase } from './db/backup';
import { loadAlertsConfig, startAlerting, type AlertingService } from './alerts/index';
import { loadPricing } from './db/pricing';
import { openDatabase, type SqliteDatabase } from './db/connection';
import { secureDataFiles } from './db/file-modes';
import { SqliteEventStore } from './db/event-store';
import {
  assertSchemaNotNewer,
  currentSchemaVersion,
  migrations,
  pendingMigrationIds,
  runMigrations,
  type Migration,
  type MigrationRunResult,
} from './db/migrations';
import { createReplayCheckpointStore } from './db/replay-checkpoints';
import { applyHookLiveness } from './hooks/liveness-status';
import { registerHookRoutes } from './hooks/routes';
import {
  createCorpusWatcher,
  MAX_INGEST_ATTEMPTS,
  REPLAY_MAX_SESSIONS_PER_PASS,
  REREAD_BACKOFF_CAP_PASSES,
  type CorpusWatcher,
  type IngestFailureReport,
  type TickOutcome,
} from './ingest/corpus-watcher';
import { toIngestFailureEvent, toRealtimeEvent } from './realtime/bridge';
import { RealtimeHub } from './realtime/hub';
import { defaultJournalPath } from './retention/journal';
import { signedRetentionPolicy } from './retention/policy';
import type { RetentionPort } from './retention/port';
import { createRetentionRunner, RetentionRunError } from './retention/runner';
import { describeRetentionPolicy, retentionRunLine } from './retention/summary';
import { buildServer, type OperationalHealth } from './server';

export {
  HOST,
  loadConfig,
  DEFAULT_PORT,
  DEFAULT_DB_PATH,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WATCHDOG_MINUTES,
  DEFAULT_WEB_ROOT,
  DEFAULT_RETENTION_EVENTS_DAYS,
  DEFAULT_RETENTION_BACKUP_DAYS,
  DEFAULT_RETENTION_BACKUP_KEEP_MIN,
} from './config';
export type { ServerConfig } from './config';
export {
  registerStaticSite,
  contentTypeFor,
  readSiteFile,
  SPA_INDEX_FILE,
  SPA_NOT_BUILT_STATUS,
  SPA_NOT_BUILT_MESSAGE,
  NOT_FOUND_MESSAGE,
  DEFAULT_CONTENT_TYPE,
} from './http/static-site';
export type { StaticSiteOptions } from './http/static-site';
export { openDatabase, assertConnectionPragmas } from './db/connection';
export type { SqliteDatabase } from './db/connection';
export {
  migrations,
  runMigrations,
  currentSchemaVersion,
  assertSchemaNotNewer,
  pendingMigrationIds,
} from './db/migrations';
export type { Migration, MigrationRunResult } from './db/migrations';
export { SqliteEventStore } from './db/event-store';
export { insertOrchestrationEdge } from './db/edges';
export type { OrchestrationEdgeInsert, EdgeInsertResult } from './db/edges';
export { loadPricing } from './db/pricing';
export { upsertSession, mirrorMainAgentStatus } from './db/sessions';
export type { SessionUpsert } from './db/sessions';
export { upsertAgent, listWatchdogCandidates, setAgentStatus, applyAgentStatus } from './db/agents';
export type { AgentUpsert, WatchdogCandidate } from './db/agents';
export { insertTokenUsageRows } from './db/token-usage';
export type { TokenUsageInsertResult } from './db/token-usage';
export { createReplayCheckpointStore, REPLAY_CHECKPOINT_REVISION } from './db/replay-checkpoints';
export type { ReplayCheckpointStore, ReplayCheckpointStoreOptions } from './db/replay-checkpoints';
export { ingestSession } from './ingest/ingest-session';
export type { IngestDeps, IngestOutcome } from './ingest/ingest-session';
export { normalizeSession } from './ingest/normalize-session';
export type { NormalizedSession, NormalizeOptions } from './ingest/normalize-session';
export { projectSession } from './ingest/project-session';
export type { ProjectionCounts } from './ingest/project-session';
export { createCorpusWatcher, tickSummary } from './ingest/corpus-watcher';
export type { CorpusWatcher, CorpusWatcherDeps, TickOutcome } from './ingest/corpus-watcher';
export { decideWatchdogVerdict, isTerminalAgentStatus, runWatchdogSweep } from './ingest/watchdog';
export type {
  IngestEvent,
  SessionIngestedEvent,
  AgentStatusChangedEvent,
} from './ingest/ingest-events';
export {
  runCorpusIngest,
  enumerateSessions,
  buildSessionSubstrate,
  fingerprintSession,
  nodeCorpusFs,
  resolveIdentity,
  resolveCorpusRoot,
  ContainmentError,
  OversizeError,
  DEFAULT_READ_LIMITS,
} from './corpus/index';
export type {
  CorpusFs,
  SessionRef,
  BuiltSubstrate,
  NoSubstrate,
  SubstrateBuild,
  EnumeratedSessions,
  UnreadableRoot,
  SessionEnumeration,
  ReadLimits,
  SkippedFile,
  CorpusIngestDeps,
  CorpusIngestSummary,
  CorpusIngestFailure,
} from './corpus/index';
export { backupDatabase, restoreDatabase } from './db/backup';
export { buildServer } from './server';
export type { BuildServerOptions } from './server';
export { RealtimeHub, serializeSseFrame } from './realtime/hub';
export { toIngestFailureEvent, toRealtimeEvent } from './realtime/bridge';
export { registerHookRoutes, HOOK_EVENT_PATH } from './hooks/routes';
export type { HookRoutesOptions } from './hooks/routes';
export {
  applyHookLiveness,
  resolveHookStatusTarget,
  agentIdFromTranscriptPath,
  STOP_HOOK,
  SUBAGENT_STOP_HOOK,
} from './hooks/liveness-status';
export type { HookStatusTarget } from './hooks/liveness-status';
export { createSubstrateProvider } from './api/substrate-provider';
export type {
  SubstrateProvider,
  SubstrateProviderDeps,
  SubstrateLookup,
  ResolvedSessionSubstrate,
} from './api/substrate-provider';

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly db: SqliteDatabase;
  /**
   * Cumulative per-reason counts of corpus files skipped since boot (review
   * H-2): the dollar totals of a skipped transcript are frozen, so the count
   * must be inspectable, not just greppable from the log.
   */
  skipCounters(): Readonly<Partial<Record<SkipReason, number>>>;
  close(): Promise<void>;
}

export function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * One entry of `app.addresses()`. Since fastify 5.12 the list may also hold a
 * plain string: the path of a pipe or Unix socket. The server never listens on
 * one, so a string entry is never a verified loopback IP.
 */
export type BoundAddress = string | { readonly address: string; readonly port?: number };

/** `host:port` for an IP listener, the path itself for a pipe or socket. */
export function describeBoundAddress(entry: BoundAddress): string {
  return typeof entry === 'string' ? entry : `${entry.address}:${String(entry.port)}`;
}

/**
 * Post-listen defence in depth: if ANY bound address is not loopback, log
 * (without secrets) and terminate the process. An EMPTY address list fails
 * closed the same way: nothing was verified, so "every address is loopback"
 * would be a vacuous pass. Exported for direct testing.
 */
export async function enforceLoopbackOrExit(
  addresses: readonly BoundAddress[],
  cleanup: () => Promise<void>,
): Promise<void> {
  if (addresses.length === 0) {
    console.error(
      'FATAL: the server reported no bound address, so the loopback-only invariant ' +
        'could not be verified; shutting down.',
    );
    await cleanup();
    process.exit(1);
  }
  // A pipe or socket path is not a loopback IP: fail closed on it as well.
  const offenders = addresses.filter(
    (entry) => typeof entry === 'string' || !isLoopbackAddress(entry.address),
  );
  if (offenders.length === 0) {
    return;
  }
  console.error(
    `FATAL: server bound non-loopback address(es): ${offenders
      .map((entry) => (typeof entry === 'string' ? entry : entry.address))
      .join(', ')}. Loopback-only is a hard invariant; shutting down.`,
  );
  await cleanup();
  process.exit(1);
}

/**
 * WP-IN10 decision, documented here: a {@link ContainmentError} escaping the
 * corpus loop means a crafted / compromised corpus — a STOP-EVERYTHING signal,
 * never something to skip past. Log loudly (the message carries paths only,
 * never tokens) and exit non-zero. Exported for direct testing, mirroring
 * {@link enforceLoopbackOrExit}. Per-session poison never reaches here: the
 * runner isolates it and it merely shows up in the replay summary.
 */
export function exitOnCorpusFatal(error: Error, cleanup: () => void): void {
  console.error(
    `FATAL: corpus containment violation - ${error.message}. ` +
      'A crafted or compromised corpus is a stop-everything signal; shutting down.',
  );
  cleanup();
  process.exit(1);
}

function logReplaySummary(replay: CorpusIngestSummary): void {
  console.log(
    `corpus replay: ${String(replay.sessionsOk)}/${String(replay.sessionsDiscovered)} sessions ok, ` +
      `${String(replay.sessionsFailed)} failed, ${String(replay.sessionsSkipped)} skipped, ` +
      `${String(replay.agentsUpserted)} agents, ${String(replay.edgesInserted)} edges, ` +
      `${String(replay.usageRowsInserted)} usage rows, ` +
      `${String(replay.filesSkipped)} files skipped`,
  );
  if (replay.totalUnpricedTokens > 0) {
    console.warn(
      `corpus replay: ${String(replay.totalUnpricedTokens)} tokens have no price row in force; ` +
        'they are stored and shown as unpriced, never as $0 - seed model_pricing to price them',
    );
  }
  for (const failure of replay.failures) {
    console.error(
      `corpus replay failure: session ${failure.sessionId} (${failure.projectSlug}): ${failure.error}`,
    );
  }
}

/** Two pass summaries as one: counts add up, failures concatenate in order. */
export function mergeReplaySummaries(
  a: CorpusIngestSummary,
  b: CorpusIngestSummary,
): CorpusIngestSummary {
  return {
    sessionsDiscovered: a.sessionsDiscovered + b.sessionsDiscovered,
    sessionsOk: a.sessionsOk + b.sessionsOk,
    sessionsFailed: a.sessionsFailed + b.sessionsFailed,
    sessionsSkipped: a.sessionsSkipped + b.sessionsSkipped,
    agentsUpserted: a.agentsUpserted + b.agentsUpserted,
    edgesInserted: a.edgesInserted + b.edgesInserted,
    usageRowsInserted: a.usageRowsInserted + b.usageRowsInserted,
    filesSkipped: a.filesSkipped + b.filesSkipped,
    totalCostUsd: a.totalCostUsd + b.totalCostUsd,
    totalUnpricedTokens: a.totalUnpricedTokens + b.totalUnpricedTokens,
    failures: [...a.failures, ...b.failures],
  };
}

export interface StartupReplayOptions {
  /** The per-pass session cap handed to every replay tick. */
  readonly maxSessionsPerPass: number;
  /**
   * Resolves after one event-loop turn; awaited before EVERY pass, the first
   * included, so connections accepted during the bind - and every request that
   * arrives while the replay runs - are answered between passes. Defaults to
   * `setImmediate`; a test seam.
   */
  readonly yieldTurn?: () => Promise<void>;
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * WP-IN10 replay-on-startup, in chunks. The first sweep IS the replay: without
 * a persisted checkpoint every discovered session is admitted; with one, only
 * the sessions whose bytes moved while the process was down. A single
 * synchronous pass over a large corpus would hold the event loop for its whole
 * duration - /api/health could not even say 'replaying' - so the sweep runs as
 * capped passes with an event-loop turn before each, until the watcher reports
 * nothing pending. The watcher counts the passes of one sweep as ONE pass for
 * the retry budget (see corpus-watcher.ts), so the chunking changes when the
 * event loop breathes, never which sessions fail or are quarantined.
 *
 * The boot log gets ONE summary for the whole sweep. A pass that ingested
 * nothing is not silent either: `tick()` names which reason ended it, and
 * {@link replayOutcomeLine} says so - except an 'unchanged' or 'stopped'
 * ending AFTER passes that did ingest, which only means the remainder vanished
 * from disk or the server is shutting down, and would otherwise read as
 * "nothing was replayed" under a summary that says otherwise.
 *
 * Returns the last pass's outcome, which seeds the tick-trouble state.
 */
export async function runStartupReplay(
  watcher: Pick<CorpusWatcher, 'tick'>,
  options: StartupReplayOptions,
): Promise<TickOutcome> {
  const yieldTurn = options.yieldTurn ?? nextTurn;
  let total: CorpusIngestSummary | null = null;
  let outcome: TickOutcome;
  for (;;) {
    await yieldTurn();
    outcome = watcher.tick({ maxSessions: options.maxSessionsPerPass });
    if (outcome.kind !== 'ingested') {
      break;
    }
    total = total === null ? outcome.summary : mergeReplaySummaries(total, outcome.summary);
    if (!outcome.pending) {
      break;
    }
  }
  if (total !== null) {
    logReplaySummary(total);
  }
  if (
    outcome.kind !== 'ingested' &&
    !(total !== null && (outcome.kind === 'unchanged' || outcome.kind === 'stopped'))
  ) {
    const line = replayOutcomeLine(outcome);
    (line.level === 'error' ? console.error : console.log)(line.text);
  }
  return outcome;
}

/**
 * The boot line for a replay pass that ingested nothing, one distinct sentence
 * per reason. This call site used to print NOTHING in that case, on the honest
 * grounds that `tick()` returned a bare `null` it could not interpret — so a
 * fully-checkpointed boot ("nothing changed, all good") looked exactly like a
 * missing corpus root and like an unreadable one, and a silent dashboard had no
 * matching line anywhere. {@link TickOutcome} removed the ambiguity, so the
 * silence is no longer warranted.
 *
 * TOTAL on purpose: every non-ingesting outcome gets a line. An earlier draft
 * returned `null` for the three that "cannot happen on a fresh watcher's first
 * tick", which handed the composition root a branch nothing could ever take —
 * dead code that a coverage number would have to be taught to ignore. Those
 * three are impossible only if the wiring is right; if one ever does surface,
 * an operator reading the boot log deserves to be told, and 'error' is the
 * honest level for a line that means the watcher is not doing its job.
 */
export function replayOutcomeLine(outcome: Exclude<TickOutcome, { kind: 'ingested' }>): {
  readonly level: 'log' | 'error';
  readonly text: string;
} {
  switch (outcome.kind) {
    case 'unchanged':
      return {
        level: 'log',
        text: 'corpus replay: no session changed since the last checkpoint - nothing re-read.',
      };
    case 'no-corpus-root':
      return {
        level: 'log',
        text: 'corpus replay: no corpus root resolved - nothing to replay.',
      };
    case 'read-error':
      return {
        level: 'error',
        text:
          `corpus replay: the corpus could not be read this pass (${outcome.reason}) - ` +
          'retrying on the next poll.',
      };
    case 'containment-halt':
      // Points at the FATAL line rather than restating it: one containment
      // violation must never read as two separate incidents.
      return {
        level: 'error',
        text: 'corpus replay: halted by a containment violation - see the FATAL line above.',
      };
    case 'stopped':
      return {
        level: 'error',
        text: 'corpus replay: the watcher was already stopped - nothing was replayed.',
      };
    case 'overlapped':
      return {
        level: 'error',
        text: 'corpus replay: a pass was already in flight - nothing was replayed.',
      };
  }
}

/** The two {@link TickOutcome} kinds that mean the corpus loop is in trouble. */
export type TickTroubleKind = 'read-error' | 'no-corpus-root';

/**
 * Fold one scheduled tick outcome into the watcher's trouble state, emitting a
 * log line ONLY on a state transition. Every post-boot tick used to discard its
 * outcome entirely, so a corpus that became unreadable mid-flight froze the
 * dashboard with zero operator-visible evidence; but a poll loop also must not
 * repeat the same line every interval, so the rule is: entering trouble logs
 * once (with the carried reason), recovering logs once, and a steady state -
 * healthy or troubled - is silent. 'stopped' / 'overlapped' /
 * 'containment-halt' neither log (the halt already has its FATAL line) nor
 * move the state: none of them says anything about whether the corpus reads.
 */
export function tickTroubleTransition(
  previous: TickTroubleKind | null,
  outcome: TickOutcome,
): {
  readonly next: TickTroubleKind | null;
  readonly line: { readonly level: 'log' | 'error'; readonly text: string } | null;
} {
  switch (outcome.kind) {
    case 'stopped':
    case 'overlapped':
    case 'containment-halt':
      return { next: previous, line: null };
    case 'read-error':
      return {
        next: 'read-error',
        line:
          previous === 'read-error'
            ? null
            : {
                level: 'error',
                text:
                  `corpus watcher: the corpus could not be read (${outcome.reason}) - ` +
                  'the dashboard is stale until this clears.',
              },
      };
    case 'no-corpus-root':
      return {
        next: 'no-corpus-root',
        line:
          previous === 'no-corpus-root'
            ? null
            : {
                level: 'log',
                text: 'corpus watcher: no corpus root resolved - nothing to ingest until one appears.',
              },
      };
    case 'ingested':
    case 'unchanged':
      return {
        next: null,
        line:
          previous === null
            ? null
            : {
                level: 'log',
                text: 'corpus watcher: the corpus is readable again - resuming normal ingest.',
              },
      };
  }
}

/**
 * The line that ends the replay phase a read error left open (2026-10-08).
 * A boot replay that a read error cuts short stays 'replaying' into the
 * scheduled polls, and the first poll that does not continue the sweep ends
 * the phase - health then says 'ok' for the life of the process (owner
 * decision, 2026-10-01). That end used to be silent: the boot log said the
 * corpus could not be read, health later said 'ok', and nothing in between
 * said which poll ended the phase or on how much of the corpus. Returns
 * `null` for the one outcome that does NOT end the phase - a capped pass with
 * more to drain - and a line for every other outcome, so the composition root
 * never has to decide on its own which outcomes are an ending. Total on
 * purpose, like {@link replayOutcomeLine}: the three "cannot happen on a poll"
 * arms get an 'error' line rather than a branch nothing can take.
 */
export function replayPhaseEndLine(outcome: TickOutcome): {
  readonly level: 'log' | 'error';
  readonly text: string;
} | null {
  switch (outcome.kind) {
    case 'ingested':
      return outcome.pending
        ? null
        : {
            level: 'log',
            text:
              'corpus replay: the scheduled poll finished the sweep a read error cut short - ' +
              "health now says 'ok'.",
          };
    case 'unchanged':
      return {
        level: 'log',
        text:
          'corpus replay: the corpus reads again and no session changed since the last ' +
          "checkpoint - health now says 'ok'.",
      };
    case 'read-error':
      // The honest ending, not a recovery: the sessions the sweep did not reach
      // are still owed. The watcher keeps the sweep and its cap on a read
      // error, so they land through the scheduled poll in capped passes once
      // the corpus reads again - under a health answer that already says 'ok'.
      return {
        level: 'error',
        text:
          `corpus replay: the corpus still could not be read on the next poll (${outcome.reason}) - ` +
          "the phase ends here and health says 'ok' on what landed; the sessions the sweep " +
          'did not reach land through the scheduled poll in capped passes once the corpus ' +
          'reads again.',
      };
    case 'no-corpus-root':
      return {
        level: 'log',
        text:
          "corpus replay: the corpus root is gone - the phase ends here and health says 'ok' " +
          'on what landed; a root that reappears is picked up by the scheduled poll.',
      };
    case 'containment-halt':
      return {
        level: 'error',
        text:
          'corpus replay: halted by a containment violation on the poll that was finishing ' +
          "the replay - see the FATAL line above; health says 'ok' on what landed.",
      };
    case 'stopped':
      return {
        level: 'error',
        text:
          'corpus replay: the watcher was stopped before the poll could finish the replay - ' +
          "health says 'ok' on what landed.",
      };
    case 'overlapped':
      return {
        level: 'error',
        text:
          'corpus replay: a pass was already in flight when the poll that was finishing the ' +
          "replay started - the phase ends here and health says 'ok' on what landed.",
      };
  }
}

/**
 * WP-IN5 the failure-visibility seam: an ingest failure reaches BOTH the
 * operator (a server log) and the dashboard (the SSE stream every client is
 * already listening on).
 *
 * Deliberately NOT an `/api/health` field and NOT a new endpoint. Health
 * answers "is this process serving requests"; one poisoned session does not
 * make an otherwise healthy server degraded, and wiring it there would make
 * health lie in the opposite direction - red for a condition the server is
 * correctly surviving. The retry verdict is the honest part: `will retry` says
 * the watcher intends another pass, `quarantined` says the budget is spent and
 * this session is re-read only when its bytes change, at a cadence that
 * doubles up to REREAD_BACKOFF_CAP_PASSES passes, or at once when a pricing
 * row lands.
 *
 * `report.reason` arrives already sanitized by the watcher - no absolute path,
 * no transcript content, no hook payload, length-capped.
 */
export function reportIngestFailure(
  report: IngestFailureReport,
  hub: RealtimeHub,
  occurredAt: string,
): void {
  const verdict = report.willRetry
    ? 'will retry'
    : `quarantined: re-read on a change, at most every ${String(REREAD_BACKOFF_CAP_PASSES)} passes`;
  console.error(
    `corpus ingest failure: session ${report.sessionId} ` +
      `(attempt ${String(report.attempt)}/${String(MAX_INGEST_ATTEMPTS)}, ${verdict}): ` +
      report.reason,
  );
  hub.publish(toIngestFailureEvent(report, occurredAt));
}

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

/**
 * Backup cadence (review M-20: `events_raw` is the one non-re-derivable table,
 * and a backup capability nothing runs is not a backup). The expiry window and
 * the keep-minimum floor used to sit here as PROVISIONAL constants; since D3
 * (2026-09-08) they are configuration - `DASHBOARD_RETENTION_BACKUP_DAYS` and
 * `DASHBOARD_RETENTION_BACKUP_KEEP_MIN` in `config.ts` - and reach this timer
 * inside the retention policy. The cadence itself stays a constant.
 */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BackupScheduler {
  /**
   * One backup and - only when that backup succeeded - one retention pass.
   * Exactly what the daily timer fires.
   */
  runOnce(): Promise<void>;
  /** Clear the daily timer. Idempotent; wired into server close. */
  stop(): void;
  /**
   * R11: the newest successful backup and the most recent failure, for
   * /api/health. `lastError` is cleared by the next successful backup.
   */
  state(): BackupState;
}

export interface BackupState {
  readonly lastBackupAt: Date | null;
  readonly lastError: string | null;
}

/**
 * Assemble the R11 / OPS-5 health fields. Pure apart from two `stat` calls,
 * so it is tested directly. `ingest: null` (ingest off) omits the tick
 * fields; `backup: null` (scheduler not yet created) omits the backup fields;
 * an unreadable database file omits the size fields. A missing WAL file is a
 * genuine 0 (checkpointed and truncated), not an unknown.
 */
export function operationalHealth(input: {
  readonly dbPath: string;
  readonly ingest: {
    readonly lastTickAt: Date | null;
    readonly corpusTrouble: TickTroubleKind | null;
  } | null;
  readonly backup: BackupState | null;
  readonly hookDeliveries: NonNullable<OperationalHealth['hookDeliveries']>;
}): OperationalHealth {
  const result: { -readonly [K in keyof OperationalHealth]: OperationalHealth[K] } = {};
  if (input.ingest?.lastTickAt) {
    result.lastTickAt = input.ingest.lastTickAt.toISOString();
  }
  if (input.ingest?.corpusTrouble) {
    result.corpusTrouble = input.ingest.corpusTrouble;
  }
  if (input.backup?.lastBackupAt) {
    result.lastBackupAt = input.backup.lastBackupAt.toISOString();
  }
  if (input.backup?.lastError) {
    result.lastBackupError = input.backup.lastError;
  }
  const dbBytes = fileSize(input.dbPath);
  if (dbBytes !== null) {
    result.dbBytes = dbBytes;
    result.walBytes = fileSize(`${input.dbPath}-wal`) ?? 0;
  }
  result.hookDeliveries = { ...input.hookDeliveries };
  return result;
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * Newest finished backup already in `directory` (by mtime), so /api/health
 * knows the last backup from the moment of boot, not only after the first
 * daily cycle of this process. A missing or unreadable directory is `null`;
 * an in-flight `.partial` is not a backup.
 */
export function newestBackupTime(directory: string): Date | null {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  let newest: Date | null = null;
  for (const name of names) {
    if (!name.startsWith('agenthropic-') || !name.endsWith('.db')) {
      continue;
    }
    try {
      const mtime = statSync(join(directory, name)).mtime;
      if (newest === null || mtime > newest) {
        newest = mtime;
      }
    } catch {
      // Removed between readdir and stat (retention, an operator) - skip it.
    }
  }
  return newest;
}

/**
 * Schedule daily database backups into `directory`
 * (`agenthropic-<timestamp>.db`, the documented naming convention the
 * backup-file prune recognizes), with the retention pass chained after each
 * write (L9 wiring of WP-D10). Each cycle:
 *  1. writes a dated backup into `directory`;
 *  2. if, and only if, that succeeded, runs `retention` at the cycle's `now` -
 *     so every prune, of rows or of backup files, is preceded by a fresh
 *     safety copy, and a cycle whose backup failed deletes nothing at all;
 *  3. logs one line for the backup and one for the retention pass. Deleted
 *     rows are also written to the retention journal beside the database (the
 *     prune does that inside its own delete transaction).
 * A throwing runner is logged and never propagates: the timer keeps ticking,
 * and the next cycle tries again after its own backup.
 *
 * The timer is `unref`-ed: a backup schedule must never be what keeps a
 * process that already closed its server alive. A failed run logs and waits
 * for the next tick - the server outliving its backup beats the reverse.
 */
export function scheduleDailyBackups(
  db: SqliteDatabase,
  directory: string,
  retention: RetentionPort,
  options: {
    readonly intervalMs?: number;
    readonly now?: () => Date;
    readonly backup?: (db: SqliteDatabase, destPath: string) => Promise<void>;
    readonly log?: (line: string) => void;
    readonly logError?: (line: string) => void;
    /** Seed for `state().lastBackupAt`, normally {@link newestBackupTime}. */
    readonly lastBackupAt?: Date | null;
  } = {},
): BackupScheduler {
  const intervalMs = options.intervalMs ?? BACKUP_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const backup = options.backup ?? backupDatabase;
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  let running = false;
  let lastBackupAt = options.lastBackupAt ?? null;
  let lastError: string | null = null;

  function runRetention(at: Date): void {
    try {
      log(retentionRunLine(retention.run({ now: at })));
    } catch (error) {
      logError(`retention failed: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof RetentionRunError) {
        // What the pass had already deleted before it stopped - rows and
        // backup files are gone either way, so the record must not be.
        logError(
          `retention failed part-way; completed before the failure - ${retentionRunLine(error.report)}`,
        );
      }
    }
  }

  async function runOnce(): Promise<void> {
    if (running) {
      // The online backup yields between pages, so a manual `runOnce` COULD
      // overlap a timer-fired one - never two writers into the directory.
      return;
    }
    running = true;
    try {
      const at = now();
      const destPath = join(directory, `agenthropic-${at.toISOString().replace(/[:.]/g, '-')}.db`);
      await backup(db, destPath);
      lastBackupAt = at;
      lastError = null;
      log(`database backup: wrote ${destPath}.`);
      // Reached only after a successful backup - the contract above.
      runRetention(at);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logError(`database backup failed: ${lastError}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref();

  return {
    runOnce,
    stop(): void {
      clearInterval(timer);
    },
    state(): BackupState {
      return { lastBackupAt, lastError };
    },
  };
}

/**
 * Boot-time retention report (L9): one info line saying what the signed policy
 * is and what it WOULD prune right now. A dry run by construction - nothing is
 * deleted at boot; the first real pass is the first daily cycle, after its
 * backup. Never throws: an assessment that fails is logged as an error and the
 * server boots regardless.
 */
export function reportRetentionAtBoot(
  retention: RetentionPort,
  options: {
    readonly now?: () => Date;
    readonly log?: (line: string) => void;
    readonly logError?: (line: string) => void;
  } = {},
): void {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  try {
    const report = retention.run({ now: now(), dryRun: true });
    log(
      `retention policy: ${describeRetentionPolicy(retention.policy)}. ${retentionRunLine(report)}`,
    );
  } catch (error) {
    logError(`retention dry run failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Bring the schema up to this build (R9 / OPS-9). A database written by a
 * newer build is refused before anything touches it. When migrations are
 * pending on an existing database, a verified backup is taken first, named
 * after the version it was taken at, so a migration that goes wrong can be
 * undone with `restoreDatabase`; a backup that fails refuses the migration.
 * A fresh database has nothing to protect and is migrated directly.
 */
export async function prepareSchema(
  db: SqliteDatabase,
  backupsDir: string,
  options: { readonly now?: () => Date; readonly list?: readonly Migration[] } = {},
): Promise<MigrationRunResult> {
  const list = options.list ?? migrations;
  assertSchemaNotNewer(db, list);
  const from = currentSchemaVersion(db);
  if (from > 0 && pendingMigrationIds(db, list).length > 0) {
    const at = (options.now ?? (() => new Date()))();
    await backupDatabase(
      db,
      join(
        backupsDir,
        `agenthropic-${at.toISOString().replace(/[:.]/g, '-')}-pre-migration-v${String(from)}.db`,
      ),
    );
  }
  return runMigrations(db, list);
}

/** Boot the server. Throws when configuration is invalid (e.g. no token). */
export async function start(
  env: Record<string, string | undefined> = process.env,
): Promise<RunningServer> {
  const config = loadConfig(env);
  // Read and validate the alerts file before anything opens: a broken config
  // must stop the boot, never leave the server running without its alerts.
  const alertsConfig =
    config.alertsConfigPath === null ? null : loadAlertsConfig(config.alertsConfigPath);
  const db = openDatabase(config.dbPath);
  const backupsDir = join(dirname(config.dbPath), 'backups');
  try {
    await prepareSchema(db, backupsDir);
  } catch (error) {
    db.close();
    throw error;
  }

  // The signed retention policy (D3) over the backup directory next to the
  // database it protects. Validated here, at wiring time; reported at boot as
  // a dry run; run for real only by the daily timer, after that cycle's backup.
  // R4 / SEC-2: an install from before private modes is tightened here, and a
  // data file that cannot be made private stops the boot.
  secureDataFiles(
    { dbPath: config.dbPath, backupsDir, journalPath: defaultJournalPath(config.dbPath) },
    console.error,
  );
  const retention = createRetentionRunner(db, signedRetentionPolicy(config.retention, backupsDir));
  reportRetentionAtBoot(retention);

  // ONE hub shared by the ingest loop and the SSE route: watcher events are
  // bridged onto the shared RealtimeEvent DTOs and fan out to every stream
  // subscriber. The replay tick now runs after listen (M-16), so an early SSE
  // subscriber legitimately sees the replay's events live - a feature, not a
  // leak: the same session-ingested DTOs the poll loop would publish anyway.
  const hub = new RealtimeHub();

  let watcher: CorpusWatcher | null = null;
  // The bound app, visible to the watcher's onFatal below. It exists only
  // after buildServer, but with the replay running post-listen (M-16) every
  // fatal tick now happens while a socket is bound - the cleanup must release
  // it for in-process harnesses that stub process.exit (production exits).
  let appRef: FastifyInstance | null = null;
  // /api/health's boot phase (M-16): 'replaying' from bind until the startup
  // replay is over, then 'idle' for the life of the process - it turns exactly
  // once. A replay that a read error cut short is not over: the scheduled poll
  // finishes it (see onTickOutcome below). Not wired at all when ingest is off.
  let ingestPhase: 'replaying' | 'idle' = config.ingestEnabled ? 'replaying' : 'idle';
  // Trouble state for the scheduled poll loop, seeded from the replay tick
  // below so a boot that already announced its trouble is not announced twice.
  let tickTrouble: TickTroubleKind | null = null;
  // Created even when ingest is off: RunningServer.skipCounters() is part of
  // the server's shape either way and answers {} there. /api/health, which
  // speaks to operators, omits the field on such a boot (see buildServer).
  const skipReporter = createSkipReporter();
  // Duration of the last completed watcher pass (M-15); null until one ran
  // (or forever, on an ingest-less boot) — /api/health omits it rather than
  // faking a zero.
  let lastTickDurationMs: number | null = null;
  // M-18: messages the M-12 ownership rule skipped since boot. Counted here
  // rather than in the writer so /api/health can report the running total; an
  // ingest-less boot omits the field, since nothing was there to collide.
  let crossSessionUsageCollisions = 0;
  // R11: when the last corpus pass finished; null until one did.
  let lastTickAt: Date | null = null;
  // R11: hook delivery outcomes since boot, for /api/health.
  const hookDeliveries = { stored: 0, duplicate: 0, unauthorized: 0, rejected: 0, failed: 0 };
  // M-15/M-18: ONE tail-caching read port, shared by the ingest watcher and the
  // cost-analysis substrate provider below. The byte-offset cache is per
  // DECORATOR INSTANCE, so a provider with its own instance re-read every
  // transcript in full (up to the per-file cap, synchronously, on the request thread) on
  // every click; sharing the watcher's instance means a cost-analysis lookup
  // reads only the bytes appended since the last poll pass.
  //
  // Sharing is safe — each claim is checked against corpus/tail-cache.ts:
  //  - No interleaving: Node is single-threaded and both `readJsonl` and the
  //    watcher pass are fully synchronous (no `await` inside), so no caller can
  //    observe a half-updated entry.
  //  - No time-based staleness: an entry is never trusted on age. EVERY read
  //    re-reads the overlap window and falls back to a full read when the file
  //    shrank or the overlap bytes differ, so a shared entry is verified against
  //    the file for the second caller exactly as for the first.
  //  - No containment or cap weakening: the cache stores bytes, not decisions.
  //    `nodeCorpusFs.readFileTailConfined` re-opens with `O_NOFOLLOW` and
  //    re-applies the CALLER'S OWN `maxBytes` via fstat on every call, cache hit
  //    included — so a shared entry can never serve one caller a file that
  //    exceeds another caller's `OversizeError` limit. (Both callers here
  //    pass the same `readLimits` - the configured cap - anyway.)
  //  - Shared budget costs speed only: the 128 MiB / 512-entry LRU caps are now
  //    shared, so the two paths can evict each other's entries. An evicted entry
  //    is a full read — the same read the bare adapter always did.
  //  - Errors are not shared state: any throw drops the entry and propagates
  //    untouched, so one path's EACCES leaves nothing behind for the other.
  // Built unconditionally (not inside the ingest branch): with ingest off the
  // provider is the sole user and still gets the repeat-click benefit.
  const corpusFs = createTailCachingFs(nodeCorpusFs());
  // R14 / DAT-3: the per-file cap is configuration (`DASHBOARD_MAX_FILE_MIB`),
  // and the watcher and the cost-analysis provider must agree on it, or one
  // path would read a session the other reports as partial.
  const readLimits = { maxFileBytes: config.maxFileBytes };
  if (config.ingestEnabled) {
    watcher = createCorpusWatcher({
      db,
      // M-15: incremental transcript reads — a poll pass costs O(new bytes),
      // not O(corpus bytes). The decorator only ever falls back to the same
      // full read the bare adapter would have done.
      fs: corpusFs,
      limits: readLimits,
      // A RESOLVER, not a snapshot: the watcher re-reads the pricing table
      // every pass, so seeding a missing model row unblocks parked sessions
      // without a restart (review M-2).
      pricing: () => loadPricing(db),
      // Minimal env hygiene: the watcher sees ONLY the two variables it
      // resolves, with config as the single source of truth for the root.
      env: {
        CLAUDE_PROJECTS_DIR: config.corpusRoot ?? undefined,
        DASHBOARD_INSTANCE: env['DASHBOARD_INSTANCE'],
      },
      intervalMs: config.pollIntervalMs,
      watchdogThresholdMs: config.watchdogMinutes * 60_000,
      // WP-IN10 replay checkpoint: the boot re-reads only what changed while
      // the process was down. Correctness does not depend on it — the store
      // hands back a fingerprint only for a session whose row is still present,
      // and degrades to an empty map (a full replay) on any doubt.
      checkpoints: createReplayCheckpointStore(db),
      // Reachable from a REAL corpus, so it is covered end-to-end rather than
      // ignored: `isSafeEntryName` rejects any directory-entry name carrying a
      // path separator, and `foo\bar` is a perfectly legal file name on
      // macOS/Linux. One such project directory therefore raises a
      // ContainmentError out of the very first enumeration - see
      // test/start-corpus-fatal.test.ts, which drives this arm through start().
      onFatal: (error) => {
        exitOnCorpusFatal(error, () => {
          // Fire-and-forget: process.exit tears the socket down in production;
          // this releases the handle when exit is stubbed (tests).
          void appRef?.close();
          db.close();
        });
      },
      onIngestEvent: (event) => {
        hub.publish(toRealtimeEvent(event, new Date().toISOString()));
      },
      onIngestFailure: (report) => {
        reportIngestFailure(report, hub, new Date().toISOString());
      },
      // Skip visibility (review H-2): without this seam an oversize/EACCES/
      // empty transcript was counted into `filesSkipped` and then discarded,
      // so its frozen dollar totals had no operator-visible trace anywhere.
      onWarning: (skipped) => {
        skipReporter.onSkip(skipped);
      },
      onUsageCollisions: (collisions) => {
        crossSessionUsageCollisions += collisions;
      },
      onTickOutcome: (outcome) => {
        if (outcome.kind === 'ingested') {
          skipReporter.onTickSkips(outcome.summary.filesSkipped);
        }
        const { next, line } = tickTroubleTransition(tickTrouble, outcome);
        tickTrouble = next;
        if (line !== null) {
          (line.level === 'error' ? console.error : console.log)(line.text);
        }
        // Only a replay that a read error cut short is still 'replaying' when
        // the poll starts. A pass that leaves sessions pending keeps it so;
        // anything else ends it - the sweep drained, or the corpus is still
        // unreadable and nothing is about to drain. The second matters: the
        // token screen waits on this phase with no timeout. The ending is
        // said in the log (2026-10-08): which poll ended it, and on what.
        if (ingestPhase === 'replaying') {
          const end = replayPhaseEndLine(outcome);
          if (end !== null) {
            ingestPhase = 'idle';
            (end.level === 'error' ? console.error : console.log)(end.text);
          }
        }
      },
      onTickDuration: (durationMs) => {
        lastTickDurationMs = durationMs;
        lastTickAt = new Date();
      },
    });
  }

  // Captured into a const so the seam below can be narrowed: `watcher` is a
  // `let` assigned inside the ingest-enabled branch, and TypeScript's narrowing
  // of a mutable binding does not survive into a closure.
  const ingestWatcher = watcher;

  const app = buildServer({
    token: config.token,
    // R11 / OPS-6: DASHBOARD_LOG_LEVEL, 'warn' by default.
    logger: config.logLevel,
    schemaVersion: currentSchemaVersion(db),
    db,
    hub,
    // The four ingest seams below are wired only when the watcher exists, like
    // ingestExclusions: with ingest off, an 'idle' phase or a zero count would
    // describe a pass that never ran, so /api/health omits the fields instead.
    //
    // The same counters RunningServer.skipCounters() exposes, surfaced on
    // /api/health so frozen-dollar skips are visible from the dashboard side.
    skipCounters: ingestWatcher === null ? undefined : () => skipReporter.counters(),
    // M-16: lets a probe distinguish "still replaying the corpus" from "idle
    // and current" - the replay below runs after the bind.
    ingestPhase: ingestWatcher === null ? undefined : () => ingestPhase,
    // M-15: how long the last corpus pass took, so a poll outgrowing its
    // interval is visible from the dashboard side before it hurts.
    tickDurationMs: ingestWatcher === null ? undefined : () => lastTickDurationMs,
    // M-18: spend that a resume/fork replay deliberately did not re-count.
    usageCollisions: ingestWatcher === null ? undefined : () => crossSessionUsageCollisions,
    // How much of the corpus the dollar figures are NOT computed from. A
    // session ingest cannot finish contributes no rows at all, so every total
    // silently omits its spend - and omits it in the flattering direction,
    // since a total missing sessions is always too small. Wired only when the
    // watcher exists: with ingest off there is nothing to exclude, and the
    // fields stay absent rather than reporting a zero nobody measured.
    ingestExclusions: ingestWatcher === null ? undefined : () => ingestWatcher.exclusions(),
    // 409 instead of 404 for a session the corpus holds but ingest rejected
    // (owner decision, 2026-10-01) - read off the watcher's own retry budget,
    // the same source `ingestExclusions` counts.
    ingestRejection:
      ingestWatcher === null ? undefined : (sessionId) => ingestWatcher.rejectionOf(sessionId),
    // One command, one port: the built SPA is served from this same loopback
    // origin, which is also what keeps the /api/stream same-origin check a real
    // defence instead of a permanent CORS exception. A missing build directory
    // is NOT a boot failure - the API serves normally and '/' explains how to
    // build the UI.
    webRoot: config.webRoot,
    // C-2: exact extra origins for a tunnel front end; empty = loopback only.
    allowedOrigins: config.allowedOrigins,
    // WP-C4/C5: compaction repricing and delegation savings need the raw
    // substrate (boundaries are not persisted), so the cost-analysis route gets
    // a read-only corpus seam. Same env hygiene as the watcher - config is the
    // single source of truth for the root.
    substrateProvider: createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: config.corpusRoot ?? undefined },
      // M-18 residue: the WATCHER'S tail-caching port, not a fresh one. The
      // slug hint below removed the O(corpus) enumeration per request; this
      // removes the O(file bytes) synchronous re-read that remained. See the
      // sharing-safety argument at `corpusFs`.
      fs: corpusFs,
      limits: readLimits,
      // Persisted-slug hint (review M-18): lets the provider try the session's
      // recorded project directory first instead of scanning every slug.
      slugOf: (id) => getSessionProjectSlug(db, id),
    }),
    // R11 / OPS-5: "is it working", not just "is it up". The tick fields are
    // omitted with ingest off, like the ingest seams above.
    operationalHealth: () =>
      operationalHealth({
        dbPath: config.dbPath,
        ingest: ingestWatcher === null ? null : { lastTickAt, corpusTrouble: tickTrouble },
        // `backups` is declared below, next to the hook routes; this closure
        // only runs on a request, and requests start after listen, which is
        // after the scheduler exists.
        backup: backups.state(),
        hookDeliveries,
      }),
  });
  appRef = app;
  // WP-IN3 hook receiver, registered before listen so the global /api/* auth
  // gate inside buildServer covers it. `applyStatus` is the WP-IN12 liveness
  // seam: hooks are the ONLY observer of an ending, and applyHookLiveness is
  // UPDATE-only (CD-1 - liveness, never structure).
  await registerHookRoutes(app, {
    eventStore: new SqliteEventStore(db),
    applyStatus: (hookName, payload) => {
      for (const event of applyHookLiveness(db, hookName, payload)) {
        hub.publish(toRealtimeEvent(event, new Date().toISOString()));
      }
    },
    onDelivery: (outcome) => {
      hookDeliveries[outcome] += 1;
    },
  });
  // Daily backups of the one non-re-derivable table's home (review M-20) -
  // scheduled regardless of ingest, next to the database it protects - with
  // the retention pass chained after each successful backup (L9).
  const backups = scheduleDailyBackups(db, backupsDir, retention, {
    lastBackupAt: newestBackupTime(backupsDir),
  });
  // v2.0 alerting (AD-1): built only when the operator named a config file.
  // Started inside the try below so a tokenRef that does not resolve fails the
  // boot through the same close path as a failed bind.
  let alerting: AlertingService | null = null;
  const close = async (): Promise<void> => {
    // Awaited: an in-flight delivery must be recorded before db.close().
    await alerting?.stop();
    backups.stop();
    watcher?.stop();
    await app.close();
    db.close();
  };
  try {
    if (alertsConfig !== null) {
      alerting = startAlerting({
        db,
        config: alertsConfig,
        intervalMs: config.pollIntervalMs,
        // Node's console methods are bound to the console instance.
        log: console.log,
        logError: console.error,
      });
    }
    await app.listen({ host: HOST, port: config.port });
    await enforceLoopbackOrExit(app.addresses(), close);
  } catch (error) {
    await close();
    throw error;
  }
  if (watcher !== null) {
    // Chunked replay (see runStartupReplay): the server answers - health says
    // 'replaying', data endpoints serve what has landed so far - between
    // passes, and the phase turns 'idle' only once the whole sweep is done.
    const replay = await runStartupReplay(watcher, {
      maxSessionsPerPass: REPLAY_MAX_SESSIONS_PER_PASS,
    });
    if (replay.kind === 'read-error' || replay.kind === 'no-corpus-root') {
      tickTrouble = replay.kind;
    }
    // A read error ended the loop, not the replay: the sessions it did not
    // reach are still owed and the watcher still holds the cap, so the poll
    // finishes the sweep in capped passes and ends the phase (onTickOutcome).
    // Every other ending - drained, nothing to read, no root - is final.
    // (With ingest off there is no watcher and the phase was 'idle' all along.)
    if (replay.kind !== 'read-error') {
      ingestPhase = 'idle';
    }
  }
  watcher?.start(); // tail-follow begins only after a healthy bind AND the replay
  return { app, db, skipCounters: () => skipReporter.counters(), close };
}

/**
 * True when this module is the process entry point (`node src/index.ts`,
 * `tsx src/index.ts`), false when it was imported as a library.
 *
 * Both inputs are parameters rather than reads of `process.argv` /
 * `import.meta.url`, so the decision is testable code instead of an
 * untestable module-level expression hidden behind an ignore pragma.
 */
export function isMainModule(entryPath: string | undefined, moduleUrl: string): boolean {
  return entryPath !== undefined && moduleUrl === pathToFileURL(entryPath).href;
}

/**
 * The CLI bootstrap: boot, announce the bound loopback address, and turn any
 * boot failure into a non-zero exit.
 *
 * Only `error.message` is printed, never the error object: a stack trace from
 * config loading or from better-sqlite3 can carry a filesystem path, and the
 * one thing that must never reach a terminal log is anything token-shaped.
 * `boot` is injectable so the announcement and the fail-closed exit can both be
 * driven without a process of their own.
 */
export async function runCli(
  boot: () => Promise<RunningServer> = start,
  proc: ShutdownProcess = process,
): Promise<void> {
  try {
    const { app, close } = await boot();
    const bound = app.addresses().map(describeBoundAddress).join(', ');
    console.log(`agenthropic server listening on ${bound}`);
    installShutdown(close, proc);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/** The slice of `process` that graceful shutdown needs, injectable for tests. */
export interface ShutdownProcess {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
}

/** How long a signalled shutdown may take before the process gives up and exits 1. */
export const SHUTDOWN_GRACE_MS = 10_000;

/**
 * R8 / OPS-2: SIGTERM (launchd `bootout`, `kill`) and SIGINT (Ctrl-C) run the
 * same `close()` a failed boot runs - alerting deliveries are recorded, the
 * backup timer and watcher stop, SSE streams end, and the database closes -
 * before the process exits 0. A clean exit 0 is also what tells launchd's
 * `KeepAlive { SuccessfulExit: false }` not to restart a deliberate stop.
 *
 * A second signal while closing, a close that throws, or a close that outlives
 * the grace period exits 1 at once. Before `boot()` resolves no handler is
 * installed, so a signal during startup replay keeps the default (immediate)
 * exit; SQLite in WAL mode rolls back the open transaction on the next boot.
 */
export function installShutdown(
  close: () => Promise<void>,
  proc: ShutdownProcess,
  graceMs: number = SHUTDOWN_GRACE_MS,
): void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      console.error(`agenthropic server: second ${signal}, exiting without waiting`);
      proc.exit(1);
      return;
    }
    stopping = true;
    console.log(`agenthropic server: ${signal} received, shutting down`);
    const timer = setTimeout(() => {
      console.error(`agenthropic server: shutdown took longer than ${graceMs} ms, exiting`);
      proc.exit(1);
    }, graceMs);
    timer.unref();
    close().then(
      () => {
        clearTimeout(timer);
        proc.exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        console.error(error instanceof Error ? error.message : error);
        proc.exit(1);
      },
    );
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    proc.on(signal, () => {
      onSignal(signal);
    });
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  void runCli();
}
