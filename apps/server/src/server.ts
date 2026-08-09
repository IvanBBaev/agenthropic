/**
 * WP-U0 - Fastify server bootstrap. This is what turns the WP-F7 security
 * contract tests green:
 *
 * - a global onRequest hook (registered BEFORE any route) auth-gates every
 *   /api/* route with a timing-safe Bearer-token compare -> 401 otherwise;
 * - /api/stream may also present the token as `?token=` (EventSource cannot
 *   set headers), same timing-safe compare;
 * - /api/stream enforces same-origin: a present Origin header must be the
 *   loopback origin of this server, else 403. No wildcard CORS;
 * - realtime transport is SSE, never WebSocket.
 *
 * The token is held in a closure; it is never logged, never persisted, and
 * never echoed in any response.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { isAllowedOrigin, redactTokenInUrl, timingSafeTokenEqual } from '@agenthropic/shared';
import { apiRoutes } from './api/routes';
import type { SubstrateProvider } from './api/substrate-provider';
import type { SqliteDatabase } from './db/connection';
import { RealtimeHub } from './realtime/hub';

export interface BuildServerOptions {
  /** Mandatory auth token (already validated by loadConfig). */
  readonly token: string;
  /** Current schema version, surfaced by /api/health. */
  readonly schemaVersion: number;
  /** SSE heartbeat interval; small in tests, ~15s in production. */
  readonly heartbeatIntervalMs?: number;
  /** SSE reconnect hint sent as the `retry:` field. */
  readonly sseRetryMs?: number;
  readonly logger?: boolean;
  /**
   * Open, migrated database handle (WP-U2). When absent, the read API routes
   * are not registered and unknown /api/* paths 404 exactly as before.
   */
  readonly db?: SqliteDatabase;
  /**
   * Realtime hub whose published events fan out to /api/stream subscribers
   * (WP-U1). The orchestrator shares ONE hub between ingest and this server;
   * when absent a private hub is constructed so the stream still works.
   */
  readonly hub?: RealtimeHub;
  /**
   * Read-only corpus seam for the WP-C4/C5 cost-analysis endpoint. When
   * absent, that endpoint replies 503 and every other route is unaffected.
   */
  readonly substrateProvider?: SubstrateProvider;
}

const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    schemaVersion: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const STREAM_PATH = '/api/stream';

/** The subset of a request the log serializer reads. */
interface LoggableRequest {
  readonly method: string;
  readonly url: string;
}

/**
 * Request log serializer that scrubs the SSE `?token=` before it reaches any
 * log sink - the token can legitimately appear in the stream URL (EventSource
 * cannot set headers), so request logging must redact it.
 */
export function redactedRequestSerializer(request: LoggableRequest): {
  method: string;
  url: string;
} {
  return { method: request.method, url: redactTokenInUrl(request.url) };
}

/**
 * Build the Fastify `logger` option. Logging is OFF by default; when enabled,
 * the request serializer redacts the token so it never lands in a log line.
 */
export function buildLoggerOptions(logger: boolean): FastifyServerOptions['logger'] {
  if (!logger) {
    return false;
  }
  return { serializers: { req: redactedRequestSerializer } };
}

/**
 * Extract the presented token: `Authorization: Bearer <token>` everywhere;
 * the SSE stream may also use `?token=` because EventSource cannot set
 * headers. Returns undefined when no credential is presented.
 */
function extractToken(request: FastifyRequest, allowQueryToken: boolean): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  if (allowQueryToken) {
    // Fastify's `request.url` is a getter over `request.raw.url` - the SAME
    // string, but typed `string` rather than `string | undefined`, because the
    // router cannot dispatch a request that carries no URL. Reading it here
    // instead of reaching through `.raw` removes a `?? ''` arm that no test
    // could ever drive, so the branch figure stays a measurement rather than an
    // estimate. (Suppressing it with an ignore pragma would have been the other
    // option, and the wrong one: it drops BOTH arms from the denominator.)
    const url = request.url;
    const queryStart = url.indexOf('?');
    if (queryStart !== -1) {
      const queryToken = new URLSearchParams(url.slice(queryStart + 1)).get('token');
      if (queryToken !== null) {
        return queryToken;
      }
    }
  }
  return undefined;
}

export function buildServer(options: BuildServerOptions) {
  const { token, schemaVersion } = options;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const sseRetryMs = options.sseRetryMs ?? 3_000;
  const hub = options.hub ?? new RealtimeHub();

  const app: FastifyInstance = Fastify({ logger: buildLoggerOptions(options.logger ?? false) });
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();

  // Security gate - registered before ANY route so no /api/* route can ever
  // be reached unauthenticated.
  //
  // Authorize on the ROUTED path, never on the raw request URL. Fastify runs
  // onRequest AFTER routing, so `request.routeOptions.url` is the matched route
  // pattern (e.g. '/api/stream'). find-my-way percent-decodes the path before
  // matching, so gating on a raw-URL prefix check is bypassable with a request
  // like `/%61pi/health` (which the raw check reads as non-/api but the router
  // decodes to `/api/health`); the routed pattern is immune to that mismatch.
  app.addHook('onRequest', async (request, reply) => {
    const routedPath = request.routeOptions.url;
    if (routedPath === undefined || !routedPath.startsWith('/api/')) {
      return;
    }
    const isStream = routedPath === STREAM_PATH;
    if (isStream) {
      // Same-origin check first: a foreign Origin is rejected outright (403),
      // token or not - the browser attack surface is closed before auth.
      const localPort = request.raw.socket.localPort ?? 0;
      if (!isAllowedOrigin(request.headers.origin, localPort)) {
        return reply
          .code(403)
          .send({ error: 'Cross-origin access to the event stream is forbidden.' });
      }
    }
    const presented = extractToken(request, isStream);
    if (presented === undefined || !timingSafeTokenEqual(presented, token)) {
      return reply.code(401).send({ error: 'Unauthorized.' });
    }
  });

  typed.get('/api/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => ({
    status: 'ok' as const,
    schemaVersion,
  }));

  // Active SSE connections, so server shutdown closes them promptly.
  const activeStreams = new Set<() => void>();

  typed.get(STREAM_PATH, (request, reply) => {
    // SSE (CD-5: the canonical realtime transport - never WebSocket).
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write(`retry: ${sseRetryMs}\n\n`);
    // Subscribe BEFORE the ': connected' comment goes out: a client that has
    // seen 'connected' is provably subscribed to hub fan-out already.
    const unsubscribe = hub.subscribe((frame) => {
      raw.write(frame);
    });
    raw.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      raw.write(': heartbeat\n\n');
    }, heartbeatIntervalMs);
    const close = (): void => {
      unsubscribe();
      clearInterval(heartbeat);
      activeStreams.delete(close);
      raw.end();
    };
    activeStreams.add(close);
    request.raw.on('close', close);
  });

  app.addHook('onClose', (_instance, done) => {
    for (const close of [...activeStreams]) {
      close();
    }
    done();
  });

  // Read API routes exist only when a database handle was provided; they are
  // registered INSIDE this scope, so the auth gate above covers all of them.
  if (options.db !== undefined) {
    void app.register(apiRoutes, {
      db: options.db,
      substrateProvider: options.substrateProvider,
    });
  }

  return app;
}
