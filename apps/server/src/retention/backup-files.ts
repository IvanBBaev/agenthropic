/**
 * WP-D10 - retention for backup FILES (the WP-F8 artifacts), as opposed to
 * rows. This is the half of retention that can actually reclaim real disk
 * space, because a backup is a whole copy of the database.
 *
 * POLICY STATUS: signed (D3, 2026-09-08) - backups older than 30 days expire
 * behind a floor of the 7 newest, both configurable
 * (`DASHBOARD_RETENTION_BACKUP_DAYS`, `DASHBOARD_RETENTION_BACKUP_KEEP_MIN`),
 * and the daily timer in `index.ts` runs this after each successful backup.
 * With `DASHBOARD_RETENTION_BACKUP_DAYS=0` no `backupFiles` rule exists, this
 * module is never called and no file is ever removed.
 *
 * SAFETY.
 *  - `keepMinimum` newest backups ALWAYS survive, whatever the age window
 *    says. A pass that can leave zero backups is a data-loss mechanism, not a
 *    retention one, so the floor is enforced here and validated in `policy.ts`.
 *  - Only files matching the backup naming convention are considered; anything
 *    else in the directory is invisible to this module, so pointing the rule at
 *    a wrong directory deletes nothing rather than something.
 *  - A missing directory is reported, not thrown and not created: "no backups
 *    yet" is a normal state.
 *  - `dryRun` lists exactly what would go, and removes nothing.
 *  - Files are removed one by one; a failure part-way leaves the already
 *    removed ones removed (unlike the database prune, a filesystem has no
 *    transaction). The error propagates as a {@link BackupPruneError} that
 *    carries the partial report (what was actually deleted before the failure)
 *    and names those files in its message, so a caller that only logs the
 *    message still records the loss.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupFileRule } from './policy';

/**
 * Backup filename convention from `docs/site/operations/backup-restore.md`
 * (`agenthropic-<timestamp>.db`). Anchored, so nothing else can match.
 */
export const BACKUP_FILE_PATTERN = /^agenthropic-.+\.db$/;

const MS_PER_DAY = 86_400_000;

export interface BackupFileCandidate {
  readonly name: string;
  readonly path: string;
  /** File mtime as an ISO timestamp. */
  readonly modifiedAt: string;
  readonly sizeBytes: number;
}

export interface BackupPruneOptions {
  readonly now?: Date;
  readonly dryRun?: boolean;
}

export interface BackupPruneReport {
  readonly directory: string;
  /** False when the directory does not exist - reported, never thrown. */
  readonly directoryPresent: boolean;
  readonly dryRun: boolean;
  /** Files older than this ISO timestamp were eligible. */
  readonly cutoff: string;
  /** Every backup file found, newest first. */
  readonly found: readonly BackupFileCandidate[];
  /** Backups deleted (or, in a dry run, that would be). */
  readonly deleted: readonly BackupFileCandidate[];
  /**
   * Expired backups spared solely by the `keepMinimum` floor - the number to
   * look at when the directory is not shrinking as expected.
   */
  readonly keptByMinimum: readonly BackupFileCandidate[];
  /** Bytes reclaimed (or, in a dry run, that would be). */
  readonly bytesReclaimed: number;
}

/**
 * A pass that stopped part-way: `report` lists only what was really deleted
 * before `failed` could not be removed; `cause` is the underlying fs error.
 */
export class BackupPruneError extends Error {
  readonly report: BackupPruneReport;
  readonly failed: BackupFileCandidate;

  constructor(report: BackupPruneReport, failed: BackupFileCandidate, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const names = report.deleted.map((candidate) => candidate.name).join(', ');
    super(
      `backup prune stopped at ${failed.name} (${reason}); ` +
        `${String(report.deleted.length)} already deleted${names === '' ? '' : `: ${names}`}`,
      { cause },
    );
    this.name = 'BackupPruneError';
    this.report = report;
    this.failed = failed;
  }
}

/**
 * Apply one backup-file retention pass.
 *
 * Returns a report of what happened (or, with `dryRun`, would happen).
 */
export function pruneBackupFiles(
  rule: BackupFileRule,
  options: BackupPruneOptions = {},
): BackupPruneReport {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const cutoff = new Date(now.getTime() - rule.maxAgeDays * MS_PER_DAY).toISOString();

  if (!existsSync(rule.directory)) {
    return {
      directory: rule.directory,
      directoryPresent: false,
      dryRun,
      cutoff,
      found: [],
      deleted: [],
      keptByMinimum: [],
      bytesReclaimed: 0,
    };
  }

  const found = listBackups(rule.directory);
  const deleted: BackupFileCandidate[] = [];
  const keptByMinimum: BackupFileCandidate[] = [];
  let bytesReclaimed = 0;

  const reportSoFar = (): BackupPruneReport => ({
    directory: rule.directory,
    directoryPresent: true,
    dryRun,
    cutoff,
    found,
    deleted,
    keptByMinimum,
    bytesReclaimed,
  });

  found.forEach((candidate, index) => {
    if (candidate.modifiedAt >= cutoff) {
      return;
    }
    if (index < rule.keepMinimum) {
      // Expired, but inside the never-delete floor.
      keptByMinimum.push(candidate);
      return;
    }
    if (!dryRun) {
      try {
        unlinkSync(candidate.path);
      } catch (cause) {
        throw new BackupPruneError(reportSoFar(), candidate, cause);
      }
    }
    deleted.push(candidate);
    bytesReclaimed += candidate.sizeBytes;
  });

  return reportSoFar();
}

/** Backup files in the directory, newest first (name break ties, for stability). */
function listBackups(directory: string): readonly BackupFileCandidate[] {
  const candidates: BackupFileCandidate[] = [];
  for (const name of readdirSync(directory)) {
    if (!BACKUP_FILE_PATTERN.test(name)) {
      continue;
    }
    const path = join(directory, name);
    const stats = statSync(path);
    if (!stats.isFile()) {
      continue;
    }
    candidates.push({
      name,
      path,
      modifiedAt: new Date(stats.mtimeMs).toISOString(),
      sizeBytes: stats.size,
    });
  }
  return candidates.sort(
    (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name),
  );
}
