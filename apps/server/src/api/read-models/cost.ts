/**
 * Cost rollup reads: the corpus cost summary, per-session cost and its cache.
 *
 * Split out of `api/queries.ts` (ARC-4, 2026-11-19), which stays the public
 * entry point and re-exports this module. The cost and honesty rules that
 * govern every read here are documented at the top of that file.
 */
import { type CostSummaryDto } from '@agenthropic/shared';
import type { SqliteDatabase } from '../../db/connection';
import { COST_USD, pricedCte } from './shared';
import { type HonestyRow, toHonesty } from './sessions';

/**
 * One `token_usage_rollup` row as the cost read consumes it (WP-U4 / M-19).
 *
 * `rate_effective_from` is the rollup's stored pointer at the `model_pricing`
 * row that WON the dated-rate resolution when the ledger row was written - or
 * '' for "no rate was in force". `bucket` is carried because the rate is keyed
 * by (model, bucket): it never reaches the DTO, it only completes the price
 * lookup.
 */
interface CostRollupRow {
  readonly session_id: string;
  readonly model: string;
  readonly bucket: string;
  readonly day: string;
  readonly rate_effective_from: string;
  readonly tokens: number;
}

interface CostBucket {
  tokens: number;
  costUsd: number;
  unpricedTokens: number;
}

function accumulate(into: Map<string, CostBucket>, key: string, add: CostBucket): void {
  const bucket = into.get(key) ?? { tokens: 0, costUsd: 0, unpricedTokens: 0 };
  bucket.tokens += add.tokens;
  bucket.costUsd += add.costUsd;
  bucket.unpricedTokens += add.unpricedTokens;
  into.set(key, bucket);
}

/** A `model_pricing` row with its join key derived exactly as migration 16 derives it. */
interface CanonicalPriceRow {
  readonly model: string;
  readonly bucket: string;
  readonly usd_per_mtok: unknown;
  readonly canonical_effective_from: string;
}

/**
 * Map key for a resolved price. The separator is U+0000, written as a JS
 * ESCAPE SEQUENCE and never as a literal control byte in this file: it is the
 * one code unit that cannot occur in a model id, a bucket name or an ISO-8601
 * instant, so ('a|b', 'c') and ('a', 'b|c') can never collide into one key.
 */
function rateKey(model: string, bucket: string, effectiveFrom: string): string {
  return [model, bucket, effectiveFrom].join('\u0000');
}

/**
 * The whole of `model_pricing` (~40 rows) as a lookup keyed by the rollup's
 * stored join key.
 *
 * `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` is applied here for the same reason
 * migration 16 applies it when WRITING `rate_effective_from`: deriving both
 * sides of the join through the identical expression makes them incapable of
 * drifting, even though migrations 14 and 15 already guarantee the stored text
 * is canonical. The `COALESCE` back to the raw text mirrors migration 16's
 * `at()` fallback and keeps the key total - a row whose `effective_from` is not
 * a date at all (unstorable through SQL since migration 14's guard trigger)
 * simply gets a key that no rollup row can ever name.
 *
 * A duplicate key is a LOUD THROW, not a last-one-wins overwrite. Two
 * `model_pricing` rows for one (model, bucket) that canonicalize to the same
 * instant would make a SQL LEFT JOIN emit the rollup row twice and DOUBLE its
 * dollars silently; there is no honest cost to report from that state, so the
 * read refuses to produce one. Migration 14's canonicalizing triggers make it
 * unreachable through SQL - the collision aborts on the primary key - so this
 * arm is a corruption tripwire, and the equivalence suite reaches it only by
 * dropping those triggers first.
 */
/**
 * A stored rate usable for pricing, or NULL (unpriced). Mirrors the validity
 * rule in `pricedCte` so the rollup-backed summary and the SQL-priced routes
 * agree: only a finite, non-negative number prices tokens. `usd_per_mtok` has
 * REAL affinity but no value guard, so text, negatives and infinity can be
 * stored; none of them may reach a money field.
 */
function usableRate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readRateTable(db: SqliteDatabase): Map<string, number | null> {
  const rows = db
    .prepare(
      `SELECT model, bucket, usd_per_mtok,
              COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', effective_from), effective_from)
                AS canonical_effective_from
         FROM model_pricing`,
    )
    .all() as CanonicalPriceRow[];
  const rates = new Map<string, number | null>();
  for (const row of rows) {
    const key = rateKey(row.model, row.bucket, row.canonical_effective_from);
    if (rates.has(key)) {
      throw new Error(
        `model_pricing holds two rows for model=${row.model} bucket=${row.bucket} ` +
          `effective_from=${row.canonical_effective_from} after canonicalization. ` +
          'Cost cannot be reported unambiguously; refusing to guess.',
      );
    }
    rates.set(key, usableRate(row.usd_per_mtok));
  }
  return rates;
}

/**
 * The rate a priced rollup row was rolled up under.
 *
 * A miss means the rollup names a `model_pricing` row that is not there - and
 * the rollup's maintenance triggers recompute the whole (model, bucket) slice
 * on every pricing INSERT, UPDATE and DELETE, so in a live database this cannot
 * happen. It is therefore a torn-invariant report, never a reason to fall back
 * to $0: silently counting those tokens as unpriced would present real, priced
 * spend as unknown and hide the broken table that caused it.
 */
function rateFor(rates: Map<string, number | null>, row: CostRollupRow): number | null {
  const rate = rates.get(rateKey(row.model, row.bucket, row.rate_effective_from));
  if (rate === undefined) {
    throw new Error(
      `token_usage_rollup names a model_pricing row that does not exist: model=${row.model} ` +
        `bucket=${row.bucket} effective_from=${row.rate_effective_from}. ` +
        'The rollup is out of step with pricing; refusing to report a cost from it.',
    );
  }
  return rate;
}

/**
 * Tie-break on a grouping key. SQLite orders TEXT with BINARY collation, so
 * this compares code units rather than locale. Every caller passes keys of a
 * `Map`, which are unique by construction, so equality has no arm.
 */
export function byBinary(a: string, b: string): number {
  return a < b ? -1 : 1;
}

export interface SessionCostRow {
  readonly sessionId: string;
  readonly costUsd: number;
}

/**
 * WP-A5 - priced cost of every session active at or after `sinceIso` whose
 * cost is at least `minCostUsd`, ordered by session id. The `cost_threshold`
 * rule's input: it reuses the dashboard's own `pricedCte`, so an alert fires
 * on exactly the figure the session page shows (unpriced rows add $0, never
 * a guess). Scoped to the active sessions before pricing, so a tick costs
 * O(recent usage), not O(corpus).
 */
export function listSessionCostsAtLeast(
  db: SqliteDatabase,
  sinceIso: string,
  minCostUsd: number,
): SessionCostRow[] {
  const rows = db
    .prepare(
      `WITH ${pricedCte('WHERE tu.session_id IN (SELECT id FROM sessions WHERE last_activity_at >= ?)')}
       SELECT session_id, ${COST_USD} AS cost_usd
       FROM priced
       GROUP BY session_id
       HAVING ${COST_USD} >= ?
       ORDER BY session_id`,
    )
    .all(sinceIso, minCostUsd) as Array<{ session_id: string; cost_usd: number }>;
  return rows.map((row) => ({ sessionId: row.session_id, costUsd: row.cost_usd }));
}

/**
 * Whether the database holds a row for this session - the one fact the
 * cost-analysis route needs from it before it turns to the corpus (see the
 * rejected-session rule there). A primary-key probe, nothing more.
 */
export function sessionExists(db: SqliteDatabase, sessionId: string): boolean {
  return db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined;
}

/**
 * The persisted project slug for one session, or null when the session is
 * unknown (or was ingested without a slug). The substrate provider takes this
 * as its `slugOf` LOCATION HINT: the value is re-vetted against corpus
 * containment before any path is touched, and every miss falls back to full
 * enumeration — so a stale value can only cost a lookup its speed, never its
 * answer or its containment.
 */
export function getSessionProjectSlug(db: SqliteDatabase, sessionId: string): string | null {
  const row = db.prepare('SELECT project_slug FROM sessions WHERE id = ?').get(sessionId) as
    { project_slug: string | null } | undefined;
  return row === undefined ? null : row.project_slug;
}

/** The columns whose content the pricing fingerprint must not miss. */
interface PricingFingerprintRow {
  readonly model: string;
  readonly bucket: string;
  readonly usd_per_mtok: number;
  readonly effective_from: string;
}

interface CostSummaryCacheEntry {
  readonly stateKey: string;
  readonly topN: number;
  readonly summary: CostSummaryDto;
}

/**
 * One cached summary per live connection handle. A WeakMap so production (one
 * handle) holds exactly one entry, test suites with many temp databases can
 * never bleed cached dollars into each other, and entries die with their
 * connection. One entry — not an LRU over topN values — is a PROVISIONAL
 * policy: the dashboard issues one topN per view, so a second slot has no
 * known consumer yet.
 */
/**
 * OPS-14: a session's skipped non-JSON line count, from the format census the
 * parser stores (DAT-7/R13). Anything but a non-negative integer reads as 0,
 * matching the census reader behind `/api/health` `formatDrift`, which drops a
 * census it cannot read instead of guessing at it. `format_census` is
 * `json_valid` by its CHECK constraint, so `json_type` cannot throw here.
 */
const MALFORMED_LINES_SQL = `CASE
    WHEN json_type(format_census, '$.malformedLines') = 'integer'
     AND json_extract(format_census, '$.malformedLines') > 0
    THEN json_extract(format_census, '$.malformedLines') ELSE 0 END`;

const costSummaryCache = new WeakMap<SqliteDatabase, CostSummaryCacheEntry>();

/**
 * Execution-count seam for the cache tests: `onScan` fires exactly when the
 * read actually runs — on every cache MISS and on no cache hit — so a test can
 * prove a hit skipped the work by COUNTING, never by timing.
 *
 * M-19 kept the seam and its meaning while changing what it counts. Before the
 * cutover it counted a full priced scan of `token_usage`; it now counts the
 * `model_pricing` read plus the ordered scan of `token_usage_rollup`. In both
 * eras it also covers everything downstream of that read — the JS regroup, the
 * three sorts and the top-N slug lookup — because all of it sits below this
 * call and none of it runs on a hit. So the count still equals the whole of
 * the work a cache hit avoids: the probe reports no scan that has stopped
 * happening and hides none that still does.
 *
 * What it deliberately does NOT count is {@link costSummaryStateKey}, which
 * runs BEFORE the hit test and therefore on every request, hit or miss.
 */
export interface CostSummaryProbe {
  onScan(): void;
}

/**
 * Cheap self-validating state key for the cost-summary cache, recomputed on
 * every request. Since M-19 the cached dollars are computed from
 * `token_usage_rollup`, `sessions` (slug lookup) and `model_pricing` — and the
 * rollup is a trigger-maintained projection of `token_usage`, so a change to
 * the ledger is still a change to the answer. The key must therefore move
 * whenever any of those can have changed:
 *
 * - `total_changes()` counts every row this CONNECTION has inserted, updated
 *   or deleted, across all tables — verified empirically against
 *   better-sqlite3 (2026-08-12): ingest INSERTs, retention DELETEs and even
 *   an in-place UPDATE rewriting identical values all bump it. That covers
 *   `token_usage`, the rollup rows migration 16's triggers write behind it
 *   (a trigger's writes count as this connection's — re-verified 2026-08-31:
 *   one INSERT firing one trigger INSERT moves total_changes by 2) and
 *   `sessions` on the normal path, because this server process is the one
 *   writer by design (ingest and retention run on this same handle).
 * - `total_changes()` is blind to OTHER connections (also verified). Until
 *   API-6 a second writer to the ledger was declared out of threat scope;
 *   that was a blind spot, not a defence, so `PRAGMA data_version` now rides
 *   in the key too. SQLite bumps it on this connection whenever ANY OTHER
 *   connection commits to the database file (and never for this connection's
 *   own writes, which `total_changes()` already covers), so a foreign
 *   `token_usage` INSERT, a manual sqlite3 repair or a restore-then-write all
 *   invalidate the cache on the next read — proven by the API-6 test, which
 *   inserts through a second handle and shows this one's change counter did
 *   not move. It costs one pragma read per request.
 * - `model_pricing` still rides in the key verbatim, ~40 rows (PROVISIONAL:
 *   the WP-C1 seed plus migrations 18-20). `data_version` would catch the
 *   operator's sqlite3-CLI repricing as well, but the fingerprint also
 *   guards a same-connection path `total_changes()` cannot see: a rate
 *   written through a migration or a future admin route lands on THIS handle
 *   and still reprices every rollup slice behind the cache. Its triggers
 *   fire on that other connection too, so the content, not a counter, is
 *   what makes any repricing visible here regardless of who wrote it.
 *
 * The fingerprint is serialized in JS over an ORDER BY'd SELECT rather than
 * SQL group_concat, whose concatenation order SQLite does not guarantee.
 * False invalidations (e.g. an unrelated `events` INSERT, or a rolled-back
 * write — total_changes counts those too) merely recompute; outside an open
 * transaction the design errs only in the never-stale direction.
 *
 * INSIDE one it does not, and the qualifier above is load-bearing. MEASURED
 * 2026-08-31: `total_changes()` is monotonic and a ROLLBACK never moves it
 * back, so a summary computed and cached INSIDE a transaction or SAVEPOINT
 * keeps a key that is still current after that transaction is rolled back —
 * and the next read is a HIT serving dollars derived from rows that no longer
 * exist. Reproduced by deleting rollup rows inside a savepoint, reading (which
 * caches the post-delete answer), rolling back, and reading again: the second
 * read still reports the deleted state. This is NOT a cutover regression — the
 * pre-M-19 memo had the same key and the same hole — and it is not reachable
 * through the server, because better-sqlite3 is synchronous and no HTTP
 * handler can run inside ingest's or retention's transaction on this handle.
 * It is written down rather than fixed because the fix is a behaviour change
 * to an UNRATIFIED read path; anything that starts calling a query function
 * from inside a transaction must revisit it first.
 *
 * The never-stale direction is the right one to err in, but be honest about
 * its price: on a server with ingest running, a false invalidation is the
 * NORM, not the exception — every poll tick that writes anything at all moves
 * this key. So this key makes the cache correct for every read the server
 * actually performs; it was never what bounded the read, and after M-19 it
 * does not have to be — what bounds the read is the persisted rollup
 * {@link getCostSummary} now scans. See the note there.
 */
function costSummaryStateKey(db: SqliteDatabase): string {
  const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  // API-6: moves on any OTHER connection's commit; see the note above.
  const dataVersion = db.pragma('data_version', { simple: true }) as number;
  return `${changes}|${String(dataVersion)}|${pricingFingerprint(db)}`;
}

/** The `model_pricing` table, serialized in a fixed order (see above). */
export function pricingFingerprint(db: SqliteDatabase): string {
  const pricing = db
    .prepare(
      `SELECT model, bucket, usd_per_mtok, effective_from
       FROM model_pricing
       ORDER BY model, bucket, effective_from`,
    )
    .all() as PricingFingerprintRow[];
  return JSON.stringify(pricing);
}

export function getCostSummary(
  db: SqliteDatabase,
  topN: number,
  probe?: CostSummaryProbe,
): CostSummaryDto {
  // M-19 — THE CUTOVER. This read is bounded by the persisted rollup.
  //
  // History, so the shape below is not mistaken for an accident. This function
  // used to price and group ALL of `token_usage` on every cold read, and
  // the signed v1.0 retention policy (D3, 2026-09-08) never prunes
  // `token_usage` — cost history IS the product — so it grows with corpus age
  // forever. (The DELETE mechanism exists in `db/retention-queries.ts` and
  // runs only if an operator configures a rule; the policy, not the code,
  // is what refuses it.) The
  // one-entry memo below widened the cache's hit window but never bounded the
  // read: `total_changes()` moves on essentially every ingest tick, so on an
  // actively ingesting server nearly every /api/cost/summary read was a cold,
  // full scan. Re-measured 2026-08-31 on a SYNTHETIC 751,275-row ledger (1855
  // sessions, 38,825 rollup rows, the 25 seeded pricing rows plus one extra
  // rate epoch, ~176 MB database) built by a throwaway script — rows inserted
  // directly, not ingested — on an M4 Mac Mini under concurrent load: median
  // 947 ms of blocked event loop per cold read, spread 720-1351 ms over seven
  // reads on fresh handles. Treat the shape as the finding and the absolute
  // numbers as this corpus on this machine; a real ledger is not this tidy.
  //
  // Migration 16 installed `token_usage_rollup` — grain
  // (session_id, model, bucket, day, rate_effective_from), storing TOKENS and
  // the resolved pricing row's `effective_from`, never dollars — and keeps it
  // exact through triggers on both `token_usage` and `model_pricing`. This
  // function is the reader that migration's shadow-table note was waiting for.
  // Same ledger, same script — which measured the pre-cutover read by
  // transcribing it from git history and INTERLEAVED the two paths so neither
  // got the warmer page cache: median 58 ms, spread 34-78 ms, over the same
  // seven cold reads — a 16x cut at the medians. The spread is quoted rather
  // than a single flattering figure because that is what was observed. The
  // rollup grows with distinct (session, model, bucket, day, rate)
  // combinations rather than with message count, so the gap widens with
  // corpus age.
  //
  // WHY THE RATE IS APPLIED HERE AND NOT IN SQL. The rollup stores the WINNING
  // `effective_from`, so pricing is a lookup on a stored key, never a redo of
  // the dated-rate resolution — no `ORDER BY effective_from DESC LIMIT 1`
  // correlated subquery per row anywhere below. That lookup is done in JS
  // against a Map built from the whole of `model_pricing` (~40 rows) rather
  // than as a SQL LEFT JOIN, for two reasons. A LEFT JOIN that matched two
  // pricing rows would silently DOUBLE a cost with nothing able to report it;
  // building a Map makes that collision a loud throw (see readRateTable). And
  // doing the arithmetic in JS pins the float accumulation order instead of
  // leaving it to the query planner.
  //
  // FLOAT ACCUMULATION ORDER — a deliberate, documented change. The old path
  // summed one `tokens * rate / 1e6` term PER LEDGER ROW inside SQLite's
  // compensated SUM(); this one sums one term per rollup GROUP, over an exact
  // integer token total, in primary-key order. Those two cannot be
  // bit-identical in general, and the new order is the more accurate of the
  // two: strictly fewer floating-point additions over the same exact integers,
  // with the per-group token total carried as an integer until the single
  // multiplication. The order is PINNED by the ORDER BY below — the rollup is
  // WITHOUT ROWID, so primary-key order is its natural scan order and the sort
  // costs nothing — and test/api-cost-summary-equivalence.test.ts re-derives
  // the SAME grain in the SAME order straight from `token_usage` and asserts
  // exact equality, then compares against the pre-cutover ledger SQL to prove
  // no cent drifted. On the 751,275-row corpus measured above, the two paths
  // agree on every token count, on every unpriced-token count and on the order
  // of every list, and their dollars differ by 1.7e-10 USD on a $48,329.62
  // total — floating-point noise at the last representable bits. Which of the
  // two lands nearer the exact rational answer was NOT computed; the reason to
  // prefer this order is the structural argument above (strictly fewer
  // additions), not that measurement.
  //
  // NO FALLBACK. If `token_usage_rollup` is absent this SELECT throws and the
  // request fails loudly. There is deliberately no "scan the ledger instead"
  // arm: a silent fallback would hide a broken migration behind a whole-ledger
  // scan that merely feels slow, and would make the equivalence proof
  // unfalsifiable in production — the one place it matters.
  const stateKey = costSummaryStateKey(db);
  const cached = costSummaryCache.get(db);
  if (cached !== undefined && cached.stateKey === stateKey && cached.topN === topN) {
    return cached.summary;
  }
  // THE FATE OF THE MEMO (M-19, decided): it stays, demoted. It is no longer
  // load-bearing — the read below is bounded by rollup cardinality, not by
  // ledger size — but a repeat read on a quiescent connection still costs
  // 0.02 ms instead of 58 ms on the corpus measured above (median of twenty
  // warm-handle repeat reads), and deleting a correct, cheap, already-proven
  // behaviour would buy nothing. It is kept
  // BEHIND the same self-validating key, so it can still only ever be stale in
  // the never-stale direction. `probe.onScan()` therefore keeps its exact
  // meaning: it fires on a cache MISS and only on a miss. What it counts has
  // changed with this cutover, and its docstring says so.
  probe?.onScan();
  const rates = readRateTable(db);
  // ONE ordered scan of the rollup. `ORDER BY` names the primary key of a
  // WITHOUT ROWID table, so this is the table's own storage order: it pins the
  // summation order (above) without adding a sorter.
  const rollup = db
    .prepare(
      `SELECT session_id, model, bucket, day, rate_effective_from, tokens
         FROM token_usage_rollup
        ORDER BY session_id, model, bucket, day, rate_effective_from`,
    )
    .all() as CostRollupRow[];

  const totals: CostBucket = { tokens: 0, costUsd: 0, unpricedTokens: 0 };
  const byModel = new Map<string, CostBucket>();
  const byDay = new Map<string, CostBucket>();
  const bySession = new Map<string, CostBucket>();
  for (const row of rollup) {
    // '' is the rollup's encoding of "no rate was in force" — the priced CTE's
    // NULL rate. Those tokens are surfaced as unpriced and contribute $0; they
    // are never guessed at, and never dropped.
    const rate = row.rate_effective_from === '' ? null : rateFor(rates, row);
    const add: CostBucket =
      rate === null
        ? { tokens: row.tokens, costUsd: 0, unpricedTokens: row.tokens }
        : { tokens: row.tokens, costUsd: (row.tokens * rate) / 1000000, unpricedTokens: 0 };
    totals.tokens += add.tokens;
    totals.costUsd += add.costUsd;
    totals.unpricedTokens += add.unpricedTokens;
    accumulate(byModel, row.model, add);
    accumulate(byDay, row.day, add);
    accumulate(bySession, row.session_id, add);
  }

  const perModel = [...byModel]
    .sort(([aKey, a], [bKey, b]) => b.costUsd - a.costUsd || byBinary(aKey, bKey))
    .map(([model, bucket]) => ({ model, ...bucket }));
  // `unknown` last, then most-recent day first - the SQL's
  // `ORDER BY (day = 'unknown') ASC, day DESC`, and ISO days sort as text.
  const perDay = [...byDay]
    .sort(
      ([aKey], [bKey]) =>
        Number(aKey === 'unknown') - Number(bKey === 'unknown') || byBinary(bKey, aKey),
    )
    .map(([day, bucket]) => ({ day, ...bucket }));
  const top = [...bySession]
    .sort(([aKey, a], [bKey, b]) => b.costUsd - a.costUsd || byBinary(aKey, bKey))
    .slice(0, topN);
  // Only the surviving sessions need a project slug. A session_id present in
  // `token_usage` but absent from `sessions` keeps a null slug, exactly as the
  // LEFT JOIN this replaces did - the row is never dropped to hide the gap.
  const slugRows =
    top.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, project_slug, partial_reason, partial_skipped_bytes, usage_records_dropped
               FROM sessions
              WHERE id IN (${Array.from({ length: top.length }, () => '?').join(', ')})`,
          )
          .all(...top.map(([id]) => id)) as Array<
          HonestyRow & { id: string; project_slug: string | null }
        >);
  const sessionRows = new Map(slugRows.map((row) => [row.id, row]));
  // Owner decisions 1 and 2, corpus-wide: how many sessions' totals are a lower
  // bound, and how many usage records could not be deduplicated. Counted over
  // every session row, not just the top slice - the totals above cover every
  // session, so their caveat has to as well.
  const honestyTotals = db
    .prepare(
      `SELECT COUNT(partial_reason) AS partial_sessions,
              COALESCE(SUM(usage_records_dropped), 0) AS usage_records_dropped,
              COUNT(CASE WHEN malformed_lines > 0 THEN 1 END) AS malformed_sessions,
              COALESCE(SUM(malformed_lines), 0) AS malformed_lines
         FROM (SELECT partial_reason, usage_records_dropped,
                      ${MALFORMED_LINES_SQL} AS malformed_lines
                 FROM sessions)`,
    )
    .get() as {
    partial_sessions: number;
    usage_records_dropped: number;
    malformed_sessions: number;
    malformed_lines: number;
  };

  const summary: CostSummaryDto = {
    totals,
    perModel,
    perDay,
    topSessions: top.map(([sessionId, bucket]) => {
      // A usage-only session (token_usage rows, no sessions row) has no
      // honesty facts recorded: it reads as whole with nothing dropped, the
      // same absence-is-null rule its slug follows.
      const row = sessionRows.get(sessionId);
      return {
        sessionId,
        projectSlug: row?.project_slug ?? null,
        ...bucket,
        ...(row === undefined
          ? { partial: null, usageRecordsDropped: 0 }
          : toHonesty(row.partial_reason, row.partial_skipped_bytes, row.usage_records_dropped)),
      };
    }),
    // The population the slice was cut from, so the client can say "N of M"
    // rather than hedge (closing-plan L1). `bySession` holds every session with
    // a rollup row - priced or unpriced - which is exactly what a longer
    // `topN` would have listed; sessions with no usage at all are not
    // "sessions with cost" and are not counted here.
    sessionCount: bySession.size,
    hasMore: bySession.size > top.length,
    partialSessions: honestyTotals.partial_sessions,
    usageRecordsDropped: honestyTotals.usage_records_dropped,
    sessionsWithMalformedLines: honestyTotals.malformed_sessions,
    malformedLinesSkipped: honestyTotals.malformed_lines,
  };
  // Stored under the key OBSERVED BEFORE the scan — safe because better-sqlite3
  // is synchronous: nothing on this connection can write between the two.
  costSummaryCache.set(db, { stateKey, topN, summary });
  return summary;
}
