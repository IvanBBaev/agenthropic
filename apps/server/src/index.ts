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
 *
 * ARC-4 (2026-11-19): the ops policy this root wires - startup replay, the
 * tick-trouble state machine, failure and skip reporting, daily backups, health
 * fields, the boot retention report - lives in `ops/`; this file keeps the
 * wiring in `start()` and re-exports those modules' public names.
 */
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { getSessionProjectSlug } from './api/queries';
import { createSubstrateProvider } from './api/substrate-provider';
import { HOST, loadConfig } from './config';
import type { SkipReason } from './corpus/fs-port';
import { reportTranscriptRetentionAtBoot } from './corpus/transcript-retention';
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
import { readFormatDrift } from './db/format-drift';
import { createReplayCheckpointStore } from './db/replay-checkpoints';
import { applyHookLiveness } from './hooks/liveness-status';
import { registerHookRoutes } from './hooks/routes';
import {
  createCorpusWatcher,
  REPLAY_MAX_BYTES_PER_PASS,
  REPLAY_MAX_SESSIONS_PER_PASS,
  type CorpusWatcher,
} from './ingest/corpus-watcher';
import { toRealtimeEvent } from './realtime/bridge';
import { RealtimeHub } from './realtime/hub';
import { defaultJournalPath } from './retention/journal';
import { signedRetentionPolicy } from './retention/policy';
import { createRetentionRunner } from './retention/runner';
import { selfMetrics, startLoopLagMonitor } from './self-metrics';
import { buildServer } from './server';
import { replayPhaseEndLine, runStartupReplay } from './ops/startup-replay';
import { type TickTroubleKind, tickTroubleTransition } from './ops/tick-trouble';
import { reportIngestFailure } from './ops/ingest-failure';
import { createSkipReporter } from './ops/skip-reporter';
import { newestBackupTime, scheduleDailyBackups } from './ops/backups';
import { operationalHealth } from './ops/health';
import { reportRetentionAtBoot } from './ops/retention-report';

export {
  mergeReplaySummaries,
  REPLAY_YIELD_MS,
  replayOutcomeLine,
  replayPhaseEndLine,
  runStartupReplay,
  type StartupReplayOptions,
} from './ops/startup-replay';
export { type TickTroubleKind, tickTroubleTransition } from './ops/tick-trouble';
export { reportIngestFailure } from './ops/ingest-failure';
export { createSkipReporter, SKIP_RELOG_INTERVAL_MS, type SkipReporter } from './ops/skip-reporter';
export {
  BACKUP_INTERVAL_MS,
  type BackupMirrorState,
  type BackupScheduler,
  type BackupState,
  checkpointWal,
  newestBackupTime,
  scheduleDailyBackups,
  type WalCheckpointResult,
} from './ops/backups';
export { operationalHealth } from './ops/health';
export { reportRetentionAtBoot } from './ops/retention-report';

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
export {
  CLOCK_JUMP_TOLERANCE_MS,
  decideWatchdogVerdict,
  detectClockJump,
  isTerminalAgentStatus,
  runWatchdogSweep,
  type ClockReading,
} from './ingest/watchdog';
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
  // R12: Claude Code's own transcript cleanup bounds how far back the corpus
  // can rebuild these tables; say at boot which side of that line we are on.
  reportTranscriptRetentionAtBoot({ env });

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
      // OPS-21: the monotonic reference that tells a sleep/NTP jump of the
      // wall clock apart from real silence.
      monoMs: () => performance.now(),
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
    // OPS-16: how far the adaptive back-off is stretching the poll right now.
    pollBackoffIntervals:
      ingestWatcher === null ? undefined : () => ingestWatcher.pollBackoffIntervals(),
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
    // OPS-20: the process's own memory and event-loop lag. `loopLag` is
    // declared below, next to the backups, for the same reason as `backups`.
    selfMetrics: () => selfMetrics({ loopLag }),
    // R13: format-drift census over the stored sessions. Wired with ingest off
    // too: it reads stored rows, so zeros are a real answer, not a fake one.
    formatDrift: () => readFormatDrift(db),
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
    mirrorDirectory: config.backupMirrorDir,
    lastMirrorAt: config.backupMirrorDir === null ? null : newestBackupTime(config.backupMirrorDir),
  });
  // OPS-20: event-loop lag for /api/health, sampled for the life of the server.
  const loopLag = startLoopLagMonitor();
  // v2.0 alerting (AD-1): built only when the operator named a config file.
  // Started inside the try below so a tokenRef that does not resolve fails the
  // boot through the same close path as a failed bind.
  let alerting: AlertingService | null = null;
  const close = async (): Promise<void> => {
    // Awaited: an in-flight delivery must be recorded before db.close().
    await alerting?.stop();
    backups.stop();
    loopLag.stop();
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
      maxBytesPerPass: REPLAY_MAX_BYTES_PER_PASS,
    });
    if (
      replay.kind === 'read-error' ||
      replay.kind === 'no-corpus-root' ||
      replay.kind === 'db-unavailable'
    ) {
      tickTrouble = replay.kind;
    }
    // A read error ended the loop, not the replay: the sessions it did not
    // reach are still owed and the watcher still holds the cap, so the poll
    // finishes the sweep in capped passes and ends the phase (onTickOutcome).
    // Every other ending - drained, nothing to read, no root - is final.
    // (With ingest off there is no watcher and the phase was 'idle' all along.)
    // A database fault (OPS-13) ends the loop the same way and owes the same.
    if (replay.kind !== 'read-error' && replay.kind !== 'db-unavailable') {
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
