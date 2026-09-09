/**
 * WP-U11 - the "what changed across sessions" DTO (CD-10 daily question 5).
 *
 * The other eight read endpoints answer a question about a STATE. This one
 * answers a question about a DELTA, so its whole contract is about the window
 * it covers - and about being explicit where a window cannot be honest:
 *
 * - the window is HALF-OPEN, `(since, until]`. A client chains the next call
 *   with `since=until` and neither misses nor double-counts an instant. The
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
 *   real limitation of the answer; it is named here rather than papered over.
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

/** `GET /api/changes` response. */
export const ChangesResponseSchema = Type.Object(
  {
    /** The requested `since`, normalized to the canonical spelling. */
    since: Type.String(),
    /** The server's boundary for this answer; chain the next call with `since=until`. */
    until: Type.String(),
    /** The window's half-open spelling, served so it cannot be misread. */
    interval: Type.Literal('(since, until]'),
    /** Which clock the window is over. Ingest time is not stored, so it is not offered. */
    basis: Type.Literal('event-time'),
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
