/**
 * @agenthropic/server - composition root (WP-U0 + WP-IN10 live loop).
 *
 * loadConfig (mandatory DASHBOARD_TOKEN) -> openDatabase (WAL asserted) ->
 * runMigrations -> corpus replay (the watcher's first tick, when ingest is
 * enabled) -> listen on the constant loopback host -> verify every bound
 * address is loopback or shut down hard -> start the poll loop.
 */
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createSubstrateProvider } from './api/substrate-provider';
import { HOST, loadConfig } from './config';
import type { CorpusIngestSummary } from './corpus/ingest-corpus';
import { loadPricing } from './db/pricing';
import { openDatabase, type SqliteDatabase } from './db/connection';
import { SqliteEventStore } from './db/event-store';
import { currentSchemaVersion, runMigrations } from './db/migrations';
import { registerHookRoutes } from './hooks/routes';
import { createCorpusWatcher, type CorpusWatcher } from './ingest/corpus-watcher';
import { toRealtimeEvent } from './realtime/bridge';
import { RealtimeHub } from './realtime/hub';
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
export { upsertSession } from './db/sessions';
export type { SessionUpsert } from './db/sessions';
export { upsertAgent, listWatchdogCandidates, setAgentStatus } from './db/agents';
export type { AgentUpsert, WatchdogCandidate } from './db/agents';
export { insertTokenUsageRows } from './db/token-usage';
export type { TokenUsageInsertResult } from './db/token-usage';
export { ingestSession } from './ingest/ingest-session';
export type { IngestDeps, IngestOutcome } from './ingest/ingest-session';
export { createCorpusWatcher } from './ingest/corpus-watcher';
export type { CorpusWatcher, CorpusWatcherDeps } from './ingest/corpus-watcher';
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
export { toRealtimeEvent } from './realtime/bridge';
export { registerHookRoutes, HOOK_EVENT_PATH } from './hooks/routes';
export type { HookRoutesOptions } from './hooks/routes';
export { createSubstrateProvider } from './api/substrate-provider';
export type {
  SubstrateProvider,
  SubstrateProviderDeps,
  ResolvedSessionSubstrate,
} from './api/substrate-provider';

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly db: SqliteDatabase;
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
      `${String(replay.usageRowsInserted)} usage rows`,
  );
  for (const failure of replay.failures) {
    console.error(
      `corpus replay failure: session ${failure.sessionId} (${failure.projectSlug}): ${failure.error}`,
    );
  }
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
  // subscriber. Created before the watcher so the replay tick publishes too
  // (harmlessly - nobody is subscribed until after listen).
  const hub = new RealtimeHub();

  let watcher: CorpusWatcher | null = null;
  if (config.ingestEnabled) {
    watcher = createCorpusWatcher({
      db,
      pricing: loadPricing(db),
      // Minimal env hygiene: the watcher sees ONLY the two variables it
      // resolves, with config as the single source of truth for the root.
      env: {
        CLAUDE_PROJECTS_DIR: config.corpusRoot ?? undefined,
        DASHBOARD_INSTANCE: env['DASHBOARD_INSTANCE'],
      },
      intervalMs: config.pollIntervalMs,
      watchdogThresholdMs: config.watchdogMinutes * 60_000,
      // Unreachable via a real filesystem (enumeration only ever joins names
      // it has vetted), hence untestable through start(); exitOnCorpusFatal
      // itself is unit-tested directly.
      /* v8 ignore next */
      onFatal: (error) => {
        exitOnCorpusFatal(error, () => {
          db.close();
        });
      },
      onIngestEvent: (event) => {
        hub.publish(toRealtimeEvent(event, new Date().toISOString()));
      },
    });
    // WP-IN10 replay-on-startup: the first tick IS the replay — the
    // fingerprint map starts empty, so every discovered session is admitted,
    // and the pass is idempotent over an unchanged corpus. A poisoned session
    // is isolated inside the runner and only surfaces in the summary below.
    const replay = watcher.tick();
    if (replay !== null) {
      logReplaySummary(replay);
    }
  }

  const app = buildServer({
    token: config.token,
    schemaVersion: currentSchemaVersion(db),
    db,
    hub,
    // WP-C4/C5: compaction repricing and delegation savings need the raw
    // substrate (boundaries are not persisted), so the cost-analysis route gets
    // a read-only corpus seam. Same env hygiene as the watcher - config is the
    // single source of truth for the root.
    substrateProvider: createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: config.corpusRoot ?? undefined },
    }),
  });
  // WP-IN3 hook receiver, registered before listen so the global /api/* auth
  // gate inside buildServer covers it.
  await registerHookRoutes(app, { eventStore: new SqliteEventStore(db) });
  const close = async (): Promise<void> => {
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
  watcher?.start(); // tail-follow begins only after a healthy loopback bind
  return { app, db, close };
}

/* v8 ignore start - CLI entry, exercised only when run as a script */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start()
    .then(({ app }) => {
      const bound = app
        .addresses()
        .map((entry) => `${entry.address}:${entry.port}`)
        .join(', ');
      console.log(`agenthropic server listening on ${bound}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
/* v8 ignore stop */
