/**
 * @agenthropic/test-fixtures - shared fixtures (synthetic JSONL transcripts,
 * hook payloads) for parser and ingest tests.
 *
 * The synthetic corpus under `src/fixtures/` covers the five edge provenances
 * of docs/analysis/parser-spec.md section 4.1 (tool_use, directory,
 * task_notification, queue_operation, legacy_explore), the depth-2 parent
 * (gate item 4), the N3 usage-dedup case and the WP-U10 outcome terminals.
 * All fixture content is invented; nothing is copied from real
 * transcripts.
 */
import type { RawEventEnvelope } from '@agenthropic/shared';

export {
  DUPLICATED_MESSAGE_ID,
  EVICTED_TOOL_USE_ID,
  FIXTURE_NAMES,
  INTERRUPT_TOOL_USE_ID,
  LEGACY_CHILD_HEX,
  LEGACY_DECOY_HEX,
  QUEUED_TASK_ID,
  QUEUED_TOOL_USE_ID,
  TASK_ID,
  TERMINATED_EARLY_AGENT_ID,
  TERMINATED_TOOL_USE_ID,
  USER_INTERRUPT_AGENT_ID,
  getFixture,
  listFixtures,
} from './fixtures/index.js';
export type { Fixture, FixtureFile, FixtureName } from './fixtures/index.js';

export {
  ANNOTATION_SUFFIX,
  AnnotationError,
  EXIT_GATE_THRESHOLD,
  ORPHAN_TOKEN,
  PROVENANCES,
  RENDER_DIR,
  ROOT_TOKEN,
  SUBSTRATE_UNAVAILABLE,
  ScoringError,
  UNKNOWN_TOKEN,
  WILSON_Z_95_ONE_SIDED,
  buildSpawnIndex,
  certifyExitGate,
  describeRecord,
  describeToolUseBlock,
  formatPercent,
  isParserArtifact,
  minimumClaimsForThreshold,
  parseAnnotation,
  previewContent,
  readAnnotationDir,
  readClaimTemplate,
  readSessionTree,
  renderClaim,
  renderClaimPage,
  renderClaims,
  renderCorpusReport,
  renderIndexPage,
  resolveClaim,
  runRenderClaims,
  scoreCorpus,
  scoreSession,
  wilsonLowerBound,
  writeRender,
} from './annotations/index.js';
export type {
  AnnotatedEdge,
  AnnotationIssue,
  CaseOutcome,
  ClaimRender,
  ClaimResolution,
  ClaimTemplate,
  CorpusScore,
  EvidenceLine,
  ExitGateVerdict,
  HierarchyCase,
  JoinKind,
  ObservedAgent,
  ObservedHierarchy,
  ParentClaim,
  Provenance,
  RecordRef,
  RenderIo,
  RenderStats,
  RenderedTemplate,
  ScoringEntry,
  SessionAnnotation,
  SessionScore,
  SessionSubstrateLike,
  SpawnIndex,
  SubstrateFileLike,
  SubstrateRef,
  TemplateClaim,
} from './annotations/index.js';

/** A minimal valid raw-event envelope for tests that just need one. */
export function makeRawEventEnvelope(overrides: Partial<RawEventEnvelope> = {}): RawEventEnvelope {
  return {
    idempotencyKey: 'fixture-key-1',
    source: 'hook',
    eventType: 'SessionStart',
    payload: { session_id: 'fixture-session-1' },
    receivedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}
