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

const Count = Type.Integer({ minimum: 0 });

/** Format drift on the records of one Claude Code version (R13). */
export const VersionFormatDriftSchema = Type.Object(
  {
    // Record `type` -> records whose type the corpus census of record has never seen.
    unknownRecordTypes: Type.Record(Type.String(), Count),
    // Usage key (`cache_creation.<key>` for a nested one) -> usage blocks carrying it.
    unknownUsageKeys: Type.Record(Type.String(), Count),
    // Non-synthetic assistant records whose usage reads as zero in every bucket.
    zeroUsageRecords: Count,
  },
  { additionalProperties: false },
);

export const HealthSchema = Type.Object(
  {
    // 'replaying' from the loopback bind until the startup replay has finished,
    // then 'ok' for the life of the process (owner decision, 2026-10-01). A
    // replay that a read error cut short has NOT finished: the scheduled poll
    // completes it, and the phase lasts until that sweep drains - or until the
    // next poll cannot read the corpus either, so it never lasts forever. The
    // server IS up and the token IS accepted in both states - a client must not
    // treat 'replaying' as an error, only as "the figures are still being
    // read in; ask again shortly". Every other condition (excluded sessions,
    // skipped files) stays a coverage fact and never changes this field.
    status: Type.Union([Type.Literal('ok'), Type.Literal('replaying')]),
    schemaVersion: Type.Integer({ minimum: 0 }),
    // Keys are SkipReason members - enforced at compile time by the
    // skipCounters seam type (`BuildServerOptions.skipCounters` in
    // `apps/server/src/server.ts`); the wire schema stays an open string
    // record so a new skip reason can never desync route schema from reporter.
    ingestSkips: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
    // 'replaying' between the loopback bind and the end of the startup replay
    // tick, 'idle' after (review M-16). AMENDED 2026-10-01: `status` now
    // mirrors the replay too ('replaying' / 'ok'), because a client that only
    // reads `status` - the token screen, the shell - was told 'ok' about a
    // server whose figures were still being read in. This field stays for the
    // probes that already read it.
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
    // R11 / OPS-5 (2026-11-08): the operational state `status` does not carry.
    // `status` keeps its two values so existing clients are unaffected; a probe
    // that wants "is it working, not just up" reads these instead.
    //
    // When the last corpus pass finished (ISO 8601). Omitted until one has, and
    // on a boot with ingest off. A value far older than the poll interval means
    // the watcher has stopped ticking.
    lastTickAt: Type.Optional(Type.String()),
    // The corpus trouble the poll loop is currently in: 'read-error' (the root
    // or a transcript could not be read) or 'no-corpus-root'. Omitted while
    // the last pass read the corpus cleanly, and on a boot with ingest off.
    corpusTrouble: Type.Optional(
      Type.Union([Type.Literal('read-error'), Type.Literal('no-corpus-root')]),
    ),
    // Newest successful database backup (ISO 8601): one this process wrote,
    // or else the newest `agenthropic-*.db` already in the backups directory
    // at boot. Omitted when there is none.
    lastBackupAt: Type.Optional(Type.String()),
    // Message of the most recent backup attempt, when that attempt failed.
    // Omitted once a later backup succeeds.
    lastBackupError: Type.Optional(Type.String()),
    // Size of the database file and of its WAL in bytes, read at request
    // time. `walBytes` is 0 when no WAL file exists.
    dbBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    walBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    // Hook deliveries since boot: stored (a new events_raw row), duplicate (a
    // redelivery that stored nothing), unauthorized (401: the hook holds a
    // stale or missing token), rejected (any other 4xx) and failed (5xx: the
    // append or the liveness update threw).
    hookDeliveries: Type.Optional(
      Type.Object(
        {
          stored: Type.Integer({ minimum: 0 }),
          duplicate: Type.Integer({ minimum: 0 }),
          unauthorized: Type.Integer({ minimum: 0 }),
          rejected: Type.Integer({ minimum: 0 }),
          failed: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    // R13 (ARC-6, QA-3, DAT-7, DAT-11): format-drift census over the stored
    // sessions, aggregated at request time from each session's latest parse.
    // The parser tolerates unknown record types and usage keys and skips a
    // non-JSON line; these counts are what keeps that tolerance from being
    // silent. A rise in `byClaudeCodeVersion` under a new version is the
    // signal that an upstream format change may be under-reporting tokens.
    // Always present: it is a stored fact, and all zeros is a real answer.
    formatDrift: Type.Optional(
      Type.Object(
        {
          // Sessions whose latest parse carried a census (hook-only sessions
          // and rows not re-parsed since the census existed are not counted).
          sessionsCensused: Count,
          // The subset with any skipped line or any drift.
          sessionsWithDrift: Count,
          // Non-JSON lines skipped across those sessions (DAT-7). Each may
          // have carried tokens, so a non-zero value makes totals a lower bound.
          malformedLinesSkipped: Count,
          // Claude Code version -> sessions whose transcripts carry it (DAT-11).
          claudeCodeVersions: Type.Record(Type.String(), Count),
          // Claude Code version -> drift summed over sessions; only versions
          // with drift appear.
          byClaudeCodeVersion: Type.Record(Type.String(), VersionFormatDriftSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type HealthDto = Static<typeof HealthSchema>;
export type FormatDriftDto = NonNullable<HealthDto['formatDrift']>;
export type VersionFormatDriftDto = Static<typeof VersionFormatDriftSchema>;
