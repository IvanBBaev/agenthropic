/**
 * WP-C1/WP-C2 - read AND canonical write path for the versioned model pricing
 * table.
 *
 * `loadPricing` maps each snake_case column onto the camelCase
 * {@link PricingEntry} the cost engine consumes. No sorting happens on read:
 * `computeCostUsd` builds its own dated index and sorts effective-from
 * internally.
 *
 * M-21 (canonical `effective_from`). Dated-price resolution exists TWICE in
 * this system and the two halves compare timestamps differently:
 *
 *   - `packages/core`'s `computeCostUsd` parses both sides to epoch
 *     milliseconds and compares instants;
 *   - the API's priced CTE (`api/queries.ts`) compares
 *     `effective_from <= occurred_at` as BINARY-collated TEXT, and orders
 *     candidate rates by `effective_from DESC` - also as text.
 *
 * The ingest halt gate approves dollars with the first resolver; the dashboard
 * presents dollars with the second. They agree only while the stored text
 * happens to sort in chronological order. It does not, in general: '2026-03-01'
 * and '2026-03-01T00:00:00Z' and '2026-03-01T02:00:00+02:00' are three
 * spellings of instants that a text comparison orders differently from the
 * clock - and at a rate change that means the API silently prices at the OLD
 * rate, producing dollars the halt gate never approved and nothing flags.
 *
 * The fix is to make the stored text unable to lie: ONE canonical spelling,
 * enforced at write time (the triggers installed by migration 14), so the SQL
 * string comparison is correct rather than accidentally correct.
 */
import type { PricingEntry } from '@agenthropic/core';
import type { TokenBucket } from '@agenthropic/shared';
import type { SqliteDatabase } from './connection';

interface ModelPricingRow {
  readonly model: string;
  readonly bucket: string;
  readonly usd_per_mtok: number;
  readonly effective_from: string;
}

/**
 * The canonical stored form of `model_pricing.effective_from`:
 * full-millisecond UTC ISO-8601, `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * Chosen because it is the only textual form in which lexicographic order and
 * chronological order coincide for EVERY value this column can hold: fixed
 * width, fixed field order most-significant-first, zero-padded throughout, one
 * single zone (UTC, so no offset can move an instant across a digit that sorts
 * earlier), and a fraction that is always present (so no '.'-vs-'Z' tie-break
 * at a whole second). That equivalence is exactly what the SQL CTE's `<=` and
 * `ORDER BY ... DESC` assume; every other spelling makes them assume wrong.
 *
 * NOT a PROVISIONAL constant: it is not a tuned value awaiting ratification but
 * the form the proof above singles out, and it is the form `Date.prototype
 * .toISOString()` and SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` both emit
 * - so the JS write path and the SQL trigger agree byte-for-byte by
 * construction (verified over the boundary fixtures in
 * test/pricing-canonical-effective-from.test.ts).
 */
export const CANONICAL_EFFECTIVE_FROM_EXAMPLE = '2026-01-01T00:00:00.000Z';

/**
 * The input spellings a pricing date may be WRITTEN in, all of which denote an
 * unambiguous instant: a bare UTC date, or a full date-time at second or
 * millisecond precision carrying an explicit zone (`Z` or `[+-]HH:MM`).
 *
 * Deliberately narrow. A zone-less date-time ('2026-03-01T00:00:00') is NOT
 * accepted: ECMAScript reads it as local time and SQLite reads it as UTC, so
 * the two canonicalizers would disagree by the machine's offset - a silently
 * wrong pricing date, which is the failure class this project refuses. Nor are
 * SQLite's other accepted spellings (a bare Julian day number, 'now'), which
 * would turn a typo into a plausible-looking date. Hour 24 is excluded for the
 * same reason: ECMAScript rolls 'T24:00:00' into the next midnight while
 * SQLite's strftime prints the hour back as '24', so the two would store
 * different text for one instant.
 *
 * Every field is range-checked in the pattern itself, because both parsers are
 * lenient in places (a text-shaped hour of '99' is rejected only by accident of
 * the parser failing, not by design).
 *
 * This mirrors, one-for-one, the guard trigger installed by migration 14; the
 * two must stay in step, and the SQL/JS agreement test pins them.
 */
const ACCEPTED_EFFECTIVE_FROM_INPUT =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * Rewrite one `effective_from` into {@link CANONICAL_EFFECTIVE_FROM_EXAMPLE}'s
 * form, or throw.
 *
 * A value that does not denote one unambiguous instant is never guessed at and
 * never dropped - it halts the write, the same way an unpriced model halts the
 * ingest instead of being silently priced at $0.
 */
export function canonicalizeEffectiveFrom(value: string): string {
  // A day number the pattern allows but the calendar does not ('2026-02-30',
  // '2026-04-31') is rolled silently into the next month by BOTH parsers -
  // Date.parse and SQLite agree on '2026-03-02', so no resolver diverges, but
  // the operator's rate would quietly take effect on a day they never wrote.
  // Re-deriving the date from itself is how that typo is caught.
  const datePart = value.slice(0, 10);
  const dateRoundTrip = new Date(`${datePart}T00:00:00.000Z`);
  const isRealDate =
    !Number.isNaN(dateRoundTrip.getTime()) && dateRoundTrip.toISOString().slice(0, 10) === datePart;
  const epochMs =
    ACCEPTED_EFFECTIVE_FROM_INPUT.test(value) && isRealDate ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(epochMs)) {
    throw new Error(
      `model_pricing.effective_from ${JSON.stringify(value)} is not an unambiguous instant. ` +
        'Write a bare UTC date (YYYY-MM-DD) or a zoned ISO-8601 timestamp ' +
        '(YYYY-MM-DDTHH:mm:ss[.sss]Z or +HH:MM); a pricing date is never guessed.',
    );
  }
  return new Date(epochMs).toISOString();
}

/**
 * The canonical write path for a single rate (M-21).
 *
 * Canonicalizing BEFORE the statement runs is not decoration: the upsert's
 * `ON CONFLICT` target is `(model, bucket, effective_from)`, so a non-canonical
 * value would miss the existing row, insert a second one, and only then be
 * rewritten by the trigger - straight into a primary-key violation instead of
 * the intended in-place rate update.
 */
export function upsertPricingRate(db: SqliteDatabase, entry: PricingEntry): void {
  db.prepare(
    `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (model, bucket, effective_from) DO UPDATE SET usd_per_mtok = excluded.usd_per_mtok`,
  ).run(
    entry.model,
    entry.bucket,
    entry.usdPerMtok,
    canonicalizeEffectiveFrom(entry.effectiveFrom),
  );
}

/** Load all `model_pricing` rows as cost-engine {@link PricingEntry} values. */
export function loadPricing(db: SqliteDatabase): readonly PricingEntry[] {
  const rows = db
    .prepare('SELECT model, bucket, usd_per_mtok, effective_from FROM model_pricing')
    .all() as ModelPricingRow[];
  return rows.map((row) => ({
    model: row.model,
    bucket: row.bucket as TokenBucket,
    usdPerMtok: row.usd_per_mtok,
    effectiveFrom: row.effective_from,
  }));
}
