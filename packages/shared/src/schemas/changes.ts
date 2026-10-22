/**
 * WP-U11 - the "what changed across sessions" DTO (CD-10 daily question 5).
 *
 * The other eight read endpoints answer a question about a STATE. This one
 * answers a question about a DELTA, so its whole contract is about the window
 * it covers - and about being explicit where a window cannot be honest:
 *
 * - the window is HALF-OPEN, `(since, until]`. A client chains the next call
 *   with `since=until` and never double-counts an instant; it misses nothing
 *   that was already ingested when the previous call ran (see `basis` below
 *   for what arrives later). The
 *   spelling is served in `interval` rather than left to documentation,
 *   because an off-by-one on the boundary is exactly the class of error that
 *   is invisible in a payload of plausible numbers.
 * - `until` is derived from the DATA, never from the wall clock. Ingest lags
 *   event time, so a clock-derived boundary would systematically hand back a
 *   window whose tail has not been ingested yet - and a client chaining from
 *   it would never see those rows at all.
 * - `basis` names WHICH time the window is over: event time (when the work
 *   happened), not ingest time (when this database learned of it). The
 *   database stores no ingest timestamp, so a session whose activity predates
 *   `since` but which was ingested afterwards is NOT in the window. That is a
 *   The window alone therefore cannot be complete; the ingest cursor below
 *   closes that gap (S-1).
 * - `ingestCursor` is the database's ingest high-water mark: every session
 *   carries an `ingest_seq` stamped each time this database learns something
 *   new about it (the session row, or one of its agents, usage rows or spawn
 *   edges, inserted or materially changed). A chaining client passes the
 *   previous `ingestCursor` back as `after`, and `lateIngested` then names the
 *   sessions that changed in ingest order since that call but are NOT in this
 *   event-time window - exactly the ones the window would have missed. Delivery
 *   is at-least-once: a session ingested while an answer is being computed can
 *   appear in that answer's window AND in the next call's `lateIngested`, so a
 *   client dedupes by session id.
 * - `coverage` counts the rows that no window can ever contain, because they
 *   carry no usable timestamp at all. They are disclosed, never dropped
 *   silently and never folded into the window as if they had been dated.
 */
import { Type, type Static } from '@sinclair/typebox';
import { nullable } from './common';

/**
 * How a session came to be in the window.
 *
 * `unknown` is a first-class member and NOT a synonym for `updated`: it is
 * what a session reports when its `started_at` is absent or unparseable, so
 * nothing here can tell whether the window is its first appearance. Guessing
 * `updated` (or `new`) would turn "we do not know" into a confident count.
 */
export const SessionChangeKindSchema = Type.Union([
  Type.Literal('new'),
  Type.Literal('updated'),
  Type.Literal('unknown'),
]);

export type SessionChangeKind = Static<typeof SessionChangeKindSchema>;

/**
 * One session that changed inside the window.
 *
 * `startedAt` / `lastActivityAt` are served VERBATIM as stored; `changedAt` is
 * the derived key that placed the session in this window - the canonicalized
 * `last_activity_at`, falling back to `started_at`. Keeping the derived value
 * separate from the stored ones is what lets a caller check the placement
 * instead of trusting it.
 *
 * The token and dollar figures are scoped to the window, not to the session's
 * lifetime: they are what this window ADDED. Every dollar is tokens x a dated
 * `model_pricing` rate, and tokens for which no rate resolves are reported in
 * `unpricedTokensAdded` and contribute $0 - the same honesty rule the rest of
 * the read layer follows.
 */
export const ChangedSessionSchema = Type.Object(
  {
    id: Type.String(),
    projectSlug: nullable(Type.String()),
    status: nullable(Type.String()),
    startedAt: nullable(Type.String()),
    lastActivityAt: nullable(Type.String()),
    changedAt: Type.String(),
    change: SessionChangeKindSchema,
    agentsAppeared: Type.Integer({ minimum: 0 }),
    tokensAdded: Type.Integer({ minimum: 0 }),
    costAddedUsd: Type.Number({ minimum: 0 }),
    unpricedTokensAdded: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ChangedSessionDto = Static<typeof ChangedSessionSchema>;

/**
 * Window-wide totals. These span the WHOLE window, not the returned page - a
 * page is capped, and summing a capped page would understate the answer
 * silently. `total` on the response says how many sessions the window holds;
 * `sessions` says which ones this page shows.
 *
 * `tokensAddedOutsideChangedSessions` is the residue: usage rows dated inside
 * the window whose session did NOT change inside it (its `last_activity_at`
 * lags its own ledger). It is normally 0. When it is not, the per-session
 * breakdown does not add up to `tokensAdded`, and this field is the reason -
 * stated, rather than left for a caller to discover as an arithmetic mystery.
 */
export const ChangeTotalsSchema = Type.Object(
  {
    sessionsNew: Type.Integer({ minimum: 0 }),
    sessionsUpdated: Type.Integer({ minimum: 0 }),
    sessionsUnknownStart: Type.Integer({ minimum: 0 }),
    agentsAppeared: Type.Integer({ minimum: 0 }),
    tokensAdded: Type.Integer({ minimum: 0 }),
    costAddedUsd: Type.Number({ minimum: 0 }),
    unpricedTokensAdded: Type.Integer({ minimum: 0 }),
    tokensAddedOutsideChangedSessions: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ChangeTotalsDto = Static<typeof ChangeTotalsSchema>;

/**
 * What this answer structurally CANNOT see, counted rather than described.
 *
 * A row with no usable timestamp falls outside every window that will ever be
 * asked for - not just this one. Reporting the counts makes the blind spot a
 * number the operator can watch, instead of an absence they cannot.
 */
export const ChangesCoverageSchema = Type.Object(
  {
    /** Sessions whose `last_activity_at` and `started_at` yield no instant. */
    undatedSessions: Type.Integer({ minimum: 0 }),
    /** Agents whose `first_seen_at` yields no instant. */
    undatedAgents: Type.Integer({ minimum: 0 }),
    /** `token_usage` rows with a NULL `occurred_at` - unwindowable AND unpriceable. */
    undatedUsageRows: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ChangesCoverageDto = Static<typeof ChangesCoverageSchema>;

/**
 * Sessions the database learned something new about since the client's `after`
 * cursor, which this event-time window does NOT contain (S-1).
 *
 * Ordered by ingest sequence, oldest first, and capped at the request's
 * `limit` - `offset` pages the window, not this list. `total` counts the whole
 * set; when `sessionIds` is shorter, `next` is the ingest sequence of the last
 * id returned, so passing it as the next `after` resumes the list exactly.
 * Otherwise `next` equals the response's `ingestCursor`. The ids are a pointer,
 * not a delta: the session itself is read from /api/sessions/:id.
 */
export const LateIngestedSchema = Type.Object(
  {
    /** The `after` cursor this list was computed from. */
    after: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    sessionIds: Type.Array(Type.String()),
    /** The `after` to send next. */
    next: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type LateIngestedDto = Static<typeof LateIngestedSchema>;

/** `GET /api/changes` response. */
export const ChangesResponseSchema = Type.Object(
  {
    /** The requested `since`, normalized to the canonical spelling. */
    since: Type.String(),
    /**
     * The server's boundary for this answer; chain the next call with `since=until`.
     * Event time: a session ingested after this call with older events is not
     * in the chained call's window - pass `ingestCursor` as `after` to have it
     * named in `lateIngested` instead (see the module header).
     */
    until: Type.String(),
    /** The window's half-open spelling, served so it cannot be misread. */
    interval: Type.Literal('(since, until]'),
    /** Which clock the window is over; ingest order is served separately below. */
    basis: Type.Literal('event-time'),
    /** The ingest high-water mark at answer time; send it back as `after`. */
    ingestCursor: Type.Integer({ minimum: 0 }),
    /** Present only when the request carried `after`; null otherwise. */
    lateIngested: nullable(LateIngestedSchema),
    sessions: Type.Array(ChangedSessionSchema),
    totals: ChangeTotalsSchema,
    coverage: ChangesCoverageSchema,
    /** Sessions changed in the whole window - `sessions` is one capped page of it. */
    total: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1 }),
    offset: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ChangesDto = Static<typeof ChangesResponseSchema>;
