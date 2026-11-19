/**
 * QA-8 — property tests for `canonicalizeTimestamp`.
 *
 * The server compares stored instants as TEXT, so the canonical spelling is
 * only correct if (a) every accepted spelling of one instant maps to one
 * string and (b) text order of canonical strings equals instant order. Both
 * are universally quantified claims, which is what a property test is for.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalizeTimestamp } from '../src/index';

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Instants whose UTC spelling AND every offset spelling stay within four-digit
 * years: one day of margin on each end covers any ±23:59 offset.
 */
const instant = fc.date({
  min: new Date('0000-01-02T00:00:00.000Z'),
  max: new Date('9999-12-30T23:59:59.999Z'),
  noInvalidDate: true,
});

/** An offset in minutes, the full ±23:59 range the parser accepts. */
const offsetMinutes = fc.integer({ min: -(23 * 60 + 59), max: 23 * 60 + 59 });

/** The same instant written as local wall-clock time plus a `±hh:mm` zone. */
function withOffset(date: Date, offset: number): string {
  const wallClock = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${wallClock}${sign}${hh}:${mm}`;
}

const ctx = 'property';

describe('canonicalizeTimestamp — properties (QA-8)', () => {
  it('returns a canonical (toISOString) value byte-identical', () => {
    fc.assert(
      fc.property(instant, (date) => {
        expect(canonicalizeTimestamp(date.toISOString(), ctx)).toBe(date.toISOString());
      }),
    );
  });

  it('maps every offset spelling of one instant to the same UTC string', () => {
    fc.assert(
      fc.property(instant, offsetMinutes, (date, offset) => {
        expect(canonicalizeTimestamp(withOffset(date, offset), ctx)).toBe(date.toISOString());
      }),
    );
  });

  it('truncates sub-millisecond digits rather than rounding them', () => {
    fc.assert(
      fc.property(instant, fc.stringMatching(/^\d{1,6}$/), (date, extra) => {
        const spelled = `${date.toISOString().slice(0, -1)}${extra}Z`;
        expect(canonicalizeTimestamp(spelled, ctx)).toBe(date.toISOString());
      }),
    );
  });

  it('orders canonical strings as text exactly as their instants order', () => {
    fc.assert(
      fc.property(instant, offsetMinutes, instant, offsetMinutes, (a, oa, b, ob) => {
        const ca = canonicalizeTimestamp(withOffset(a, oa), ctx);
        const cb = canonicalizeTimestamp(withOffset(b, ob), ctx);
        // Plain `<` / `===` compare UTF-16 code units, as SQLite's BINARY collation does.
        expect(ca < cb).toBe(a.getTime() < b.getTime());
        expect(ca === cb).toBe(a.getTime() === b.getTime());
      }),
    );
  });

  it('on any string either throws RangeError or returns an idempotent canonical value', () => {
    const anyText = fc.oneof(
      fc.string(),
      // Near-misses of the accepted grammar, where a lax parser would slip.
      fc.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{0,10})?(Z|[+-]\d{2}:?\d{2})?$/,
      ),
    );
    fc.assert(
      fc.property(anyText, (text) => {
        let out: string;
        try {
          out = canonicalizeTimestamp(text, ctx);
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          return;
        }
        expect(out).toMatch(CANONICAL);
        expect(canonicalizeTimestamp(out, ctx)).toBe(out);
        expect(Date.parse(out)).toBe(new Date(out).getTime());
      }),
      { numRuns: 2000 },
    );
  });
});
