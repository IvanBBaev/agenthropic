/**
 * WP-D5 - hook liveness timeline DTOs (`GET /api/sessions/:id/events`).
 *
 * Each row is the normalized projection of one hook delivery
 * (`events_raw` -> `events`). These DTOs carry LIVENESS ONLY, NEVER
 * STRUCTURE: they are not the DAG, they never feed `agents`,
 * `orchestration_edges` or `token_usage`, and the absence of events says
 * nothing about whether an agent ran - hooks are a secondary, best-effort
 * channel while JSONL transcripts remain ground truth (CD-1).
 *
 * Honesty surface for time: the `events.occurred_at` column currently always
 * carries the server RECEIPT time (`events_raw.received_at`), because the
 * WP-IN1 hook envelope contract exposes no event-originated timestamp -
 * Claude Code hook stdin JSON carries none and redaction adds none. So the
 * only `occurredAtSource` value today is `'receipt'`; the union widens if a
 * true event time is ever wired, letting consumers tell the two apart
 * instead of having receipt time papered over as event time.
 */
import { Type, type Static } from '@sinclair/typebox';
import { nullable } from './common';

/**
 * Where a hook event's `occurredAt` came from. `'receipt'` = the server's
 * receive time, NOT the moment the hook fired at the source.
 */
export const HookEventTimeSourceSchema = Type.Union([Type.Literal('receipt')]);

export type HookEventTimeSource = Static<typeof HookEventTimeSourceSchema>;

/**
 * One normalized hook liveness event. No payload content beyond the
 * identifiers is ever projected or served - the raw (redacted) payload stays
 * in `events_raw`, reachable only by `rawEventId`.
 */
export const SessionHookEventSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    /** FK into the append-only `events_raw` substrate this row came from. */
    rawEventId: Type.Integer({ minimum: 1 }),
    /** Agent id as self-reported by the payload; null when absent/unusable. */
    agentId: nullable(Type.String()),
    eventType: nullable(Type.String()),
    occurredAt: nullable(Type.String()),
    occurredAtSource: HookEventTimeSourceSchema,
  },
  { additionalProperties: false },
);

export type SessionHookEventDto = Static<typeof SessionHookEventSchema>;

/**
 * `GET /api/sessions/:id/events` response: one session's hook liveness
 * timeline, oldest first (`occurredAt`, then `id` as the stable tiebreaker),
 * behind the same capped limit/offset pagination as the sessions list -
 * `total` keeps any truncation visible, never silent.
 */
export const SessionEventsResponseSchema = Type.Object(
  {
    sessionId: Type.String(),
    events: Type.Array(SessionHookEventSchema),
    total: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1 }),
    offset: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type SessionEventsDto = Static<typeof SessionEventsResponseSchema>;
