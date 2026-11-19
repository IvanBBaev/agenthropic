/**
 * OPS-17 (2026-11-19) - an optional second copy of every backup, in a
 * directory the operator names (`DASHBOARD_BACKUP_MIRROR_DIR`): a Time Machine
 * volume, a NAS mount, a synced folder. The daily backups otherwise live on the
 * same disk as the database they protect, so one dead disk takes both.
 *
 * Rules:
 *  - The mirror directory is never created. A missing directory is most often
 *    a volume that is not mounted, and creating the mount point would write the
 *    "off-host" copy onto the local disk without anyone noticing. The copy
 *    fails instead, and the failure is reported in /api/health.
 *  - A copy is written under a `.partial` name and renamed into place, so a
 *    half-written file never carries the backup name. Anything that only looks
 *    at `agenthropic-*.db` (the boot-time seed, a restore) sees whole files.
 *  - The copy is 0600 like the original (R4 / SEC-2).
 *  - Nothing in the mirror is ever deleted. The mirror is the long-term copy,
 *    so its lifetime is the operator's to manage; local retention does not
 *    reach it.
 */
import { chmodSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { PRIVATE_FILE_MODE } from './file-modes';

/** Copy one finished backup into `mirrorDirectory`; returns the mirrored path. */
export function mirrorBackupFile(sourcePath: string, mirrorDirectory: string): string {
  const destPath = join(mirrorDirectory, basename(sourcePath));
  const partialPath = `${destPath}.partial`;
  try {
    copyFileSync(sourcePath, partialPath);
    chmodSync(partialPath, PRIVATE_FILE_MODE);
    // Atomic: the partial file sits beside its final name, on one filesystem.
    renameSync(partialPath, destPath);
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  }
  return destPath;
}

/**
 * A mirror that is the backup directory itself is no second copy at all - and
 * the copy would land on its own source name. Refused when the scheduler is
 * built, so the boot fails loudly instead of every cycle failing quietly.
 */
export function assertDistinctMirror(backupDirectory: string, mirrorDirectory: string): void {
  if (resolve(backupDirectory) === resolve(mirrorDirectory)) {
    throw new RangeError(
      `DASHBOARD_BACKUP_MIRROR_DIR "${mirrorDirectory}" is the backup directory itself; ` +
        'a mirror must be a different directory, ideally on another disk.',
    );
  }
}
