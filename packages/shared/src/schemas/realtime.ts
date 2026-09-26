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
 * Published when a session's ingest failed (WP-IN5 failure visibility): a
 * quarantined session never reaches the read API, so without this frame it
 * would be a silent absence on the dashboard.
 *
 * The fields sit inside a `payload` envelope, unlike the two events above,
 * and that asymmetry is deliberate. Until 2026-09-09 this event rode a
 * generic catch-all arm (`{ type: string, payload: object }`) that forbade
 * top-level extras, so `occurredAt` went inside the payload; the web app,
 * which carries no TypeBox and narrows this frame by hand
 * (`apps/web/src/views/LiveView.tsx`, `toIngestFailureNotice`), mirrors that
 * envelope. Typing the arm while keeping the bytes identical means the
 * dashboard's narrowing keeps working; flattening it would have made every
 * quarantine notice unreadable there with no gate going red - the same drift
 * class that once left this event published but unheard (see
 * `realtime/event-types.ts`). The catch-all arm itself is gone: the union
 * below is closed, and a `type` outside it is not a valid event.
 */
export const IngestFailedEventSchema = Type.Object(
  {
    type: Type.Literal('ingest-failed'),
    payload: Type.Object(
      {
        sessionId: Type.String(),
        /** Sanitized: single line, no absolute path, no transcript or hook content. */
        reason: Type.String(),
        /** 1-based count of ingest attempts at this substrate fingerprint. */
        attempt: Type.Integer({ minimum: 1 }),
        /** False once the retry budget is spent: the session is quarantined. */
        willRetry: Type.Boolean(),
        occurredAt: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type IngestFailedEvent = Static<typeof IngestFailedEventSchema>;

/**
 * The closed union of everything `/api/stream` can carry - one arm per name in
 * `realtime/event-types.ts`, each with a literal `type` and
 * `additionalProperties: false`. There is no catch-all arm (decision D5 of the
 * 2026-09-08 closing plan): an unknown `type` is not "an event the client does
 * not know yet", it is a frame nobody publishes. On the client side the
 * browser's EventSource drops a named event with no registered listener, so
 * such a frame is never rendered; it still consumes a hub `id`, so it shows up
 * as a gap in the sequence at the next frame that is heard, and the live
 * board counts it there.
 */
export const RealtimeEventSchema = Type.Union([
  SessionIngestedEventSchema,
  AgentStatusChangedEventSchema,
  IngestFailedEventSchema,
]);

export type RealtimeEvent = Static<typeof RealtimeEventSchema>;
