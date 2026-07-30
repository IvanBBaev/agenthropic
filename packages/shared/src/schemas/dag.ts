/**
 * WP-U4 - the global cross-session DAG DTO (the moat view): persisted agent
 * nodes + orchestration edges across the whole database, with counts so the
 * client can cap its D3 render (NFR-PERF-01).
 */
import { Type, type Static } from '@sinclair/typebox';
import { AgentNodeSchema, OrchestrationEdgeDtoSchema } from './graph';

export const DagCountsSchema = Type.Object(
  {
    totalSessions: Type.Integer({ minimum: 0 }),
    totalAgents: Type.Integer({ minimum: 0 }),
    totalEdges: Type.Integer({ minimum: 0 }),
    returnedAgents: Type.Integer({ minimum: 0 }),
    returnedEdges: Type.Integer({ minimum: 0 }),
    /** True when the node cap cut the response short - the client must say so. */
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type DagCountsDto = Static<typeof DagCountsSchema>;

/** `GET /api/dag/global` response. */
export const GlobalDagResponseSchema = Type.Object(
  {
    nodes: Type.Array(AgentNodeSchema),
    edges: Type.Array(OrchestrationEdgeDtoSchema),
    counts: DagCountsSchema,
  },
  { additionalProperties: false },
);

export type GlobalDagDto = Static<typeof GlobalDagResponseSchema>;
