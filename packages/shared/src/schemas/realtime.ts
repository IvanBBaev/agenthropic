/**
 * WP-U1 - the realtime event union carried over the SSE stream. The server's
 * RealtimeHub publishes these; the web app's EventSource consumes them. Each
 * SSE frame's `event:` field is the `type` and its `data:` is the JSON of the
 * whole event object.
 */
import { Type, type Static } from '@sinclair/typebox';
import { AgentStatusSchema, nullable } from './common';

/** Published after a session substrate was (re-)ingested and committed. */
export const SessionIngestedEventSchema = Type.Object(
  {
    type: Type.Literal('session-ingested'),
    sessionId: Type.String(),
    projectSlug: nullable(Type.String()),
    agentCount: Type.Integer({ minimum: 0 }),
    edgesInserted: Type.Integer({ minimum: 0 }),
    usageRowsInserted: Type.Integer({ minimum: 0 }),
    /** Ground-truth cost of the whole session, or null when not yet priced. */
    costUsd: nullable(Type.Number({ minimum: 0 })),
    occurredAt: Type.String(),
  },
  { additionalProperties: false },
);

export type SessionIngestedEvent = Static<typeof SessionIngestedEventSchema>;

/** Published when an agent's persisted status changes (incl. -> 'unknown'). */
export const AgentStatusChangedEventSchema = Type.Object(
  {
    type: Type.Literal('agent-status-changed'),
    sessionId: Type.String(),
    agentId: Type.String(),
    status: AgentStatusSchema,
    previousStatus: nullable(AgentStatusSchema),
    occurredAt: Type.String(),
  },
  { additionalProperties: false },
);

export type AgentStatusChangedEvent = Static<typeof AgentStatusChangedEventSchema>;

/**
 * Catch-all shape for event kinds the client does not (yet) know: a free-form
 * `type` plus an opaque JSON payload. Kept structurally distinct from the
 * known events by the mandatory `payload` envelope.
 */
export const GenericRealtimeEventSchema = Type.Object(
  {
    type: Type.String(),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export type GenericRealtimeEvent = Static<typeof GenericRealtimeEventSchema>;

export const RealtimeEventSchema = Type.Union([
  SessionIngestedEventSchema,
  AgentStatusChangedEventSchema,
  GenericRealtimeEventSchema,
]);

export type RealtimeEvent = Static<typeof RealtimeEventSchema>;
