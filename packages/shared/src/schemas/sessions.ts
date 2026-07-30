/**
 * WP-U3 - session DTOs: the recent-first list, the per-session detail, and
 * the session-scoped subagent tree (served from persisted rows - the tree is
 * a data fact, never a UI reconstruction).
 */
import { Type, type Static } from '@sinclair/typebox';
import { nullable } from './common';
import { AgentNodeSchema, OrchestrationEdgeDtoSchema } from './graph';
import { ModelCostSchema } from './cost';

/**
 * Per-status agent counts. `unknown` is a first-class bucket: the status
 * board's ATTENTION band depends on it being visible in every rollup.
 */
export const SessionStatusCountsSchema = Type.Object(
  {
    working: Type.Integer({ minimum: 0 }),
    waiting: Type.Integer({ minimum: 0 }),
    completed: Type.Integer({ minimum: 0 }),
    error: Type.Integer({ minimum: 0 }),
    unknown: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type SessionStatusCountsDto = Static<typeof SessionStatusCountsSchema>;

export const SessionSummarySchema = Type.Object(
  {
    id: Type.String(),
    projectSlug: nullable(Type.String()),
    status: nullable(Type.String()),
    startedAt: nullable(Type.String()),
    lastActivityAt: nullable(Type.String()),
    agentCount: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    totalCostUsd: Type.Number({ minimum: 0 }),
    unpricedTokens: Type.Integer({ minimum: 0 }),
    statusCounts: SessionStatusCountsSchema,
  },
  { additionalProperties: false },
);

export type SessionSummaryDto = Static<typeof SessionSummarySchema>;

/** `GET /api/sessions` response (recent-first, capped limit/offset). */
export const SessionListResponseSchema = Type.Object(
  {
    sessions: Type.Array(SessionSummarySchema),
    total: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1 }),
    offset: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type SessionListDto = Static<typeof SessionListResponseSchema>;

/** `GET /api/sessions/:id` response: the summary plus per-model cost rollups. */
export const SessionDetailSchema = Type.Composite(
  [
    SessionSummarySchema,
    Type.Object({
      edgeCount: Type.Integer({ minimum: 0 }),
      models: Type.Array(ModelCostSchema),
    }),
  ],
  { additionalProperties: false },
);

export type SessionDetailDto = Static<typeof SessionDetailSchema>;

/**
 * `GET /api/sessions/:id/tree` response. `unattributed` carries token usage
 * whose `agent_id` is null (the main agent's own turns) or points at no
 * materialized agent row - shown, never dropped.
 */
export const SessionTreeResponseSchema = Type.Object(
  {
    sessionId: Type.String(),
    agents: Type.Array(AgentNodeSchema),
    edges: Type.Array(OrchestrationEdgeDtoSchema),
    agentCount: Type.Integer({ minimum: 0 }),
    edgeCount: Type.Integer({ minimum: 0 }),
    unattributed: Type.Object(
      {
        totalTokens: Type.Integer({ minimum: 0 }),
        costUsd: Type.Number({ minimum: 0 }),
        unpricedTokens: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type SessionTreeDto = Static<typeof SessionTreeResponseSchema>;
