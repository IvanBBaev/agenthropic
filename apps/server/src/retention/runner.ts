/**
 * WP-D10 - the SQLite-backed retention adapter.
 *
 * POLICY STATUS: mechanism only; the retention POLICY is unset and awaits
 * Ivan's OPEN-1/2/3 ratification (docs/analysis/open-decisions.md). WP-D10 is
 * NOT done.
 *
 * Nothing in the server calls this on a timer yet, and deliberately so: a
 * scheduled deleter must not exist before the policy that tells it what to
 * delete has been signed. The runner is constructed, tested and ready; the
 * decision to run it - and how often - stays with the owner.
 *
 * The single most important behaviour here is the SHORT CIRCUIT: with the
 * default {@link NO_RETENTION} policy, `run()` returns `configured: false`
 * without opening a transaction, reading a row or touching the filesystem.
 */
import type { SqliteDatabase } from '../db/connection';
import { pruneBackupFiles } from './backup-files';
import { assertRetentionPolicy, isNoOpPolicy, type RetentionPolicy } from './policy';
import type { RetentionPort, RetentionRunOptions, RetentionRunReport } from './port';
import { prune, type PruneOptions } from './prune';

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

      return {
        ranAt,
        dryRun,
        configured: true,
        database:
          policy.events === null && policy.tokenUsage === null
            ? null
            : prune(db, policy, pruneOptions),
        backups:
          policy.backupFiles === null
            ? null
            : pruneBackupFiles(policy.backupFiles, { now, dryRun }),
      };
    },
  };
}
