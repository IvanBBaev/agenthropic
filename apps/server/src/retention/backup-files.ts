/**
 * WP-D10 - retention for backup FILES (the WP-F8 artifacts), as opposed to
 * rows. This is the half of retention that can actually reclaim real disk
 * space, because a backup is a whole copy of the database.
 *
 * POLICY STATUS: mechanism only. How many days of backups to keep is unset and
 * awaits Ivan's OPEN-1 ratification (docs/analysis/open-decisions.md). With no
 * `backupFiles` rule configured this module is never called and no file is
 * ever removed.
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
 *    transaction). The report therefore lists what was actually deleted, and
 *    the error propagates.
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
      unlinkSync(candidate.path);
    }
    deleted.push(candidate);
    bytesReclaimed += candidate.sizeBytes;
  });

  return {
    directory: rule.directory,
    directoryPresent: true,
    dryRun,
    cutoff,
    found,
    deleted,
    keptByMinimum,
    bytesReclaimed,
  };
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
