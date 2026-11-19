/**
 * WP-D8 - write path for the LONG-format token_usage matrix.
 *
 * Each deduped `usage` block fans out to FIVE rows, one per priced bucket, so
 * the table is a complete queryable (message_id, bucket) matrix - zero-token
 * buckets are stored too.
 *
 * CONVERGENCE (parser-spec 5.2). The corpus watcher re-reads a session while an
 * assistant turn is still streaming, so the SAME `message.id` is ingested more
 * than once: first as a mid-stream partial (small `output`, sometimes carrying a
 * transient fast-mode model label), later as the settled turn. An INSERT that
 * merely IGNOREs the conflict freezes the first, wrong read forever - the ~2x
 * mispricing 5.2 exists to prevent. The write is therefore an upsert that
 * reproduces, in storage, exactly what `dedupeUsageByMessageId` computes in
 * memory over the complete file:
 *   - `tokens` is the per-bucket MAXIMUM, never a sum (naive summation
 *     over-counts ~2.4x) and never a decrease;
 *   - `model` settles at MESSAGE level, driven by the `output` bucket: it is
 *     adopted only from a read whose `output` is strictly greater than the
 *     stored one, and is then applied to all five rows of that message - so a
 *     per-bucket maximum can never smear a stale label across buckets.
 * Both rules are monotonic in the growing line set, so the converged state is
 * independent of how many times, or at which moment, a session is polled.
 * Nothing is inferred here: every value written is a ground-truth field read
 * from the JSONL.
 *
 * ATTRIBUTION. Core reports a main-transcript turn as `agentId: null` (the
 * substrate has no `agent-<hex>` file for it), but the main agent IS a
 * materialized node whose id is the session id. Persisting that null made every
 * root node report a permanent $0 while its spend sat in `unattributed`, so the
 * null is resolved to `sessionId` here - the hard join migration 6 anticipated,
 * not a guess.
 *
 * IDEMPOTENCE. The DO UPDATE carries a WHERE guard, so replaying an unchanged
 * deduped set performs zero UPDATEs (not merely no-op ones) and reports
 * `{ inserted: 0, corrected: 0 }` - the byte-identical double-replay proof
 * depends on that distinction.
 *
 * OWNERSHIP (M-12, made order-independent by DAT-15). UNIQUE(message_id,
 * bucket) is GLOBAL, not per-session, and a CLI resume/fork copies history
 * lines VERBATIM into a NEW session file - so the same message_id can
 * legitimately arrive from two different sessions. Exactly one session owns a
 * message_id, and which one is decided by the sessions themselves, never by
 * the order their files happen to be ingested in:
 *   1. the session with the EARLIER `sessions.started_at` (compared as an
 *      instant via `julianday()`, never as text) owns it;
 *   2. a session with a known start precedes one whose start is NULL or not
 *      an instant;
 *   3. otherwise - the same start, or no usable start on either side - the
 *      lexicographically SMALLER session id owns it.
 * Rule 3 is not a corner case: a resumed or forked file usually opens with the
 * copied history lines, so both sessions often report the same start. The
 * tie-break carries no meaning beyond being stable; it exists so the owner is
 * a function of the two sessions alone.
 *
 * A copy arriving from a session that does NOT precede the stored owner is
 * EXCLUDED entirely (all five buckets, even when it carries a larger `tokens`
 * value - the convergence MAX above is a WITHIN-session streaming repair,
 * never a cross-session merge) and its id is returned in
 * `crossSessionMessageIds`. A copy arriving from a session that DOES precede
 * the stored owner TAKES THE MESSAGE OVER: the stored owner's five rows are
 * deleted and the incoming copy is written as a fresh message. Either way the
 * collision is counted in `crossSessionCollisions` and surfaced with one
 * counts-only warn per write call - never silent, never double-counted: the
 * replayed lines are the SAME spend, stored once under exactly one owner, so
 * global token totals AND their attribution are identical whichever file is
 * ingested first. Token counts stay ground truth, read once and never
 * invented. Without this guard the upsert's `agent_id = excluded.agent_id` arm
 * would silently rewrite who spent the money on every replay of the other
 * file.
 *
 * A takeover removes rows from a session other than the one being written, so
 * it does what the triggers cannot: migration 22's `ingest_seq` triggers stamp
 * only `NEW.session_id` and a DELETE stamps nothing, so the previous owner is
 * stamped here explicitly (its totals just changed, and /api/changes must say
 * so), and the ledger epoch is bumped for the caches keyed on it. Because the
 * ordering keys only ever settle - `started_at` never moves later - the owner
 * converges once both sessions have been ingested at their final extent. Zero
 * colliding message ids exist across this machine's whole corpus today
 * (measured 2026-08-09, PROVISIONAL), which is why the rule ships with no
 * migration: it pre-empts CLI behavior rather than repairing stored damage.
 * *(Amended 2026-11-19, DAT-15 - the rule used to be "the first-ingested
 * session owns a message_id", which made attribution depend on ingest order.)*
 *
 * CANONICAL occurred_at (M-21, second half). `occurred_at` is the OTHER operand
 * of the dated-rate comparison that migration 14 fixed on the `model_pricing`
 * side. The API's priced CTE resolves a rate with
 * `mp.effective_from <= tu.occurred_at` compared as BINARY-collated TEXT and
 * ordered `effective_from DESC`, while core's `computeCostUsd` compares the same
 * two instants in epoch milliseconds. Canonicalizing only one operand fixes only
 * half the comparison: storing the timestamp verbatim let a spelling carrying a
 * UTC offset sort in a place unrelated to its position on the clock -
 * '2026-02-28T20:00:00-05:00' is one hour AFTER '2026-03-01T00:00:00.000Z' but
 * sorts below it, so the SQL resolver found no rate at all and reported the
 * tokens as unpriced while core priced them. Every value written here is
 * therefore rewritten into `YYYY-MM-DDTHH:mm:ss.sssZ` first; see
 * {@link canonicalizeOccurredAt}. Migration 15 backfills what is already stored
 * and installs the matching triggers, so a writer that does not go through this
 * module cannot store a non-canonical value either.
 */
import type { DedupedUsage } from '@agenthropic/core';
import type { SqliteDatabase } from './connection';
import { bumpLedgerEpoch } from './ledger-epoch';

export interface TokenUsageInsertResult {
  /** Rows genuinely inserted - a (message_id, bucket) pair that did not exist. */
  readonly inserted: number;
  /** Existing rows corrected in place by a later, fuller read of the same message. */
  readonly corrected: number;
  /**
   * Messages (not rows) whose message_id another session also carries - the
   * M-12 ownership rule. Each one was either skipped (the other session owns
   * it) or taken over (this session owns it now, DAT-15). Observable by
   * contract: a collision is never silently swallowed.
   */
  readonly crossSessionCollisions: number;
  /**
   * The SKIPPED subset of `crossSessionCollisions`, in input order - the
   * messages this session does not own after the write - so the caller can
   * price what this session actually OWNS (PAR-3). A taken-over message is
   * owned, so it is not listed. Returned, never logged: the warn below stays
   * counts-only.
   */
  readonly crossSessionMessageIds: readonly string[];
}

/** The five priced buckets, paired with their `token_usage.bucket` snake-case names. */
const BUCKET_COLUMNS: readonly [keyof DedupedUsage['usage'], string][] = [
  ['input', 'input'],
  ['output', 'output'],
  ['cacheRead', 'cache_read'],
  ['cacheWrite5m', 'cache_write_5m'],
  ['cacheWrite1h', 'cache_write_1h'],
];

/**
 * The input spellings a usage timestamp may ARRIVE in, all of which denote one
 * unambiguous instant: a bare UTC date, or a full date-time at second or
 * millisecond precision carrying an explicit zone (`Z` or `[+-]HH:MM`).
 *
 * Deliberately identical in shape to `ACCEPTED_EFFECTIVE_FROM_INPUT` in
 * `db/pricing.ts`, and for the same reasons: a zone-less date-time is read as
 * local time by ECMAScript and as UTC by SQLite, so accepting it would let the
 * JS write path and the SQL guard trigger disagree by the machine's offset;
 * hour 24 is excluded because ECMAScript rolls 'T24:00:00' into the next
 * midnight while SQLite's strftime prints the hour back as '24'. Every field is
 * range-checked in the pattern because both parsers are lenient in places.
 *
 * The pattern is duplicated rather than imported from `pricing.ts`. The two
 * columns are canonicalized for the same reason but are not the same contract:
 * they reject with different messages naming different columns, they are
 * enforced by different triggers, and `occurred_at` is nullable while
 * `effective_from` is part of a primary key. Sharing one constant would couple
 * a future loosening of one column's accepted input to the other's - and the
 * migration-11/14 convention already forbids a migration reaching for a shared
 * helper whose meaning can drift out from under its checksum.
 */
const ACCEPTED_OCCURRED_AT_INPUT =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * Rewrite one usage timestamp into the canonical stored form,
 * `YYYY-MM-DDTHH:mm:ss.sssZ`, or throw.
 *
 * Canonical because it is the only textual form in which lexicographic order
 * and chronological order coincide for every value the column can hold, which
 * is exactly what the priced CTE's `mp.effective_from <= tu.occurred_at` and
 * `ORDER BY mp.effective_from DESC` assume of BINARY-collated text.
 *
 * A value that does not denote one unambiguous instant is never guessed at and
 * never silently dropped to NULL: it halts the write, the same way an unpriced
 * model halts the ingest instead of being priced at $0. A dropped timestamp
 * would not be a small loss - `occurred_at IS NULL` makes the row permanently
 * unpriceable and invisible to retention's expiry window.
 *
 * Applied BEFORE binding, not after: the upsert's guard compares
 * `token_usage.occurred_at IS NOT excluded.occurred_at`, so binding the raw
 * value would make every replay of an already-stored second-precision timestamp
 * look like a change and perform an UPDATE - breaking the zero-UPDATE
 * idempotence the byte-identical double-replay proof depends on.
 */
export function canonicalizeOccurredAt(value: string): string {
  // A day number the pattern allows but the calendar does not ('2026-02-30')
  // is rolled silently into the next month by BOTH parsers, so no resolver
  // diverges - but the row would be filed under a day nothing ever happened on,
  // and retention would expire it on the wrong date. Re-deriving the date from
  // itself is how that is caught.
  const datePart = value.slice(0, 10);
  const dateRoundTrip = new Date(`${datePart}T00:00:00.000Z`);
  const isRealDate =
    !Number.isNaN(dateRoundTrip.getTime()) && dateRoundTrip.toISOString().slice(0, 10) === datePart;
  const epochMs =
    ACCEPTED_OCCURRED_AT_INPUT.test(value) && isRealDate ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(epochMs)) {
    throw new Error(
      `token_usage.occurred_at ${JSON.stringify(value)} is not an unambiguous instant. ` +
        'Write a bare UTC date (YYYY-MM-DD) or a zoned ISO-8601 timestamp ' +
        '(YYYY-MM-DDTHH:mm:ss[.sss]Z or +HH:MM); a usage timestamp is never guessed.',
    );
  }
  const canonical = new Date(epochMs).toISOString();
  // The pattern bounds the INPUT year to four digits, but an offset can carry
  // the instant across a year boundary: '9999-12-31T23:00:00-05:00' is
  // '+010000-01-01T04:00:00.000Z' and '0000-01-01T00:30:00+01:00' is a
  // negative expanded year. Neither orders as text with the four-digit form,
  // which is the whole point of canonicalizing. Only the out-of-range instants
  // are affected; every other accepted input returns what it always did.
  if (!FOUR_DIGIT_YEAR_CANONICAL.test(canonical)) {
    throw new Error(
      `token_usage.occurred_at ${JSON.stringify(value)} is outside the four-digit year range ` +
        'once normalized to UTC; its canonical form would not order as text.',
    );
  }
  return canonical;
}

/**
 * The canonical form's year prefix. `toISOString` prints years 0-9999 as four
 * digits and every other year in the signed six-digit expanded form.
 *
 * Core's `canonicalizeTimestamp` carries the same range check, but this
 * function does not delegate to it: core rejects the bare UTC date this column
 * accepts and accepts fraction lengths other than three, which this column
 * (and migration 15's guard triggers) reject. Delegating would change the
 * column's contract in both directions.
 */
const FOUR_DIGIT_YEAR_CANONICAL = /^\d{4}-/;

/**
 * `settles` (0/1) is decided per MESSAGE before its five rows are written, so
 * the model and its timestamp move together with the greatest-output read.
 * `MAX(a, b)` is SQLite's two-argument scalar max, and `IS NOT` is its
 * null-safe inequality. The guard lists every column the SET can actually
 * change: when none of them would move, no UPDATE runs at all.
 */
const UPSERT_SQL = `
  INSERT INTO token_usage
    (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
  VALUES (@sessionId, @agentId, @messageId, @model, @bucket, @tokens, 0, @occurredAt)
  ON CONFLICT (message_id, bucket) DO UPDATE SET
    agent_id    = excluded.agent_id,
    model       = CASE WHEN @settles = 1 THEN excluded.model ELSE token_usage.model END,
    tokens      = MAX(token_usage.tokens, excluded.tokens),
    occurred_at = CASE WHEN @settles = 1 THEN excluded.occurred_at ELSE token_usage.occurred_at END
  WHERE excluded.tokens > token_usage.tokens
     OR token_usage.agent_id IS NOT excluded.agent_id
     OR (@settles = 1
         AND (token_usage.model IS NOT excluded.model
              OR token_usage.occurred_at IS NOT excluded.occurred_at))
`;

export function insertTokenUsageRows(
  db: SqliteDatabase,
  sessionId: string,
  deduped: readonly DedupedUsage[],
): TokenUsageInsertResult {
  const upsertStatement = db.prepare(UPSERT_SQL);
  // Existence + settle + ownership probe. This writer always emits a message's
  // five bucket rows inside one transaction, so the `output` row is present
  // exactly when the message is - one indexed lookup answers all three
  // questions, and the ownership check happens BEFORE any bucket row is
  // touched so a foreign message can never be half-written. The owner's start
  // comes along through the join so the ownership rule costs no extra query.
  const storedOutputStatement = db.prepare(
    `SELECT tu.tokens AS tokens, tu.session_id AS sessionId,
            julianday(s.started_at) AS ownerStart
       FROM token_usage tu
       LEFT JOIN sessions s ON s.id = tu.session_id
      WHERE tu.message_id = ? AND tu.bucket = 'output'`,
  );
  const deleteMessageStatement = db.prepare('DELETE FROM token_usage WHERE message_id = ?');
  const advanceClockStatement = db.prepare('UPDATE ingest_clock SET seq = seq + 1');
  const stampSessionStatement = db.prepare(
    'UPDATE sessions SET ingest_seq = (SELECT seq FROM ingest_clock) WHERE id = ?',
  );

  const writeAll = db.transaction((entries: readonly DedupedUsage[]): TokenUsageInsertResult => {
    let inserted = 0;
    let corrected = 0;
    let crossSessionCollisions = 0;
    let takeovers = 0;
    const crossSessionMessageIds: string[] = [];
    // Read inside the transaction: the projection upserts this session's row
    // (and its start) earlier in the same transaction.
    const incomingStart = sessionStart(db, sessionId);
    for (const entry of entries) {
      let storedOutput = storedOutputStatement.get(entry.messageId) as StoredOutput | undefined;
      if (storedOutput !== undefined && storedOutput.sessionId !== sessionId) {
        crossSessionCollisions += 1;
        const owner = { start: storedOutput.ownerStart, id: storedOutput.sessionId };
        if (!ownsBefore({ start: incomingStart, id: sessionId }, owner)) {
          // The stored owner precedes this session (see OWNERSHIP above). The
          // spend is already counted once under it - skip the whole message.
          crossSessionMessageIds.push(entry.messageId);
          continue;
        }
        // DAT-15 takeover: this session precedes the stored owner. Drop the
        // owner's copy and write this one as a fresh message.
        deleteMessageStatement.run(entry.messageId);
        advanceClockStatement.run();
        stampSessionStatement.run(storedOutput.sessionId);
        takeovers += 1;
        storedOutput = undefined;
      }
      const settles = storedOutput === undefined || entry.usage.output > storedOutput.tokens;
      // Once per message, not once per bucket: all five rows of a message share
      // one timestamp, and a throw must abort the message before any of its
      // rows is written rather than midway through the fan-out.
      const occurredAt = canonicalizeOccurredAt(entry.timestamp);
      let changes = 0;
      for (const [key, bucket] of BUCKET_COLUMNS) {
        const info = upsertStatement.run({
          sessionId,
          agentId: entry.agentId ?? sessionId,
          messageId: entry.messageId,
          model: entry.model,
          bucket,
          tokens: entry.usage[key],
          occurredAt,
          settles: settles ? 1 : 0,
        });
        changes += info.changes;
      }
      if (storedOutput === undefined) {
        inserted += changes;
      } else {
        corrected += changes;
      }
    }
    if (takeovers > 0) {
      // Rows of ANOTHER session were deleted through this handle.
      bumpLedgerEpoch(db);
    }
    return { inserted, corrected, crossSessionCollisions, crossSessionMessageIds };
  });

  const result = writeAll(deduped);
  if (result.crossSessionCollisions > 0) {
    // Counts only, never ids: the log must not become a payload channel. One
    // line per write call is naturally rate-limited to the poll cadence.
    const skipped = result.crossSessionMessageIds.length;
    const takenOver = result.crossSessionCollisions - skipped;
    console.warn(
      `[token-usage] skipped ${String(skipped)} message(s) owned by another session, ` +
        `took over ${String(takenOver)} message(s) from a later-starting session ` +
        '(resume/fork replay; spend counted once under its owner)',
    );
  }
  return result;
}

interface StoredOutput {
  readonly tokens: number;
  readonly sessionId: string;
  /** `julianday(sessions.started_at)` of the stored owner; null when unknown. */
  readonly ownerStart: number | null;
}

/** A session's place in the ownership order (see OWNERSHIP above). */
interface OwnershipKey {
  /** `julianday(started_at)`; null when the start is NULL, not an instant, or the row is missing. */
  readonly start: number | null;
  readonly id: string;
}

function sessionStart(db: SqliteDatabase, sessionId: string): number | null {
  const row = db
    .prepare('SELECT julianday(started_at) AS start FROM sessions WHERE id = ?')
    .get(sessionId) as { start: number | null } | undefined;
  return row?.start ?? null;
}

/**
 * True when `a` owns a shared message_id over `b`: the earlier known start
 * wins, a known start beats an unknown one, and anything else falls to the
 * smaller session id. A strict total order on distinct sessions, so exactly
 * one of `ownsBefore(a, b)` and `ownsBefore(b, a)` holds.
 */
export function ownsBefore(a: OwnershipKey, b: OwnershipKey): boolean {
  if (a.start !== null && b.start !== null && a.start !== b.start) {
    return a.start < b.start;
  }
  if (a.start !== null && b.start === null) {
    return true;
  }
  if (a.start === null && b.start !== null) {
    return false;
  }
  return a.id < b.id;
}
