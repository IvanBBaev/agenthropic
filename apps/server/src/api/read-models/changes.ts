/**
 * WP-U11: "what changed across sessions" since an instant.
 *
 * Split out of `api/queries.ts` (ARC-4, 2026-11-19), which stays the public
 * entry point and re-exports this module. The cost and honesty rules that
 * govern every read here are documented at the top of that file.
 */
import { type ChangesDto, type LateIngestedDto, type SessionChangeKind } from '@agenthropic/shared';
import type { SqliteDatabase } from '../../db/connection';
import { COST_USD, UNPRICED, canonicalInstant, pricedCte } from './shared';

// ==========================================================================
// WP-U11 - "what changed across sessions" (CD-10 daily question 5).
//
// Appended as a self-contained region ON PURPOSE. It reads `sessions`,
// `agents` and `token_usage` only; it imports nothing from the cost-summary
// module (`cost.ts`) and shares no state with it, so the UNRATIFIED M-19
// `token_usage_rollup` reader cutover can be reverted wholesale without
// touching a line of this.
//
// THE TWO TIMESTAMP REGIMES, and why this code treats them differently.
//
//   `token_usage.occurred_at` is CANONICAL by construction: migration 15
//   rewrote every stored value and installed guard + canonicalizing triggers,
//   so `YYYY-MM-DDTHH:mm:ss.sssZ` is the only spelling the column can hold.
//   Text comparison is therefore chronological comparison, and the raw column
//   is compared directly - which also keeps `idx_token_usage_occurred_at_id`
//   usable on the one table that grows without bound.
//
//   `sessions.started_at`, `sessions.last_activity_at` and
//   `agents.first_seen_at` carry NO such guarantee for the rows already
//   stored. Ingest canonicalizes them before every write now, but no
//   migration rewrote older rows, and those do contain second-precision and
//   offset spellings.
//   Comparing those as raw text is silently wrong: '...T00:00:00Z' sorts
//   ABOVE '...T00:00:00.000Z' ('Z' > '.'), so a session would fall on the
//   wrong side of a boundary that names the very same instant. Every read of
//   those columns therefore goes through `strftime`, which normalizes the
//   spelling and folds a UTC offset onto the clock. A value `strftime` cannot
//   parse yields NULL and the row becomes UNDATED - counted in `coverage`,
//   never guessed into the window.
// ==========================================================================

/**
 * The key that places a session in a window: its last observed activity,
 * falling back to its start. NULL (either column absent, or the chosen one
 * unparseable) means the session cannot be placed in ANY window - it is
 * reported in `coverage.undatedSessions` instead of being quietly dated.
 */
const SESSION_CHANGED_AT = canonicalInstant('COALESCE(s.last_activity_at, s.started_at)');
const SESSION_STARTED_AT = canonicalInstant('s.started_at');
const AGENT_APPEARED_AT = canonicalInstant('first_seen_at');

/** `(since, until]` over the session key. */
const SESSION_WINDOW = `${SESSION_CHANGED_AT} > ? AND ${SESSION_CHANGED_AT} <= ?`;

/**
 * Accepted `since` spellings: a bare UTC date, or an ISO-8601 instant that
 * carries its zone. A time WITHOUT a zone designator is rejected rather than
 * assumed to be UTC - ECMAScript reads it as local time, so accepting it would
 * silently answer a question about a different window than the one asked.
 */
export const ISO_INSTANT_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2}))?$';

const ISO_INSTANT = new RegExp(ISO_INSTANT_PATTERN);

/**
 * Validate and canonicalize a `since` argument. Returns NULL for anything that
 * is not an unambiguous instant; the caller answers 400. Nothing is defaulted
 * and nothing is repaired - a silently corrected boundary answers a different
 * question than the one that was asked, with no sign that it did.
 *
 * One spelling IS normalized rather than rejected, because it is not a repair
 * but an exact synonym: ISO 8601's end-of-day `T24:00:00` (`.000` optional)
 * passes the pattern, `Date.parse` reads it as 00:00 of the NEXT day, and the
 * canonical result is echoed back to the client in `since`. `T23:59:60`,
 * `T23:60` and `T24:00:01` all fail `Date.parse` and answer 400. (Amended
 * 2026-09-25 (OO).)
 *
 * The calendar round-trip is not redundant with `Date.parse`: V8 rolls
 * '2026-02-30' forward to March 2 rather than rejecting it, so a request for a
 * day that does not exist would otherwise be answered for a different day.
 */
export function normalizeSinceInstant(raw: string): string | null {
  const datePart = raw.slice(0, 10);
  const dayOnly = new Date(`${datePart}T00:00:00.000Z`);
  const epochMs = Date.parse(raw);
  if (
    !ISO_INSTANT.test(raw) ||
    Number.isNaN(dayOnly.getTime()) ||
    dayOnly.toISOString().slice(0, 10) !== datePart ||
    Number.isNaN(epochMs)
  ) {
    return null;
  }
  const canonical = new Date(epochMs).toISOString();
  // An offset can push the instant past year 9999 or before year 0; the
  // canonical spelling is then '+010000-…' / '-000001-…', which sorts as TEXT
  // before every stored 4-digit-year instant and would turn the window
  // inside out. Such an instant has no comparable spelling - refuse it.
  return /^\d{4}-/.test(canonical) ? canonical : null;
}

/**
 * The window's upper boundary, taken from THE DATA rather than the clock.
 *
 * A wall-clock boundary would be wrong in the one direction that matters:
 * ingest lags event time, so `until = now` promises a window whose tail has
 * not been ingested yet, and a client chaining `since=until` would step over
 * those rows forever. The newest instant this endpoint can actually SEE - over
 * all three tables it reads - is the newest instant it can honestly promise.
 *
 * Clamped up to `since` so the window is never inverted: a `since` in the
 * future of the whole corpus yields the empty window `(since, since]`, which
 * is the truthful answer, not an error.
 */
function changesBoundary(db: SqliteDatabase, since: string): string {
  const row = db
    .prepare(
      `SELECT MAX(instant) AS latest FROM (
         SELECT MAX(${SESSION_CHANGED_AT}) AS instant FROM sessions s
         UNION ALL SELECT MAX(${AGENT_APPEARED_AT}) FROM agents
         UNION ALL SELECT MAX(occurred_at) FROM token_usage
       )`,
    )
    .get() as { readonly latest: string | null };
  return row.latest === null || row.latest < since ? since : row.latest;
}

interface ChangeClassRow {
  readonly total: number;
  readonly unknown_start: number;
  readonly new_count: number;
  readonly updated_count: number;
}

interface ChangedSessionRow {
  readonly id: string;
  readonly project_slug: string | null;
  readonly status: string | null;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly changed_at: string;
  readonly change_kind: SessionChangeKind;
}

interface WindowUsageRow {
  readonly session_id: string;
  readonly tokens: number;
  readonly cost_usd: number;
  readonly unpriced_tokens: number;
}

interface WindowAgentRow {
  readonly session_id: string;
  readonly appeared: number;
}

interface WindowTotalsRow {
  readonly tokens_added: number;
  readonly cost_added_usd: number;
  readonly unpriced_tokens_added: number;
  readonly tokens_outside: number;
}

interface ChangesCoverageRow {
  readonly undated_sessions: number;
  readonly undated_agents: number;
  readonly undated_usage_rows: number;
}

interface WindowMoney {
  readonly tokens: number;
  readonly cost: number;
  readonly unpriced: number;
}

/** A session with no usage dated inside the window added exactly nothing. */
const NO_WINDOW_MONEY: WindowMoney = { tokens: 0, cost: 0, unpriced: 0 };

/**
 * Every number in the answer, flattened for the sign/finiteness sweep below.
 */
function changeMeasurements(dto: ChangesDto): ReadonlyArray<readonly [string, number]> {
  const { totals, coverage } = dto;
  const entries: Array<readonly [string, number]> = [
    ['total', dto.total],
    ['totals.sessionsNew', totals.sessionsNew],
    ['totals.sessionsUpdated', totals.sessionsUpdated],
    ['totals.sessionsUnknownStart', totals.sessionsUnknownStart],
    ['totals.agentsAppeared', totals.agentsAppeared],
    ['totals.tokensAdded', totals.tokensAdded],
    ['totals.costAddedUsd', totals.costAddedUsd],
    ['totals.unpricedTokensAdded', totals.unpricedTokensAdded],
    ['totals.tokensAddedOutsideChangedSessions', totals.tokensAddedOutsideChangedSessions],
    ['coverage.undatedSessions', coverage.undatedSessions],
    ['coverage.undatedAgents', coverage.undatedAgents],
    ['coverage.undatedUsageRows', coverage.undatedUsageRows],
    ['ingestCursor', dto.ingestCursor],
  ];
  if (dto.lateIngested !== null) {
    entries.push(['lateIngested.after', dto.lateIngested.after]);
    entries.push(['lateIngested.total', dto.lateIngested.total]);
    entries.push(['lateIngested.next', dto.lateIngested.next]);
  }
  for (const session of dto.sessions) {
    entries.push([`session ${session.id} agentsAppeared`, session.agentsAppeared]);
    entries.push([`session ${session.id} tokensAdded`, session.tokensAdded]);
    entries.push([`session ${session.id} costAddedUsd`, session.costAddedUsd]);
    entries.push([`session ${session.id} unpricedTokensAdded`, session.unpricedTokensAdded]);
  }
  return entries;
}

/**
 * THE LOUD HALF of this endpoint's honesty contract.
 *
 * `ChangesResponseSchema`'s `minimum: 0` does NOTHING at runtime:
 * fast-json-stringify serializes TO a schema, it does not validate AGAINST
 * one, so a negative or non-finite figure would be served with a cheerful HTTP
 * 200. These invariants are therefore asserted in CODE, and a violation
 * REFUSES the answer (the plugin error handler turns the throw into a
 * detail-free 500) rather than serving a confident wrong number.
 *
 * Every check here is a statement that must hold for ANY window over ANY
 * database. None of them is a plausibility heuristic - a heuristic that fires
 * on real data would train an operator to ignore it.
 *
 * Exported so the checks can be exercised directly against hand-built
 * payloads: a violation is by construction unreachable through the queries
 * above, and a rule that is only ever asserted on data that cannot break it is
 * not a tested rule.
 */
export function assertChangesInvariants(dto: ChangesDto): void {
  const problems: string[] = [];
  const { totals } = dto;

  if (dto.until < dto.since) {
    problems.push(`the window is inverted: until ${dto.until} precedes since ${dto.since}`);
  }
  const classified = totals.sessionsNew + totals.sessionsUpdated + totals.sessionsUnknownStart;
  if (classified !== dto.total) {
    problems.push(
      `classified ${String(classified)} session(s) but the window holds ${String(dto.total)}`,
    );
  }
  if (dto.sessions.length > dto.limit) {
    problems.push(
      `page of ${String(dto.sessions.length)} exceeds the limit ${String(dto.limit)} it was capped at`,
    );
  }
  if (dto.sessions.length > dto.total) {
    problems.push(
      `page of ${String(dto.sessions.length)} exceeds the window total ${String(dto.total)}`,
    );
  }
  if (totals.unpricedTokensAdded > totals.tokensAdded) {
    problems.push(
      `unpriced ${String(totals.unpricedTokensAdded)} exceeds the ${String(totals.tokensAdded)} tokens it is drawn from`,
    );
  }
  if (totals.tokensAddedOutsideChangedSessions > totals.tokensAdded) {
    problems.push(
      `unattributed ${String(totals.tokensAddedOutsideChangedSessions)} exceeds the ${String(totals.tokensAdded)} tokens in the window`,
    );
  }

  const late = dto.lateIngested;
  if (late !== null) {
    if (late.sessionIds.length > late.total || late.sessionIds.length > dto.limit) {
      problems.push(
        `late-ingested page of ${String(late.sessionIds.length)} exceeds its total ${String(late.total)} or the limit ${String(dto.limit)}`,
      );
    }
    if (late.next > dto.ingestCursor) {
      problems.push(
        `late-ingested next ${String(late.next)} is past the ingest cursor ${String(dto.ingestCursor)}`,
      );
    }
    const inWindow = new Set(dto.sessions.map((session) => session.id));
    for (const id of late.sessionIds) {
      if (inWindow.has(id)) {
        problems.push(`session ${id} is both in the window and named late-ingested`);
      }
    }
  }

  let pageTokens = 0;
  for (const session of dto.sessions) {
    pageTokens += session.tokensAdded;
    if (session.changedAt <= dto.since || session.changedAt > dto.until) {
      problems.push(
        `session ${session.id} changed at ${session.changedAt}, outside (${dto.since}, ${dto.until}]`,
      );
    }
    if (session.unpricedTokensAdded > session.tokensAdded) {
      problems.push(`session ${session.id} reports more unpriced tokens than tokens`);
    }
  }
  if (pageTokens > totals.tokensAdded) {
    problems.push(
      `the page sums to ${String(pageTokens)} tokens, more than the window's ${String(totals.tokensAdded)}`,
    );
  }

  for (const [label, value] of changeMeasurements(dto)) {
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`${label} is ${String(value)}, which is not a countable quantity`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`/api/changes computed an impossible answer: ${problems.join('; ')}`);
  }
}

/**
 * S-1: the sessions stamped in `(after, cursor]` that the event-time window
 * `(since, until]` does not contain. An undated session is in no window, so it
 * counts as outside this one - the COALESCE turns the window's NULL verdict
 * into "not in it" rather than letting `NOT NULL` drop the row.
 */
function lateIngested(
  db: SqliteDatabase,
  since: string,
  until: string,
  after: number,
  cursor: number,
  limit: number,
): LateIngestedDto {
  const where = `s.ingest_seq > ? AND s.ingest_seq <= ? AND COALESCE(${SESSION_WINDOW}, 0) = 0`;
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM sessions s WHERE ${where}`)
    .get(after, cursor, since, until) as { total: number };
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.ingest_seq AS ingest_seq FROM sessions s
       WHERE ${where}
       ORDER BY s.ingest_seq ASC
       LIMIT ?`,
    )
    .all(after, cursor, since, until, limit) as Array<{ id: string; ingest_seq: number }>;
  const last = rows.at(-1);
  return {
    after,
    total,
    sessionIds: rows.map((row) => row.id),
    // When complete, `next` is the cursor even if `after` was above it (a
    // database restored from an older backup rewinds the clock): handing the
    // larger value back would silence the list until the clock caught up.
    next: rows.length < total && last !== undefined ? last.ingest_seq : cursor,
  };
}

/**
 * `GET /api/changes` - the delta between `since` and the newest instant this
 * database can vouch for, over the half-open window `(since, until]`.
 *
 * `totals` and `coverage` span the WHOLE window; `sessions` is one capped page
 * of it, ordered recent-first, with `total` saying how much of the window the
 * page shows. Summing a page would understate the window silently, so the two
 * are computed by separate queries rather than one being derived from the
 * other.
 */
export function getChanges(
  db: SqliteDatabase,
  since: string,
  limit: number,
  offset: number,
  after?: number,
): ChangesDto {
  // One read transaction, so the cursor, the window and the late list are
  // computed over ONE snapshot: without it an ingest landing between two of
  // the statements below could put a session in the window and in
  // `lateIngested` at once (S-1).
  return db.transaction(() => computeChanges(db, since, limit, offset, after))();
}

function computeChanges(
  db: SqliteDatabase,
  since: string,
  limit: number,
  offset: number,
  after: number | undefined,
): ChangesDto {
  // Read BEFORE the window: everything stamped up to this mark is either in
  // this answer's window or named in its `lateIngested`, and anything stamped
  // later is above the cursor the client sends next - at least once, never
  // zero times (S-1).
  const ingestCursor = (db.prepare('SELECT seq FROM ingest_clock').get() as { seq: number }).seq;
  const until = changesBoundary(db, since);

  // Classification is over the whole window, not the page. A NULL
  // `started_at` matches neither comparison (SQL NULL is not orderable), so it
  // lands in `unknown_start` and nowhere else - the three counts partition the
  // window exactly, which the invariant check then re-proves.
  const classes = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN ${SESSION_STARTED_AT} IS NULL THEN 1 ELSE 0 END), 0) AS unknown_start,
         COALESCE(SUM(CASE WHEN ${SESSION_STARTED_AT} > ? THEN 1 ELSE 0 END), 0) AS new_count,
         COALESCE(SUM(CASE WHEN ${SESSION_STARTED_AT} <= ? THEN 1 ELSE 0 END), 0) AS updated_count
       FROM sessions s
       WHERE ${SESSION_WINDOW}`,
    )
    .get(since, since, since, until) as ChangeClassRow;

  // Which sessions are on this page is knowable from `sessions` alone, so the
  // page is resolved BEFORE any usage row is priced - the house idiom from
  // `listSessions`, for the same reason: pricing the whole ledger to return
  // one page of it makes the endpoint scale with corpus size, not page size.
  const pageRows = db
    .prepare(
      `SELECT
         s.id AS id,
         s.project_slug AS project_slug,
         s.status AS status,
         s.started_at AS started_at,
         s.last_activity_at AS last_activity_at,
         ${SESSION_CHANGED_AT} AS changed_at,
         CASE
           WHEN ${SESSION_STARTED_AT} IS NULL THEN 'unknown'
           WHEN ${SESSION_STARTED_AT} > ? THEN 'new'
           ELSE 'updated'
         END AS change_kind
       FROM sessions s
       WHERE ${SESSION_WINDOW}
       ORDER BY ${SESSION_CHANGED_AT} DESC, s.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(since, since, until, limit, offset) as ChangedSessionRow[];

  const money = new Map<string, WindowMoney>();
  const appeared = new Map<string, number>();
  const ids = pageRows.map((row) => row.id);
  if (ids.length > 0) {
    const placeholders = `(${ids.map(() => '?').join(', ')})`;
    const usageRows = db
      .prepare(
        `WITH ${pricedCte(
          `WHERE tu.session_id IN ${placeholders} AND tu.occurred_at > ? AND tu.occurred_at <= ?`,
        )}
         SELECT
           session_id,
           SUM(tokens) AS tokens,
           ${COST_USD} AS cost_usd,
           ${UNPRICED} AS unpriced_tokens
         FROM priced
         GROUP BY session_id`,
      )
      .all(...ids, since, until) as WindowUsageRow[];
    for (const row of usageRows) {
      money.set(row.session_id, {
        tokens: row.tokens,
        cost: row.cost_usd,
        unpriced: row.unpriced_tokens,
      });
    }
    const agentRows = db
      .prepare(
        `SELECT session_id, COUNT(*) AS appeared
         FROM agents
         WHERE session_id IN ${placeholders}
           AND ${AGENT_APPEARED_AT} > ? AND ${AGENT_APPEARED_AT} <= ?
         GROUP BY session_id`,
      )
      .all(...ids, since, until) as WindowAgentRow[];
    for (const row of agentRows) {
      appeared.set(row.session_id, row.appeared);
    }
  }

  // Window totals over the LEDGER, independent of which sessions changed.
  // "How many tokens were added in this window" is a question about usage
  // rows, and scoping it to the changed-session set would understate it. The
  // residue that belongs to no changed session is measured rather than
  // dropped, so the per-session breakdown's shortfall is always explained.
  const totalsRow = db
    .prepare(
      `WITH ${pricedCte('WHERE tu.occurred_at > ? AND tu.occurred_at <= ?')}
       SELECT
         COALESCE(SUM(tokens), 0) AS tokens_added,
         COALESCE(${COST_USD}, 0) AS cost_added_usd,
         COALESCE(${UNPRICED}, 0) AS unpriced_tokens_added,
         COALESCE(SUM(CASE WHEN session_id IN (
           SELECT s.id FROM sessions s WHERE ${SESSION_WINDOW}
         ) THEN 0 ELSE tokens END), 0) AS tokens_outside
       FROM priced`,
    )
    .get(since, until, since, until) as WindowTotalsRow;

  const agentsAppeared = (
    db
      .prepare(
        `SELECT COUNT(*) AS appeared FROM agents
         WHERE ${AGENT_APPEARED_AT} > ? AND ${AGENT_APPEARED_AT} <= ?`,
      )
      .get(since, until) as WindowAgentRow
  ).appeared;

  const coverage = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions s WHERE ${SESSION_CHANGED_AT} IS NULL) AS undated_sessions,
         (SELECT COUNT(*) FROM agents WHERE ${AGENT_APPEARED_AT} IS NULL) AS undated_agents,
         (SELECT COUNT(*) FROM token_usage WHERE occurred_at IS NULL) AS undated_usage_rows`,
    )
    .get() as ChangesCoverageRow;

  const dto: ChangesDto = {
    since,
    until,
    interval: '(since, until]',
    basis: 'event-time',
    ingestCursor,
    lateIngested:
      after === undefined ? null : lateIngested(db, since, until, after, ingestCursor, limit),
    sessions: pageRows.map((row) => {
      const added = money.get(row.id) ?? NO_WINDOW_MONEY;
      return {
        id: row.id,
        projectSlug: row.project_slug,
        status: row.status,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
        changedAt: row.changed_at,
        change: row.change_kind,
        agentsAppeared: appeared.get(row.id) ?? 0,
        tokensAdded: added.tokens,
        costAddedUsd: added.cost,
        unpricedTokensAdded: added.unpriced,
      };
    }),
    totals: {
      sessionsNew: classes.new_count,
      sessionsUpdated: classes.updated_count,
      sessionsUnknownStart: classes.unknown_start,
      agentsAppeared,
      tokensAdded: totalsRow.tokens_added,
      costAddedUsd: totalsRow.cost_added_usd,
      unpricedTokensAdded: totalsRow.unpriced_tokens_added,
      tokensAddedOutsideChangedSessions: totalsRow.tokens_outside,
    },
    coverage: {
      undatedSessions: coverage.undated_sessions,
      undatedAgents: coverage.undated_agents,
      undatedUsageRows: coverage.undated_usage_rows,
    },
    total: classes.total,
    limit,
    offset,
  };
  assertChangesInvariants(dto);
  return dto;
}
