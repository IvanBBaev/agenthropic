/**
 * R19 entry point: `pnpm --filter @agenthropic/server db:vacuum`.
 *
 * Resolves the database the way the server does - `DASHBOARD_DB_PATH`, else
 * `data/agenthropic.db`, relative to the working directory, which pnpm sets
 * to `apps/server` - and refuses while a server answers on `DASHBOARD_PORT`
 * (default 7341). The logic and its tests live in `src/db/vacuum.ts`; this
 * wrapper only wires the environment and the exit code, and is kept small
 * enough to read instead of being tested.
 */
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_DB_PATH, parsePort } from '../src/config';
import { formatVacuumReport, isServerAnswering, runVacuum } from '../src/db/vacuum';

const raw = process.env['DASHBOARD_DB_PATH'];
const dbPath = resolve(raw === undefined || raw === '' ? DEFAULT_DB_PATH : raw);
const port = parsePort(process.env['DASHBOARD_PORT']);

runVacuum({
  dbPath,
  backupsDir: join(dirname(dbPath), 'backups'),
  isServerRunning: () => isServerAnswering(port),
}).then(
  (report) => {
    for (const line of formatVacuumReport(dbPath, report)) {
      console.log(line);
    }
  },
  (error: unknown) => {
    console.error(`vacuum FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
