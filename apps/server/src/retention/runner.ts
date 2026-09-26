/**
 * WP-D10 - the SQLite-backed retention adapter.
 *
 * POLICY STATUS: the v1.0 policy is signed (D3, 2026-09-08) and this runner
 * is wired - `index.ts` builds it from `signedRetentionPolicy` and runs it
 * once per daily backup cycle, after that cycle's backup succeeded (L9). The
 * runner itself stays policy-agnostic: what to delete is decided by the
 * policy it is handed - the numbers are parsed in `config.ts` and shaped by
 * `signedRetentionPolicy` in `policy.ts` - not here.
 *
 * The single most important behaviour here is the SHORT CIRCUIT: with the
 * {@link NO_RETENTION} policy (or the signed policy with both windows at 0),
 * `run()` returns `configured: false` without opening a transaction, reading
 * a row or touching the filesystem.
 */
import type { SqliteDatabase } from '../db/connection';
import { BackupPruneError, pruneBackupFiles, type BackupPruneReport } from './backup-files';
import { assertRetentionPolicy, isNoOpPolicy, type RetentionPolicy } from './policy';
import type { RetentionPort, RetentionRunOptions, RetentionRunReport } from './port';
import { prune, type PruneOptions } from './prune';

/**
 * A pass that stopped in its backup-file step. By then the row prune may
 * already have committed (and journaled) its deletes, and the backup step may
 * have unlinked some files: `report` is what really happened before the
 * failure, so a caller can log it instead of losing the record. `backups` is
 * the partial backup report when the failure carried one
 * ({@link BackupPruneError}), else null. The message is the underlying one.
 */
export class RetentionRunError extends Error {
  readonly report: RetentionRunReport;

  constructor(report: RetentionRunReport, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RetentionRunError';
    this.report = report;
  }
}

/**
 * Build a retention runner over an open database and a policy.
 *
 * The policy is validated at construction, so an unhonourable configuration
 * fails at wiring time rather than at 3am inside a scheduled deletion.
 */
export function createRetentionRunner(db: SqliteDatabase, policy: RetentionPolicy): RetentionPort {
  assertRetentionPolicy(policy);
  return {
    policy,
    run(options: RetentionRunOptions = {}): RetentionRunReport {
      const now = options.now ?? new Date();
      const dryRun = options.dryRun ?? false;
      const ranAt = now.toISOString();

      if (isNoOpPolicy(policy)) {
        return { ranAt, dryRun, configured: false, database: null, backups: null };
      }

      const pruneOptions: PruneOptions =
        options.journalPath === undefined
          ? { now, dryRun }
          : { now, dryRun, journalPath: options.journalPath };

      const database =
        policy.events === null && policy.tokenUsage === null
          ? null
          : prune(db, policy, pruneOptions);
      let backups: BackupPruneReport | null = null;
      if (policy.backupFiles !== null) {
        try {
          backups = pruneBackupFiles(policy.backupFiles, { now, dryRun });
        } catch (error) {
          throw new RetentionRunError(
            {
              ranAt,
              dryRun,
              configured: true,
              database,
              backups: error instanceof BackupPruneError ? error.report : null,
            },
            error,
          );
        }
      }
      return { ranAt, dryRun, configured: true, database, backups };
    },
  };
}
