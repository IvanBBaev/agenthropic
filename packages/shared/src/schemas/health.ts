/**
 * `GET /api/health` response - the liveness and ingest-visibility contract.
 *
 * This is the schema the server actually registers on the route (see
 * `apps/server/src/server.ts`), not a summary of it: the wire shape and this
 * file are one object. `status` and `schemaVersion` are the only required
 * fields. Every other field is OPTIONAL and its absence carries meaning - each
 * is backed by an ingest seam the composition root wires in only when ingest
 * is running, and "we did not ask" and "we asked and the answer is zero" are
 * different facts. An absent field is never a zero; the per-field comments
 * below say what each omission means.
 */
import { Type, type Static } from '@sinclair/typebox';

export const HealthSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    schemaVersion: Type.Integer({ minimum: 0 }),
    // Keys are SkipReason members - enforced at compile time by the
    // skipCounters seam type (`BuildServerOptions.skipCounters` in
    // `apps/server/src/server.ts`); the wire schema stays an open string
    // record so a new skip reason can never desync route schema from reporter.
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
    // Sessions whose latest ingest attempt failed. Each is absent from the
    // stored totals OR present there only at an older extent (a session
    // quarantined at the pricing gate after a clean ingest keeps its last good
    // pass - see the AMENDED note on /api/cost/summary in
    // `apps/server/src/api/routes.ts`), so every dollar total is a lower bound
    // while this is non-zero. `status` stays 'ok': the server is surviving
    // this correctly, it is just not complete. (Amended 2026-09-25 (OO): this
    // used to say "counted NOWHERE".)
    sessionsExcluded: Type.Optional(Type.Integer({ minimum: 0 })),
    // The subset that will not be retried until the session's bytes or the
    // pricing table change — the ones needing a human, typically a missing price.
    sessionsQuarantined: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type HealthDto = Static<typeof HealthSchema>;
