/**
 * WP-D10 / L9 - one-line renderings of a retention policy and of a run report,
 * for the boot dry-run line and the per-cycle log line in `index.ts`.
 *
 * Pure string formatting over the port's types: no database, no filesystem,
 * nothing here can delete. It lives in the retention module so the wording
 * stays next to the report shapes it describes.
 */
import type { RetentionPolicy } from './policy';
import type { RetentionRunReport } from './port';

/** `events: prune after 90 day(s); token_usage: never pruned; backup files: ...` */
export function describeRetentionPolicy(policy: RetentionPolicy): string {
  const events =
    policy.events === null
      ? 'events: keep forever'
      : `events: prune after ${String(policy.events.maxAgeDays)} day(s)`;
  const tokenUsage =
    policy.tokenUsage === null
      ? 'token_usage: never pruned'
      : `token_usage: prune after ${String(policy.tokenUsage.maxAgeDays)} day(s), cost loss acknowledged`;
  const backups =
    policy.backupFiles === null
      ? 'backup files: keep forever'
      : `backup files: expire after ${String(policy.backupFiles.maxAgeDays)} day(s), ` +
        `always keeping the newest ${String(policy.backupFiles.keepMinimum)}`;
  return `${events}; ${tokenUsage}; ${backups}`;
}

/**
 * One line per run. A dry run says what WOULD go ("would prune"); a real run
 * says what went ("pruned") and, when rows were deleted, where the journal
 * receipt is. A `+` after a row count means the per-run budget was hit and
 * the next run has more to do.
 */
export function retentionRunLine(report: RetentionRunReport): string {
  const head = report.dryRun ? 'retention dry run (nothing deleted)' : 'retention';
  if (!report.configured) {
    return `${head}: no rule configured, nothing to prune.`;
  }
  const parts: string[] = [];
  if (report.database !== null) {
    const verb = report.dryRun ? 'would prune' : 'pruned';
    for (const table of report.database.tables) {
      const rows = report.dryRun ? table.rowsMatched : table.rowsDeleted;
      const more = table.budgetExhausted ? '+' : '';
      parts.push(
        `${table.table}: ${verb} ${String(rows)}${more} row(s) older than ${table.cutoff}`,
      );
    }
  }
  if (report.backups !== null) {
    const backups = report.backups;
    if (backups.directoryPresent) {
      const verb = report.dryRun ? 'would expire' : 'expired';
      parts.push(
        `backup files: ${verb} ${String(backups.deleted.length)} older than ${backups.cutoff} ` +
          `(${String(backups.keptByMinimum.length)} kept by the floor)`,
      );
    } else {
      parts.push(`backup files: directory ${backups.directory} absent, nothing to expire`);
    }
  }
  const receipt =
    report.database !== null && report.database.applied
      ? `; receipt ${String(report.database.journalPath)}`
      : '';
  return `${head}: ${parts.join('; ')}${receipt}.`;
}
