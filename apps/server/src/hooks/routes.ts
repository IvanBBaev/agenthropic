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
import type { EventStorePort } from '@agenthropic/shared';
import { buildHookEnvelope } from './envelope';
import { redactSecrets } from './redact';

export const HOOK_EVENT_PATH = '/api/hooks/event';

export interface HookRoutesOptions {
  /** The append-only events_raw port (SQLite in production, fake in tests). */
  readonly eventStore: EventStorePort;
  /** Injectable clock for deterministic tests; defaults to `new Date()`. */
  readonly now?: () => Date;
}

const HookAcceptedResponseSchema = Type.Object(
  { stored: Type.Boolean() },
  { additionalProperties: false },
);

export async function registerHookRoutes(
  app: FastifyInstance,
  options: HookRoutesOptions,
): Promise<void> {
  const now = options.now ?? ((): Date => new Date());
  app.post(
    HOOK_EVENT_PATH,
    { schema: { response: { 202: HookAcceptedResponseSchema } } },
    async (request, reply) => {
      // Redact BEFORE the envelope so the idempotency key is computed over
      // the redacted payload: a redelivered event redacts identically and
      // still dedupes to zero new rows.
      const redacted = redactSecrets(request.body);
      const { envelope, idempotencyKey } = buildHookEnvelope(redacted, now().toISOString());
      const result = options.eventStore.append({
        idempotencyKey,
        source: envelope.source,
        eventType: envelope.hookName,
        payload: envelope.payload,
        receivedAt: envelope.receivedAt,
      });
      return reply.code(202).send({ stored: result.inserted });
    },
  );
}
