/**
 * Hand-labeled hierarchy annotations - format, loader, scorer and report.
 *
 * Purpose: turn "measure hierarchy accuracy against ground truth" from an
 * unbounded human task into a bounded one. The labels themselves are a human
 * act and nothing here invents them; what is provided is the file format the
 * labels go in, the validation that catches a typo immediately, the scorer that
 * compares them against the real parser, and the verdict that refuses to
 * certify a gate from a sample too small - or from machine-authored truth.
 *
 * See `packages/test-fixtures/annotations/README.md` for the labeling
 * instructions and the exact command to run.
 */
export { ANNOTATION_SUFFIX, parseAnnotation } from './parse.js';
export { readAnnotationDir, readSessionTree } from './read.js';
export type { SessionSubstrateLike, SubstrateFileLike } from './read.js';
export { renderCorpusReport } from './report.js';
export {
  EXIT_GATE_THRESHOLD,
  ScoringError,
  WILSON_Z_95_ONE_SIDED,
  certifyExitGate,
  formatPercent,
  minimumClaimsForThreshold,
  renderClaim,
  scoreCorpus,
  scoreSession,
  wilsonLowerBound,
} from './score.js';
export type {
  CaseOutcome,
  CorpusScore,
  ExitGateVerdict,
  HierarchyCase,
  ObservedAgent,
  ObservedHierarchy,
  ScoringEntry,
  SessionScore,
} from './score.js';
export { AnnotationError, ORPHAN_TOKEN, PROVENANCES, ROOT_TOKEN, UNKNOWN_TOKEN } from './types.js';
export type {
  AnnotatedEdge,
  AnnotationIssue,
  ParentClaim,
  Provenance,
  SessionAnnotation,
  SubstrateRef,
} from './types.js';
