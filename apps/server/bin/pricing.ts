/**
 * R15 entry point: `pnpm --filter @agenthropic/server pricing <command>`.
 *
 * Resolves the database the way the server does - `DASHBOARD_DB_PATH`, else
 * `data/agenthropic.db`, relative to the working directory, which pnpm sets
 * to `apps/server` - and probes `DASHBOARD_PORT` (default 7341) so `set` can
 * refuse while a server runs. The logic and its tests live in
 * `src/db/pricing-admin.ts`; this wrapper only wires the environment and the
 * exit code, and is kept small enough to read instead of being tested.
 */
import { resolve } from 'node:path';
import { DEFAULT_DB_PATH, parsePort } from '../src/config';
import { runPricingCli } from '../src/db/pricing-admin';
import { isServerAnswering } from '../src/db/vacuum';

const raw = process.env['DASHBOARD_DB_PATH'];
const dbPath = resolve(raw === undefined || raw === '' ? DEFAULT_DB_PATH : raw);
const port = parsePort(process.env['DASHBOARD_PORT']);

runPricingCli(process.argv.slice(2), {
  dbPath,
  isServerRunning: () => isServerAnswering(port),
}).then(
  (lines) => {
    for (const line of lines) {
      console.log(line);
    }
  },
  (error: unknown) => {
    console.error(`pricing FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
