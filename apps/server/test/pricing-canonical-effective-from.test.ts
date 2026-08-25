/**
 * M-21, write-path half: `model_pricing.effective_from` has exactly one stored
 * spelling, `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * Two canonicalizers must produce that form byte-for-byte, because both run in
 * production: the JS one in `db/pricing.ts` (the server's own write path) and
 * the SQL one in migration 14's triggers (the operator writing rates through
 * the sqlite3 CLI while the server runs, a path documented in `api/queries.ts`).
 * If they ever disagreed, the table would hold two spellings again and the
 * API's text comparison would resolve rates against the clock incorrectly —
 * exactly the bug this fix closes. So they are tested against each other over
 * the boundary fixtures, not just each against itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_EFFECTIVE_FROM_EXAMPLE,
  canonicalizeEffectiveFrom,
  loadPricing,
  upsertPricingRate,
} from '../src/db/pricing';
import { createMigratedTempDb, type TempDb } from './helpers';

/** Every accepted input spelling, paired with the one instant it denotes. */
const ACCEPTED_FIXTURES: ReadonlyArray<readonly [input: string, canonical: string]> = [
  ['2026-01-01', '2026-01-01T00:00:00.000Z'],
  ['2026-12-31', '2026-12-31T00:00:00.000Z'],
  ['2026-03-01T00:00:00Z', '2026-03-01T00:00:00.000Z'],
  ['2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
  ['2026-03-01T12:34:56.789Z', '2026-03-01T12:34:56.789Z'],
  ['2026-03-01T02:00:00+02:00', '2026-03-01T00:00:00.000Z'],
  ['2026-02-28T20:00:00-05:00', '2026-03-01T01:00:00.000Z'],
  // Offset carrying the instant across a date boundary in each direction —
  // where a naive "strip the offset" rewrite would land on the wrong day.
  ['2026-03-01T00:30:00+02:00', '2026-02-28T22:30:00.000Z'],
  ['2026-02-28T23:30:00-02:00', '2026-03-01T01:30:00.000Z'],
  ['2026-03-01T23:59:59.999-00:30', '2026-03-02T00:29:59.999Z'],
  // Leap day: a real instant that a hand-rolled calendar would drop.
  ['2028-02-29T06:00:00Z', '2028-02-29T06:00:00.000Z'],
];

/**
 * Spellings that must HALT the write. Each either fails to denote one instant
 * or is read differently by the two canonicalizers — a pricing date is never
 * guessed, the same rule that makes an unpriced model halt the ingest.
 */
const REJECTED_INPUTS: readonly string[] = [
  // Zone-less: ECMAScript reads it as local time, SQLite as UTC.
  '2026-03-01T00:00:00',
  '2026-03-01T00:00:00.000',
  // SQLite would happily take these; none of them is an ISO-8601 instant.
  // '2026' is the sharpest: SQLite reads it as a Julian day number and dates
  // the rate to 4707 BC, so an operator's typo would price everything.
  '2026-03-01 00:00:00',
  'now',
  '2026',
  '2451545.0',
  // Shape-valid digits that are not a date at all.
  '2026-13-45',
  '2026-00-01',
  '2026-01-00',
  '2026-03-01T00:99:00Z',
  '2026-03-01T00:00:99Z',
  '2026-03-01T00:00:00+99:00',
  '2026-03-01T00:00:00+02:60',
  // Days the calendar does not have. BOTH parsers roll these into the next
  // month rather than failing, so the rate would take effect on a day nobody
  // wrote — a guessed pricing date, rejected here rather than stored.
  '2026-02-30',
  '2026-04-31',
  '2026-02-30T00:00:00Z',
  // Hour 24 — the one spelling on which the two canonicalizers disagree:
  // ECMAScript rolls it into the next midnight, SQLite prints back '24'.
  '2026-03-01T24:00:00Z',
  // Not a date at all.
  'garbage',
  '',
];

describe('canonical model_pricing.effective_from (M-21)', () => {
  let temp: TempDb | undefined;

  afterEach(() => {
    temp?.cleanup();
    temp = undefined;
  });

  describe('canonicalizeEffectiveFrom', () => {
    it('rewrites every accepted spelling into the canonical form', () => {
      for (const [input, canonical] of ACCEPTED_FIXTURES) {
        expect(canonicalizeEffectiveFrom(input)).toBe(canonical);
      }
    });

    it('is idempotent — canonicalizing a canonical value returns it unchanged', () => {
      for (const [, canonical] of ACCEPTED_FIXTURES) {
        expect(canonicalizeEffectiveFrom(canonical)).toBe(canonical);
      }
      expect(canonicalizeEffectiveFrom(CANONICAL_EFFECTIVE_FROM_EXAMPLE)).toBe(
        CANONICAL_EFFECTIVE_FROM_EXAMPLE,
      );
    });

    it('halts on every spelling that does not denote one unambiguous instant', () => {
      for (const input of REJECTED_INPUTS) {
        expect(() => canonicalizeEffectiveFrom(input)).toThrow(/not an unambiguous instant/);
      }
    });

    it('produces text whose byte order matches chronological order', () => {
      // The whole point of the canonical form: this is the property the API's
      // `effective_from <= occurred_at` text comparison silently assumes.
      const byInstant = [...ACCEPTED_FIXTURES]
        .map(([input]) => canonicalizeEffectiveFrom(input))
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      const byBytes = [...byInstant].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(byBytes).toEqual(byInstant);
    });
  });

  describe('SQL and JS canonicalizers agree byte-for-byte', () => {
    it('strftime rewrites each accepted spelling exactly as Date.toISOString does', () => {
      temp = createMigratedTempDb();
      const viaSql = temp.db
        .prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?) AS canonical`)
        .pluck();
      for (const [input, canonical] of ACCEPTED_FIXTURES) {
        expect({ input, canonical: viaSql.get(input) }).toEqual({ input, canonical });
      }
    });

    it('the guard trigger rejects exactly what the JS canonicalizer rejects', () => {
      temp = createMigratedTempDb();
      const insert = temp.db.prepare(
        'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
      );
      for (const input of REJECTED_INPUTS) {
        expect(() => insert.run('guard-model', 'input', 1, input)).toThrow(
          /must be a bare UTC date or a zoned ISO-8601 instant/,
        );
      }
      // Nothing slipped through while the guard was being exercised.
      expect(
        temp.db
          .prepare(`SELECT count(*) FROM model_pricing WHERE model = 'guard-model'`)
          .pluck()
          .get(),
      ).toBe(0);
    });
  });

  describe('upsertPricingRate', () => {
    it('stores the canonical form whatever spelling the caller passes', () => {
      temp = createMigratedTempDb();
      for (const [index, [input, canonical]] of ACCEPTED_FIXTURES.entries()) {
        const model = `upsert-model-${String(index)}`;
        upsertPricingRate(temp.db, {
          model,
          bucket: 'input',
          usdPerMtok: 3,
          effectiveFrom: input,
        });
        expect(
          temp.db
            .prepare('SELECT effective_from FROM model_pricing WHERE model = ?')
            .pluck()
            .get(model),
        ).toBe(canonical);
      }
    });

    it('updates the rate in place when two spellings name the same instant', () => {
      // The reason canonicalization happens BEFORE the statement runs: the
      // ON CONFLICT target is (model, bucket, effective_from), so a
      // non-canonical value would miss the existing row, insert a second one,
      // and only then be rewritten by the trigger — into a primary-key
      // violation instead of the intended rate correction.
      temp = createMigratedTempDb();
      upsertPricingRate(temp.db, {
        model: 'upsert-same-instant',
        bucket: 'input',
        usdPerMtok: 3,
        effectiveFrom: '2026-03-01',
      });
      upsertPricingRate(temp.db, {
        model: 'upsert-same-instant',
        bucket: 'input',
        usdPerMtok: 4,
        effectiveFrom: '2026-03-01T00:00:00Z',
      });
      const rows = temp.db
        .prepare(
          `SELECT usd_per_mtok, effective_from FROM model_pricing WHERE model = 'upsert-same-instant'`,
        )
        .all();
      expect(rows).toEqual([{ usd_per_mtok: 4, effective_from: '2026-03-01T00:00:00.000Z' }]);
    });

    it('keeps distinct instants as distinct rows, and loadPricing reads them back', () => {
      temp = createMigratedTempDb();
      upsertPricingRate(temp.db, {
        model: 'upsert-two-instants',
        bucket: 'input',
        usdPerMtok: 3,
        effectiveFrom: '2026-01-01',
      });
      upsertPricingRate(temp.db, {
        model: 'upsert-two-instants',
        bucket: 'input',
        usdPerMtok: 5,
        effectiveFrom: '2026-06-01T00:00:00+00:00',
      });
      const loaded = loadPricing(temp.db).filter((entry) => entry.model === 'upsert-two-instants');
      expect(loaded).toEqual([
        {
          model: 'upsert-two-instants',
          bucket: 'input',
          usdPerMtok: 3,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
        {
          model: 'upsert-two-instants',
          bucket: 'input',
          usdPerMtok: 5,
          effectiveFrom: '2026-06-01T00:00:00.000Z',
        },
      ]);
    });

    it('halts instead of writing an unparseable pricing date', () => {
      temp = createMigratedTempDb();
      expect(() =>
        upsertPricingRate(temp!.db, {
          model: 'upsert-bad',
          bucket: 'input',
          usdPerMtok: 3,
          effectiveFrom: '2026-03-01T00:00:00',
        }),
      ).toThrow(/not an unambiguous instant/);
      expect(
        temp.db
          .prepare(`SELECT count(*) FROM model_pricing WHERE model = 'upsert-bad'`)
          .pluck()
          .get(),
      ).toBe(0);
    });
  });
});
