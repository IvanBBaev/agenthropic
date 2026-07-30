/**
 * WP-U3/WP-U4 - the graph DTOs shared by the session tree and the global DAG:
 * agent nodes (with ground-truth token/cost rollups) and persisted
 * orchestration edges.
 *
 * Honesty rules encoded here:
 * - `source` is the edge's persisted provenance (the four structural join
 *   paths) served verbatim - inferred edges must stay distinguishable.
 * - `costUsd` is always tokens x dated price over PRICED rows only; tokens
 *   that could not be priced are surfaced in `unpricedTokens`, never silently
 *   folded into a dollar figure.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  AgentStatusSchema,
  AgentTypeSchema,
  OrchestrationEdgeSourceSchema,
  nullable,
} from './common';

/** One agent as a queryable node (agents table row + usage rollup). */
export const AgentNodeSchema = Type.Object(
  {
    id: Type.String(),
    sessionId: Type.String(),
    type: nullable(AgentTypeSchema),
    subagentType: nullable(Type.String()),
    status: nullable(AgentStatusSchema),
    /** Self-referential parent - the subagent tree as a data fact. */
    parentAgentId: nullable(Type.String()),
    firstSeenAt: nullable(Type.String()),
    lastSeenAt: nullable(Type.String()),
    totalTokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    unpricedTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type AgentNodeDto = Static<typeof AgentNodeSchema>;

/** One persisted orchestration edge, served exactly as stored. */
export const OrchestrationEdgeDtoSchema = Type.Object(
  {
    id: Type.Integer(),
    sessionId: Type.String(),
    parentAgentId: Type.String(),
    childAgentId: Type.String(),
    source: OrchestrationEdgeSourceSchema,
    instance: Type.String(),
    hostId: Type.String(),
    createdAt: nullable(Type.String()),
  },
  { additionalProperties: false },
);

export type OrchestrationEdgeDto = Static<typeof OrchestrationEdgeDtoSchema>;
