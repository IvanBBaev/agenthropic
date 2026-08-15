/**
 * WP-IN3 - the authed loopback hook receiver, as a standalone Fastify plugin.
 *
 * POST /api/hooks/event accepts ANY JSON body (the Phase-2 exit gate:
 * unknown hook names and extra fields are STORED, never crashed on - hooks
 * are a secondary liveness signal, JSONL is ground truth), redacts it at the
 * boundary (WP-IN14), wraps it in the WP-IN1 envelope and appends it to the
 * append-only `events_raw` substrate through the injected event-store port.
 * The port is idempotent by key (`INSERT OR IGNORE` in the SQLite adapter),
 * so a duplicate delivery inserts zero new rows and the reply reports
 * `stored: false`.
 *
 * SECURITY: the routes live under `/api/`, so the global onRequest auth gate
 * in `buildServer` (timing-safe Bearer compare, WP-U0) covers them - this
 * plugin adds no auth bypass and never logs or echoes payloads or tokens.
 * Register it on the buildServer instance BEFORE listen:
 *
 *   registerHookRoutes(app, { eventStore: new SqliteEventStore(db) });
 *
 * (Being an async (instance, options) function it also composes with
 * `app.register(registerHookRoutes, { eventStore })` if preferred.)
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { ApiErrorSchema, type EventStorePort } from '@agenthropic/shared';
import { buildHookEnvelope } from './envelope';
import { redactSecrets } from './redact';

export const HOOK_EVENT_PATH = '/api/hooks/event';

/**
 * Header carrying the sender's per-firing delivery id (WP-IN1). It exists
 * because a `Stop` payload is byte-identical on every turn, so content alone
 * cannot tell a recurrence from a redelivery - see hooks/envelope.ts. The
 * value is hashed into the idempotency key and NOTHING else: it is never
 * persisted, logged or echoed back.
 */
export const HOOK_DELIVERY_ID_HEADER = 'x-agenthropic-delivery-id';

/**
 * Upper bound on the header value. Anything longer is a 400 (the generic
 * Fastify validation message names the header, never its value) - an unbounded
 * client-controlled string must not reach the hash function.
 */
export const MAX_DELIVERY_ID_LENGTH = 200;

export interface HookRoutesOptions {
  /** The append-only events_raw port (SQLite in production, fake in tests). */
  readonly eventStore: EventStorePort;
  /** Injectable clock for deterministic tests; defaults to `new Date()`. */
  readonly now?: () => Date;
  /**
   * Optional liveness seam (WP-IN12). Invoked for EVERY delivered envelope,
   * including a redelivery whose append deduped to zero rows: the sender
   * retries exactly when it cannot know whether the first attempt finished, so
   * a crash between the committed append and this callback would otherwise
   * lose the terminal status forever (the retry would find `inserted: false`
   * and skip it). Re-applying is safe because the seam is a guarded no-op when
   * the agent already holds the status — no duplicate SSE transition is
   * published. A thrown append still skips it: nothing landed, nothing to say.
   *
   * Deliberately a callback rather than a db handle: the route stays a
   * transport, and the structure-free event-store port stays structure-free.
   * The composition root supplies `applyHookLiveness`, which is UPDATE-only by
   * construction (CD-1: hooks move liveness, never structure).
   */
  readonly applyStatus?: (hookName: string, payload: unknown) => void;
}

const HookAcceptedResponseSchema = Type.Object(
  { stored: Type.Boolean() },
  { additionalProperties: false },
);

/**
 * Bounds the delivery id at the edge. `additionalProperties: true` because
 * every other header (Authorization, Content-Type, ...) must pass through
 * untouched; only this one is constrained.
 */
const HookHeadersSchema = Type.Object(
  {
    [HOOK_DELIVERY_ID_HEADER]: Type.Optional(Type.String({ maxLength: MAX_DELIVERY_ID_LENGTH })),
  },
  { additionalProperties: true },
);

/**
 * Normalize the raw header value. A header sent twice arrives as an array:
 * an ambiguous delivery id is treated as ABSENT (the conservative collapse)
 * rather than guessing which firing it names. An empty value is absent too.
 */
export function readDeliveryId(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function registerHookRoutes(
  app: FastifyInstance,
  options: HookRoutesOptions,
): Promise<void> {
  const now = options.now ?? ((): Date => new Date());
  app.post(
    HOOK_EVENT_PATH,
    {
      // 400/500 declare the uniform { error } contract the ROOT-scope error
      // handler in buildServer produces for this route (it is registered on
      // the root scope, outside apiRoutes' scoped handler): 400 for header
      // validation failures, 500 for a throwing append/applyStatus
      // (SQLITE_BUSY/FULL, I/O) with the raw message suppressed.
      schema: {
        headers: HookHeadersSchema,
        response: {
          202: HookAcceptedResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      // Redact BEFORE the envelope so the idempotency key is computed over
      // the redacted payload: a redelivered event redacts identically and
      // still dedupes to zero new rows.
      const redacted = redactSecrets(request.body);
      const deliveryId = readDeliveryId(request.headers[HOOK_DELIVERY_ID_HEADER]);
      const { envelope, idempotencyKey } = buildHookEnvelope(
        redacted,
        now().toISOString(),
        deliveryId,
      );
      const result = options.eventStore.append({
        idempotencyKey,
        source: envelope.source,
        eventType: envelope.hookName,
        payload: envelope.payload,
        receivedAt: envelope.receivedAt,
      });
      // Unconditional on purpose — see the applyStatus option doc: a
      // redelivery after a crash-between-append-and-apply is the recovery
      // path, and the seam's same-status guard makes the common duplicate a
      // no-op.
      options.applyStatus?.(envelope.hookName, envelope.payload);
      return reply.code(202).send({ stored: result.inserted });
    },
  );
}
