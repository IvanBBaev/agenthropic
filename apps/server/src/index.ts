/**
 * @agenthropic/server - composition root (WP-U0).
 *
 * loadConfig (mandatory DASHBOARD_TOKEN) -> openDatabase (WAL asserted) ->
 * runMigrations -> listen on the constant loopback host -> verify every
 * bound address is loopback or shut down hard.
 */
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { HOST, loadConfig } from './config';
import { openDatabase, type SqliteDatabase } from './db/connection';
import { currentSchemaVersion, runMigrations } from './db/migrations';
import { buildServer } from './server';

export { HOST, loadConfig, DEFAULT_PORT, DEFAULT_DB_PATH } from './config';
export type { ServerConfig } from './config';
export { openDatabase, assertConnectionPragmas } from './db/connection';
export type { SqliteDatabase } from './db/connection';
export { migrations, runMigrations, currentSchemaVersion } from './db/migrations';
export type { Migration, MigrationRunResult } from './db/migrations';
export { SqliteEventStore } from './db/event-store';
export { insertOrchestrationEdge } from './db/edges';
export type { OrchestrationEdgeInsert, EdgeInsertResult } from './db/edges';
export { backupDatabase, restoreDatabase } from './db/backup';
export { buildServer } from './server';
export type { BuildServerOptions } from './server';

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

/** Boot the server. Throws when configuration is invalid (e.g. no token). */
export async function start(
  env: Record<string, string | undefined> = process.env,
): Promise<RunningServer> {
  const config = loadConfig(env);
  const db = openDatabase(config.dbPath);
  runMigrations(db);
  const app = buildServer({
    token: config.token,
    schemaVersion: currentSchemaVersion(db),
  });
  const close = async (): Promise<void> => {
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
