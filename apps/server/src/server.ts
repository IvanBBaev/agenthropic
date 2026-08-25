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
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { isAllowedOrigin, redactTokenInUrl, timingSafeTokenEqual } from '@agenthropic/shared';
import { apiRoutes } from './api/routes';
import type { SubstrateProvider } from './api/substrate-provider';
import type { SkipReason } from './corpus/fs-port';
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
  /**
   * Per-subscriber outbound backlog above which the stream is dropped, in
   * bytes. See `MAX_STREAM_BACKLOG_BYTES` for why a bound has to exist.
   */
  readonly maxStreamBacklogBytes?: number;
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
  /**
   * Cumulative ingest skip counters (review H-2): a skipped corpus file
   * freezes that session's dollar totals, so the running total must be
   * visible without log access. When absent (a server built without ingest
   * wiring) /api/health omits the field rather than faking a zero.
   */
  readonly skipCounters?: () => Readonly<Partial<Record<SkipReason, number>>>;
  /**
   * Boot ingest phase (review M-16). The composition root now binds the
   * listening socket BEFORE the startup replay tick, so there is a real window
   * in which the server answers but the corpus is still being re-read —
   * /api/health names it 'replaying' so a probe can tell "warming up" from
   * "idle and current". When absent (a server built without ingest wiring) the
   * field is omitted rather than faking a phase.
   */
  readonly ingestPhase?: () => 'replaying' | 'idle';
  /**
   * Wall-clock duration of the last completed watcher pass (review M-15).
   * Returns null while no pass has finished yet; /api/health then omits the
   * field — a fake 0 would read as "instant poll", the wrong fact. When the
   * seam itself is absent (a server built without ingest wiring) the field is
   * likewise omitted.
   */
  readonly tickDurationMs?: () => number | null;
  /**
   * Messages the M-12 cross-session ownership rule has skipped since boot. A
   * collision means real spend that this session's rows deliberately do NOT
   * carry (it is already counted once, under the session that ingested the
   * message first), so an operator comparing two sessions' totals needs to know
   * it happened; until now it existed only as a stderr line. When the seam is
   * absent the field is omitted; when it is present, a genuine 0 is reported.
   */
  readonly usageCollisions?: () => number;
  /**
   * Sessions the corpus has that ingest could not store, surfaced on
   * /api/health and as the `coverage` disclosure on /api/cost/summary.
   *
   * `reportIngestFailure` argues, correctly, that one poisoned session must not
   * make `status` anything but 'ok' — a server that is correctly surviving a bad
   * transcript is healthy. This does not contradict that: `status` stays 'ok'
   * and the failure is reported as a COUNT, exactly as `ingestSkips` and
   * `crossSessionUsageCollisions` already are. What the per-failure log line and
   * SSE event cannot do is answer the question an operator asks later — "is what
   * I am looking at complete?" — because both are moments, and this is a
   * standing fact. When absent (a server built without ingest wiring) both
   * fields are omitted rather than faking a zero.
   */
  readonly ingestExclusions?: () => { readonly failing: number; readonly quarantined: number };
}

const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    schemaVersion: Type.Integer({ minimum: 0 }),
    // Keys are SkipReason members - enforced at compile time by the
    // skipCounters seam type; the wire schema stays an open string record so
    // a new skip reason can never desync route schema from reporter.
    ingestSkips: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
    // 'replaying' between the loopback bind and the end of the startup replay
    // tick, 'idle' after (review M-16). `status` stays 'ok' throughout: a
    // replaying server is healthy, just not yet current.
    ingest: Type.Optional(Type.Union([Type.Literal('replaying'), Type.Literal('idle')])),
    // Duration of the last completed corpus pass (review M-15) — how long the
    // poll ACTUALLY takes, so an operator can see it approaching the poll
    // interval. Omitted until a pass has finished.
    lastTickDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
    // Messages skipped by the M-12 ownership rule since boot (review M-18) —
    // spend that IS counted, but under the session that ingested it first.
    crossSessionUsageCollisions: Type.Optional(Type.Integer({ minimum: 0 })),
    // Sessions whose latest ingest attempt failed — spend that is counted
    // NOWHERE, so every dollar total is missing it. `status` stays 'ok': the
    // server is surviving this correctly, it is just not complete.
    sessionsExcluded: Type.Optional(Type.Integer({ minimum: 0 })),
    // The subset that will not be retried until the session's bytes or the
    // pricing table change — the ones needing a human, typically a missing price.
    sessionsQuarantined: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const STREAM_PATH = '/api/stream';

/**
 * Ceiling on one subscriber's un-flushed outbound bytes, past which its stream
 * is closed.
 *
 * `raw.write()` on a socket the peer has stopped reading does not fail and does
 * not block - it buffers, in the server's heap, without limit. A laptop that
 * suspends mid-stream, a tab throttled to a stop, an SSH tunnel whose far end
 * died without a FIN: none of these produce a 'close' event, so nothing in the
 * fan-out ever reaps them, and every subsequent frame is appended to a backlog
 * for a reader that will never arrive. On a dashboard that fans out an event
 * per ingest tick, that grows for as long as the process lives. Unbounded
 * memory held for a dead peer is the failure mode being closed here.
 *
 * Dropping is safe precisely because SSE is a reconnecting transport: the
 * `retry:` field is written before any frame, so a browser that is merely slow
 * comes back on its own and the read API re-establishes its view. A client
 * cannot be repaired by holding its backlog - it can only be waited for, and
 * waiting is what costs the memory. 1 MiB is roughly a thousand event frames
 * behind: far past "briefly busy", far short of anything a healthy reader hits.
 */
const MAX_STREAM_BACKLOG_BYTES = 1024 * 1024;

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
  const maxStreamBacklogBytes = options.maxStreamBacklogBytes ?? MAX_STREAM_BACKLOG_BYTES;
  const hub = options.hub ?? new RealtimeHub();

  const app: FastifyInstance = Fastify({ logger: buildLoggerOptions(options.logger ?? false) });
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();

  // Uniform error contract for ROOT-scope routes. The hook receiver is
  // registered on this scope by the composition root (index.ts), OUTSIDE the
  // apiRoutes plugin whose scoped setErrorHandler covers only its own
  // encapsulation - without this handler a throwing event-store append
  // (SQLITE_BUSY/FULL, I/O) fell through to Fastify's default handler and
  // leaked the raw driver message in a shape matching no declared schema.
  // 5xx details stay server-side: the raw error goes to the log (a no-op
  // sink when logging is off), never to the client.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    let message = error.message;
    if (statusCode >= 500) {
      request.log.error(error);
      message = 'Internal server error.';
    }
    void reply.code(statusCode).send({ error: message });
  });

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

  typed.get('/api/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => {
    // "No pass yet" and "no seam" both OMIT the field — never a fake number.
    const lastTickDurationMs = options.tickDurationMs?.() ?? null;
    const exclusions = options.ingestExclusions?.();
    return {
      status: 'ok' as const,
      schemaVersion,
      ...(options.skipCounters === undefined ? {} : { ingestSkips: options.skipCounters() }),
      ...(options.ingestPhase === undefined ? {} : { ingest: options.ingestPhase() }),
      ...(lastTickDurationMs === null ? {} : { lastTickDurationMs }),
      ...(options.usageCollisions === undefined
        ? {}
        : { crossSessionUsageCollisions: options.usageCollisions() }),
      ...(exclusions === undefined
        ? {}
        : {
            sessionsExcluded: exclusions.failing,
            sessionsQuarantined: exclusions.quarantined,
          }),
    };
  });

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
    let closed = false;
    /**
     * One frame out, plus the backlog check that bounds a stalled peer.
     *
     * The check is AFTER the write, not before: a subscriber is judged on the
     * backlog it has actually accumulated, so a single large frame is never
     * refused - it goes out, and only a peer that then fails to drain it is
     * dropped. Reaping runs through the same `close` as a clean disconnect,
     * which is what makes the drop complete rather than partial: unsubscribing
     * alone would stop the frames while leaving the heartbeat timer and the
     * `activeStreams` entry alive, i.e. a leak in place of a leak.
     */
    const write = (chunk: string): void => {
      raw.write(chunk);
      if (raw.writableLength > maxStreamBacklogBytes) {
        // `discardBacklog`, because this is the one caller reaping a peer that
        // is provably not draining - see `close` for why `end()` cannot free it.
        close(true);
      }
    };
    // Subscribe BEFORE the ': connected' comment goes out: a client that has
    // seen 'connected' is provably subscribed to hub fan-out already.
    const unsubscribe = hub.subscribe(write);
    raw.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      // The heartbeat is the reaper for an IDLE stalled peer: with no events
      // to fan out, nothing else would ever call `write`, so a dead socket
      // holding a backlog would sit unexamined until the next ingest tick -
      // or forever, on a quiet corpus.
      write(': heartbeat\n\n');
    }, heartbeatIntervalMs);
    /**
     * Tear one stream down exactly once.
     *
     * A function DECLARATION, not a const: `write` above reaps through it and
     * is defined first, so `close` has to be hoisted into that closure.
     *
     * `discardBacklog` decides between the two ways a socket can be released,
     * and the distinction is the whole point of the backlog bound. `end()`
     * QUEUES a FIN behind whatever is still unsent; on a peer that has stopped
     * reading, nothing is ever sent, so the FIN never leaves, the socket stays
     * open and the buffered frames stay on the heap - the reap would unsubscribe
     * the stream and reclaim none of the memory it was triggered to reclaim.
     * `destroy()` drops the buffer and the socket immediately, which is the only
     * outcome that makes the bound mean anything.
     *
     * It is NOT the default. The other two callers are the peer's own 'close'
     * event - where the socket is already gone and `end()` is simply the tidy
     * release - and the shutdown sweep, where a peer that IS draining should be
     * allowed the frames already written to it rather than have them truncated.
     * Neither has a backlog to discard, so neither pays `destroy()`'s cost.
     */
    function close(discardBacklog = false): void {
      // Idempotent: reaping and the peer's own 'close' event can both fire,
      // and a second `unsubscribe()` on an already-dropped stream would be a
      // no-op only by luck of the hub's implementation.
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      activeStreams.delete(close);
      if (discardBacklog) {
        raw.destroy();
      } else {
        raw.end();
      }
    }
    activeStreams.add(close);
    // Wrapped, not passed directly: the 'close' event hands its listener no
    // arguments today, but a bare `close` would silently start discarding
    // backlogs the day it hands one a truthy first argument.
    request.raw.on('close', () => {
      close();
    });
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
      ingestExclusions: options.ingestExclusions,
    });
  }

  return app;
}
