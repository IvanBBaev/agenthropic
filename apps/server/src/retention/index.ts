/**
 * WP-D10 - retention: public surface.
 *
 * POLICY STATUS. The MECHANISM is implemented and tested, and the v1.0 POLICY
 * is signed (D3, 2026-09-08): `events` after 90 days, backup files after 30
 * days behind a floor of the 7 newest, `token_usage` never. `config.ts` reads
 * the numbers, {@link signedRetentionPolicy} builds the policy, and `index.ts`
 * runs it after each successful daily backup (L9). The library loader
 * ({@link loadRetentionPolicy}) keeps its no-op default and is not called by
 * the server.
 */
export {
  BACKUP_FILE_PATTERN,
  BackupPruneError,
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
  MAX_RETENTION_DAYS,
  NO_RETENTION,
  RETENTION_PROTECTED_TABLES,
  RetentionPolicyError,
  signedRetentionPolicy,
  type AgeRule,
  type BackupFileRule,
  type CostBearingAgeRule,
  type RawEventStrategy,
  type RetentionPolicy,
  type SignedRetentionValues,
} from './policy';
export type { RetentionPort, RetentionRunOptions, RetentionRunReport } from './port';
export {
  cutoffFor,
  prune,
  type PruneOptions,
  type PruneReport,
  type PruneTableOutcome,
} from './prune';
export { createRetentionRunner, RetentionRunError } from './runner';
export { describeRetentionPolicy, retentionRunLine } from './summary';
