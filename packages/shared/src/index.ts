/**
 * The browser-safe entry of `@agenthropic/shared`: schemas, DTO types, port
 * types and constants that both the server and the SPA read. ARC-12: nothing
 * reachable from here imports a `node:` module or a test double -
 * `@agenthropic/shared/node` holds the node-only security primitives and
 * `@agenthropic/shared/testing` the in-memory fakes. `test/entry-points.test.ts`
 * walks this module graph and fails if either leaks back in.
 */
export type { TokenBucket, RawEventSource } from './types/enums';
export type * from './ports/event-store';
export type { AlertSinkPort, DeliveryOutcome } from './ports/alert-sink';
export {
  AlertKindSchema,
  AlertTargetKindSchema,
  ALERT_ID_PATTERN,
  TOKEN_REF_PATTERN,
  MAX_ALERTS_PER_MINUTE,
  DEFAULT_ALERTS_PER_MINUTE,
  TelegramTargetConfigSchema,
  CostThresholdRuleConfigSchema,
  StuckAgentRuleConfigSchema,
  ErrorRuleConfigSchema,
  AlertRuleConfigSchema,
  AlertsConfigSchema,
  alertsConfigProblems,
} from './schemas/alerts';
export type {
  AlertKind,
  AlertTargetKind,
  TelegramTargetConfig,
  CostThresholdRuleConfig,
  StuckAgentRuleConfig,
  ErrorRuleConfig,
  AlertRuleConfig,
  AlertsConfig,
  CostThresholdNotification,
  StuckAgentNotification,
  ErrorNotification,
  AlertNotification,
} from './schemas/alerts';
export { HealthSchema, VersionFormatDriftSchema } from './schemas/health';
export type { FormatDriftDto, HealthDto, VersionFormatDriftDto } from './schemas/health';
export {
  nullable,
  ApiErrorSchema,
  SessionRejectedErrorSchema,
  SessionRejectionCodeSchema,
  AgentStatusSchema,
  AgentTypeSchema,
  AgentOutcomeCauseSchema,
  OrchestrationEdgeSourceSchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_PAGE_OFFSET,
  DEFAULT_COST_TOP_N,
  MAX_COST_TOP_N,
  DEFAULT_DAG_NODE_LIMIT,
  MAX_DAG_NODE_LIMIT,
} from './schemas/common';
export type {
  ApiErrorDto,
  SessionRejectedErrorDto,
  SessionRejectionCode,
  AgentStatus,
  AgentType,
  AgentOutcomeCause,
  OrchestrationEdgeSource,
} from './schemas/common';
export { AgentNodeSchema, OrchestrationEdgeDtoSchema } from './schemas/graph';
export type { AgentNodeDto, OrchestrationEdgeDto } from './schemas/graph';
export {
  SessionStatusCountsSchema,
  SessionOutcomeCauseCountsSchema,
  SessionSummarySchema,
  SessionListResponseSchema,
  SessionDetailSchema,
  SessionTreeResponseSchema,
} from './schemas/sessions';
export type {
  SessionStatusCountsDto,
  SessionOutcomeCauseCountsDto,
  SessionSummaryDto,
  SessionListDto,
  SessionDetailDto,
  SessionTreeDto,
} from './schemas/sessions';
export {
  CostTotalsSchema,
  ModelCostSchema,
  DailyCostSchema,
  SessionCostSchema,
  SessionPartialSchema,
  CostCoverageSchema,
  CostSummaryResponseSchema,
  TokenBucketsSchema,
  CompactionBoundarySchema,
  CompactionSegmentSchema,
  CompactionAnalysisSchema,
  AgentDelegationSavingsSchema,
  DelegationSavingsSchema,
  MAX_AGGREGATE_SKIPPED_SAMPLE,
  AggregateSavingsSkipReasonSchema,
  AggregateSavingsSkipSchema,
  AggregateDelegationSavingsSchema,
  CostAnalysisSchema,
} from './schemas/cost';
export type {
  CostTotalsDto,
  ModelCostDto,
  DailyCostDto,
  SessionCostDto,
  SessionPartialDto,
  CostCoverageDto,
  CostSummaryDto,
  TokenBucketsDto,
  CompactionBoundaryDto,
  CompactionSegmentDto,
  CompactionAnalysisDto,
  AgentDelegationSavingsDto,
  DelegationSavingsDto,
  AggregateSavingsSkipReason,
  AggregateSavingsSkipDto,
  AggregateDelegationSavingsDto,
  CostAnalysisDto,
} from './schemas/cost';
export {
  HookEventTimeSourceSchema,
  SessionHookEventSchema,
  SessionEventsResponseSchema,
} from './schemas/events';
export type { HookEventTimeSource, SessionHookEventDto, SessionEventsDto } from './schemas/events';
export { DagCountsSchema, GlobalDagResponseSchema } from './schemas/dag';
export type { DagCountsDto, GlobalDagDto } from './schemas/dag';
export {
  SessionChangeKindSchema,
  ChangedSessionSchema,
  ChangeTotalsSchema,
  ChangesCoverageSchema,
  LateIngestedSchema,
  ChangesResponseSchema,
} from './schemas/changes';
export type {
  SessionChangeKind,
  ChangedSessionDto,
  ChangeTotalsDto,
  ChangesCoverageDto,
  LateIngestedDto,
  ChangesDto,
} from './schemas/changes';
export {
  SessionIngestedEventSchema,
  AgentStatusChangedEventSchema,
  IngestFailedEventSchema,
  RealtimeEventSchema,
} from './schemas/realtime';
export type {
  SessionIngestedEvent,
  AgentStatusChangedEvent,
  IngestFailedEvent,
  RealtimeEvent,
} from './schemas/realtime';
export { SERVER_EVENT_TYPES } from './realtime/event-types';
export type { ServerEventType } from './realtime/event-types';
