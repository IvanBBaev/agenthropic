/**
 * @agenthropic/server - composition root (WP-U0 + WP-IN10 live loop).
 *
 * loadConfig (mandatory DASHBOARD_TOKEN) -> openDatabase (WAL asserted) ->
 * runMigrations -> listen on the constant loopback host -> verify every bound
 * address is loopback or shut down hard -> corpus replay (the watcher's first
 * tick, when ingest is enabled) -> start the poll loop. The replay runs AFTER
 * the bind (review M-16): on a large corpus it takes seconds, and a probe that
 * hits the port during it should see 'replaying' on /api/health rather than
 * connection refused.
 */
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
import { loadPricing } from './db/pricing';
import { openDatabase, type SqliteDatabase } from './db/connection';
import { SqliteEventStore } from './db/event-store';
import { currentSchemaVersion, runMigrations } from './db/migrations';
import { createReplayCheckpointStore } from './db/replay-checkpoints';
import { applyHookLiveness } from './hooks/liveness-status';
import { registerHookRoutes } from './hooks/routes';
import {
  createCorpusWatcher,
  MAX_INGEST_ATTEMPTS,
  type CorpusWatcher,
  type IngestFailureReport,
  type TickOutcome,
} from './ingest/corpus-watcher';
import { toIngestFailureEvent, toRealtimeEvent } from './realtime/bridge';
import { RealtimeHub } from './realtime/hub';
import { pruneBackupFiles } from './retention/backup-files';
import { buildServer } from './server';

export {
  HOST,
  loadConfig,
  DEFAULT_PORT,
  DEFAULT_DB_PATH,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WATCHDOG_MINUTES,
} from './config';
export type { ServerConfig } from './config';
export { openDatabase, assertConnectionPragmas } from './db/connection';
export type { SqliteDatabase } from './db/connection';
export { migrations, runMigrations, currentSchemaVersion } from './db/migrations';
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
 * Post-listen defence in depth: if ANY bound address is not loopback, log
 * (without secrets) and terminate the process. Exported for direct testing.
 */
export async function enforceLoopbackOrExit(
  addresses: ReadonlyArray<{ address: string }>,
  cleanup: () => Promise<void>,
): Promise<void> {
  const offenders = addresses.filter((entry) => !isLoopbackAddress(entry.address));
  if (offenders.length === 0) {
    return;
  }
  console.error(
    `FATAL: server bound non-loopback address(es): ${offenders
      .map((entry) => entry.address)
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
  for (const failure of replay.failures) {
    console.error(
      `corpus replay failure: session ${failure.sessionId} (${failure.projectSlug}): ${failure.error}`,
    );
  }
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
 * this session will NOT be retried until its bytes change.
 *
 * `report.reason` arrives already sanitized by the watcher - no absolute path,
 * no transcript content, no hook payload, length-capped.
 */
export function reportIngestFailure(
  report: IngestFailureReport,
  hub: RealtimeHub,
  occurredAt: string,
): void {
  const verdict = report.willRetry ? 'will retry' : 'quarantined until the session changes';
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
  /** Cumulative counts by reason since boot. */
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
            `this session's records are NOT in the dashboard totals.`,
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
 * Backup cadence and expiry window (review M-20: `events_raw` is the one
 * non-re-derivable table, and a backup capability nothing runs is not a
 * backup). PROVISIONAL numbers pending the OPEN-1 retention ratification; the
 * `keepMinimum` floor is the safety mechanism either way - however wrong the
 * window, the newest {@link BACKUP_KEEP_MINIMUM} backups always survive.
 */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BACKUP_MAX_AGE_DAYS = 14;
export const BACKUP_KEEP_MINIMUM = 7;

export interface BackupScheduler {
  /** One backup + expiry pass - exactly what the daily timer fires. */
  runOnce(): Promise<void>;
  /** Clear the daily timer. Idempotent; wired into server close. */
  stop(): void;
}

/**
 * Schedule daily database backups into `directory`
 * (`agenthropic-<timestamp>.db`, the documented naming convention that
 * {@link pruneBackupFiles} recognizes), expiring old ones with the
 * keep-minimum-floored retention pass right after each write.
 *
 * The timer is `unref`-ed: a backup schedule must never be what keeps a
 * process that already closed its server alive. A failed run logs and waits
 * for the next tick - the server outliving its backup beats the reverse.
 */
export function scheduleDailyBackups(
  db: SqliteDatabase,
  directory: string,
  options: {
    readonly intervalMs?: number;
    readonly maxAgeDays?: number;
    readonly keepMinimum?: number;
    readonly now?: () => Date;
    readonly backup?: (db: SqliteDatabase, destPath: string) => Promise<void>;
    readonly log?: (line: string) => void;
    readonly logError?: (line: string) => void;
  } = {},
): BackupScheduler {
  const intervalMs = options.intervalMs ?? BACKUP_INTERVAL_MS;
  const maxAgeDays = options.maxAgeDays ?? BACKUP_MAX_AGE_DAYS;
  const keepMinimum = options.keepMinimum ?? BACKUP_KEEP_MINIMUM;
  const now = options.now ?? (() => new Date());
  const backup = options.backup ?? backupDatabase;
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  let running = false;

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
      const report = pruneBackupFiles({ directory, maxAgeDays, keepMinimum }, { now: at });
      log(
        `database backup: wrote ${destPath}, ` +
          `expired ${String(report.deleted.length)} old backup(s).`,
      );
    } catch (error) {
      logError(`database backup failed: ${error instanceof Error ? error.message : String(error)}`);
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
  };
}

/** Boot the server. Throws when configuration is invalid (e.g. no token). */
export async function start(
  env: Record<string, string | undefined> = process.env,
): Promise<RunningServer> {
  const config = loadConfig(env);
  const db = openDatabase(config.dbPath);
  runMigrations(db);

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
  // replay tick finishes, then 'idle' for the life of the process.
  let ingestPhase: 'replaying' | 'idle' = config.ingestEnabled ? 'replaying' : 'idle';
  // Trouble state for the scheduled poll loop, seeded from the replay tick
  // below so a boot that already announced its trouble is not announced twice.
  let tickTrouble: TickTroubleKind | null = null;
  // Created even when ingest is off: skipCounters() is part of the server's
  // shape either way, and an ingest-less boot honestly reports zero skips.
  const skipReporter = createSkipReporter();
  // Duration of the last completed watcher pass (M-15); null until one ran
  // (or forever, on an ingest-less boot) — /api/health omits it rather than
  // faking a zero.
  let lastTickDurationMs: number | null = null;
  // M-18: messages the M-12 ownership rule skipped since boot. Counted here
  // rather than in the writer so /api/health can report the running total; an
  // ingest-less boot honestly reports zero, exactly as skipCounters does.
  let crossSessionUsageCollisions = 0;
  if (config.ingestEnabled) {
    watcher = createCorpusWatcher({
      db,
      // M-15: incremental transcript reads — a poll pass costs O(new bytes),
      // not O(corpus bytes). The decorator only ever falls back to the same
      // full read the bare adapter would have done.
      fs: createTailCachingFs(nodeCorpusFs()),
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
      },
      onTickDuration: (durationMs) => {
        lastTickDurationMs = durationMs;
      },
    });
  }

  const app = buildServer({
    token: config.token,
    schemaVersion: currentSchemaVersion(db),
    db,
    hub,
    // The same counters RunningServer.skipCounters() exposes, surfaced on
    // /api/health so frozen-dollar skips are visible from the dashboard side.
    skipCounters: () => skipReporter.counters(),
    // M-16: lets a probe distinguish "still replaying the corpus" from "idle
    // and current" - the replay below runs after the bind.
    ingestPhase: () => ingestPhase,
    // M-15: how long the last corpus pass took, so a poll outgrowing its
    // interval is visible from the dashboard side before it hurts.
    tickDurationMs: () => lastTickDurationMs,
    // M-18: spend that a resume/fork replay deliberately did not re-count.
    usageCollisions: () => crossSessionUsageCollisions,
    // WP-C4/C5: compaction repricing and delegation savings need the raw
    // substrate (boundaries are not persisted), so the cost-analysis route gets
    // a read-only corpus seam. Same env hygiene as the watcher - config is the
    // single source of truth for the root.
    substrateProvider: createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: config.corpusRoot ?? undefined },
      // Persisted-slug hint (review M-13): lets the provider try the session's
      // recorded project directory first instead of scanning every slug.
      slugOf: (id) => getSessionProjectSlug(db, id),
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
  });
  // Daily backups of the one non-re-derivable table's home (review M-20) -
  // scheduled regardless of ingest, next to the database it protects.
  const backups = scheduleDailyBackups(db, join(dirname(config.dbPath), 'backups'));
  const close = async (): Promise<void> => {
    backups.stop();
    watcher?.stop();
    await app.close();
    db.close();
  };
  try {
    await app.listen({ host: HOST, port: config.port });
    await enforceLoopbackOrExit(app.addresses(), close);
  } catch (error) {
    await close();
    throw error;
  }
  if (watcher !== null) {
    // One macrotask turn so connections accepted during the bind are answered
    // ('replaying') before the synchronous replay blocks the event loop —
    // without it the phase would be true but never observable in-process.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    // WP-IN10 replay-on-startup: the first tick IS the replay. Without a
    // persisted checkpoint the fingerprint map starts empty, so every
    // discovered session is admitted; with one (wired at watcher creation)
    // only the sessions whose bytes moved while the process was down are
    // re-read. Either way the pass is idempotent, and a poisoned session is
    // isolated inside the runner and only surfaces in the summary below.
    //
    // A pass that ingested nothing is no longer silent: `tick()` names WHICH
    // of the reasons ended it, so the boot says so instead of guessing — see
    // replayOutcomeLine.
    const replay = watcher.tick();
    if (replay.kind === 'ingested') {
      logReplaySummary(replay.summary);
    } else {
      const line = replayOutcomeLine(replay);
      (line.level === 'error' ? console.error : console.log)(line.text);
    }
    if (replay.kind === 'read-error' || replay.kind === 'no-corpus-root') {
      tickTrouble = replay.kind;
    }
  }
  ingestPhase = 'idle';
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
export async function runCli(boot: () => Promise<RunningServer> = start): Promise<void> {
  try {
    const { app } = await boot();
    const bound = app
      .addresses()
      .map((entry) => `${entry.address}:${entry.port}`)
      .join(', ');
    console.log(`agenthropic server listening on ${bound}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  void runCli();
}
