/**
 * Type-only bridge to the @agenthropic/shared DTO contracts (WP-U6..U9).
 *
 * The web package deliberately has NO runtime dependency on the shared
 * package (its schemas pull in TypeBox, which the browser bundle never
 * needs), so the workspace alias is not installed here. Instead the types are
 * re-exported through the TypeScript project reference via a relative import:
 * `import type` is fully erased at build time, so Vite and Vitest never
 * resolve the specifier - only `tsc` does, against the referenced project's
 * declaration output. Import DTO types from THIS module everywhere in the app.
 */
export type {
  AgentNodeDto,
  AgentStatus,
  AgentStatusChangedEvent,
  CostSummaryDto,
  DailyCostDto,
  GlobalDagDto,
  ModelCostDto,
  OrchestrationEdgeDto,
  OrchestrationEdgeSource,
  SessionCostDto,
  SessionIngestedEvent,
  SessionListDto,
  SessionStatusCountsDto,
  SessionSummaryDto,
  SessionTreeDto,
} from '../../../packages/shared/src/index';
