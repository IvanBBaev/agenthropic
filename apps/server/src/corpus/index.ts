/**
 * WP-IN5 corpus adapter barrel — the disk → substrate → ingest surface the
 * composition root re-exports. The runtime entry point is
 * {@link runCorpusIngest}; the lower-level pieces are exported for tests and for
 * a future CLI / scheduled sweep.
 */
export { runCorpusIngest } from './ingest-corpus';
export type {
  CorpusIngestDeps,
  CorpusIngestFailure,
  CorpusIngestSummary,
  IngestFn,
} from './ingest-corpus';

export { buildSessionSubstrate, enumerateSessions } from './disk-substrate';
export { fingerprintSession } from './fingerprint';
export { nodeCorpusFs } from './node-corpus-fs';
export { resolveIdentity } from './identity';
export type { Identity } from './identity';
export {
  assertWithinRoot,
  isSafeEntryName,
  isSessionUuid,
  resolveCorpusRoot,
  splitTranscriptLines,
  toPosix,
} from './corpus-paths';

export {
  ContainmentError,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_READ_LIMITS,
  errnoCodeOf,
  OversizeError,
} from './fs-port';
export type {
  BuiltSubstrate,
  CorpusFs,
  EnumeratedSessions,
  LstatInfo,
  NoSubstrate,
  ReadLimits,
  SessionEnumeration,
  SessionRef,
  SkippedFile,
  SkipReason,
  SubstrateBuild,
  UnreadableRoot,
} from './fs-port';
