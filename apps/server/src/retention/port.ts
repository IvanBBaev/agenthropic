/**
 * WP-D10 - the retention PORT: the contract the rest of the system sees.
 *
 * Ports carry no database import, so the shape below is pure. The SQLite-backed
 * adapter is `runner.ts`.
 *
 * POLICY STATUS: a mechanism contract. The v1.0 policy is signed (D3,
 * 2026-09-08) and `index.ts` runs this port after each successful daily
 * backup (L9). Under the no-op policy every call to {@link RetentionPort.run}
 * is a reported no-op, so wiring the port up somewhere else does not, by
 * itself, delete anything.
 */
import type { BackupPruneReport } from './backup-files';
import type { PruneReport } from './prune';
import type { RetentionPolicy } from './policy';

export interface RetentionRunOptions {
  /** Clock injection point; defaults to now. */
  readonly now?: Date;
  /** Measure and report without deleting anything. */
  readonly dryRun?: boolean;
  /** Override the prune journal path (defaults to one beside the database). */
  readonly journalPath?: string;
}

export interface RetentionRunReport {
  readonly ranAt: string;
  readonly dryRun: boolean;
  /**
   * False when no retention rule is configured ({@link NO_RETENTION}, or the
   * signed policy with both windows at 0). Nothing was inspected, nothing was
   * deleted, and both sub-reports are null. This flag is
   * how a caller distinguishes "retention ran and found nothing to do" from
   * "retention is not configured".
   */
  readonly configured: boolean;
  /** Row prune over the projection tables; null when no row rule is set. */
  readonly database: PruneReport | null;
  /** Backup-file prune; null when no backup rule is set. */
  readonly backups: BackupPruneReport | null;
}

export interface RetentionPort {
  /** The policy this port was built with. Exposed so callers can report it. */
  readonly policy: RetentionPolicy;
  /** Apply (or, with `dryRun`, simulate) one bounded retention pass. */
  run(options?: RetentionRunOptions): RetentionRunReport;
}
