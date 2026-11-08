/**
 * RELEASE.md §5 entry point: `pnpm --filter @agenthropic/server drill:restore`.
 *
 * Resolves the database the way the server does - `DASHBOARD_DB_PATH`, else
 * `data/agenthropic.db`, relative to the working directory, which pnpm sets
 * to `apps/server` - and puts the drill backup in the server's `backups`
 * directory next to it. The logic and its tests live in
 * `src/db/restore-drill.ts`; this wrapper only wires the environment and the
 * exit code, and is kept small enough to read instead of being tested.
 */
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_DB_PATH } from '../src/config';
import { formatDrillReport, runRestoreDrill } from '../src/db/restore-drill';

const raw = process.env['DASHBOARD_DB_PATH'];
const dbPath = resolve(raw === undefined || raw === '' ? DEFAULT_DB_PATH : raw);

runRestoreDrill({ dbPath, backupsDir: join(dirname(dbPath), 'backups') }).then(
  (report) => {
    for (const line of formatDrillReport(dbPath, report)) {
      console.log(line);
    }
  },
  (error: unknown) => {
    console.error(
      `restore drill FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  },
);
