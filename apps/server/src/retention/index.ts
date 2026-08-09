/**
 * WP-D10 - retention: public surface.
 *
 * POLICY STATUS. The MECHANISM is implemented and tested; the POLICY - how
 * many days of what is kept - is deliberately UNSET and awaits Ivan's
 * ratification of OPEN-1 (retention TTL vs `events_raw` immutability), with
 * OPEN-2/OPEN-3 as the surrounding data-lifecycle reads:
 * `docs/analysis/open-decisions.md`. WP-D10 is therefore NOT done - do not
 * record it as such anywhere.
 *
 * The default is a no-op: an unconfigured deployment behaves exactly as it did
 * before this module existed.
 */
export {
  BACKUP_FILE_PATTERN,
  pruneBackupFiles,
  type BackupFileCandidate,
  type BackupPruneOptions,
  type BackupPruneReport,
} from './backup-files';
export {
  appendJournalEntry,
  defaultJournalPath,
  readJournalEntries,
  RETENTION_JOURNAL_SCHEMA,
  RETENTION_JOURNAL_SUFFIX,
} from './journal';
export {
  assertRetentionPolicy,
  DEFAULT_BACKUP_KEEP_MINIMUM,
  DEFAULT_MAX_ROWS_PER_RUN,
  isNoOpPolicy,
  loadRetentionPolicy,
  NO_RETENTION,
  RETENTION_PROTECTED_TABLES,
  RetentionPolicyError,
  type AgeRule,
  type BackupFileRule,
  type CostBearingAgeRule,
  type RawEventStrategy,
  type RetentionPolicy,
} from './policy';
export type { RetentionPort, RetentionRunOptions, RetentionRunReport } from './port';
export {
  cutoffFor,
  prune,
  type PruneOptions,
  type PruneReport,
  type PruneTableOutcome,
} from './prune';
export { createRetentionRunner } from './runner';
