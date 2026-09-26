/**
 * `canonicalizeTimestamp` - the one spelling every stored instant shares.
 *
 * The server compares stored instants as TEXT (`MAX(excluded.x, stored.x)`
 * and the status CASE's `>`), and ISO-8601 only orders correctly as text when
 * every value has the same shape. '2026-01-01T00:00:01Z' sorts AFTER
 * '2026-01-01T00:00:01.500Z' ('Z' > '.'), and an offset spelling compares its
 * wall-clock digits, not its instant. The canonical form is exactly what
 * `Date.prototype.toISOString` prints for a four-digit year.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeTimestamp } from '../src/index';

describe('canonicalizeTimestamp: canonical input is returned byte-identical', () => {
  it.each([
    '2026-09-23T10:11:12.345Z',
    '2026-01-01T00:00:00.000Z',
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
  ])('%s', (value) => {
    expect(canonicalizeTimestamp(value, 'ctx')).toBe(value);
  });
});

describe('canonicalizeTimestamp: non-canonical spellings of a valid instant', () => {
  it.each([
    ['2026-01-01T00:00:01Z', '2026-01-01T00:00:01.000Z'],
    ['2026-01-01T00:00:01.5Z', '2026-01-01T00:00:01.500Z'],
    ['2026-01-01T00:00:01.123456789Z', '2026-01-01T00:00:01.123Z'],
    ['2026-03-01T02:00:00+02:00', '2026-03-01T00:00:00.000Z'],
    ['2026-02-28T20:00:00-05:00', '2026-03-01T01:00:00.000Z'],
    ['2026-01-01T00:00:00.250+00:00', '2026-01-01T00:00:00.250Z'],
  ])('%s -> %s', (value, expected) => {
    expect(canonicalizeTimestamp(value, 'ctx')).toBe(expected);
  });

  it('makes text order agree with instant order', () => {
    const early = canonicalizeTimestamp('2026-01-01T00:00:01Z', 'ctx');
    const late = canonicalizeTimestamp('2026-01-01T00:00:01.500Z', 'ctx');
    // The raw pair misorders as text; the canonical pair does not.
    expect('2026-01-01T00:00:01Z' > '2026-01-01T00:00:01.500Z').toBe(true);
    expect(early < late).toBe(true);
  });
});

describe('canonicalizeTimestamp: loud failure', () => {
  it.each([
    'garbage',
    '',
    '2026-01-01t00:00:00.000z',
    '2026-01-01T00:00:00.000z',
    '2026-01-01T00:00:00',
    '2026-02-30T00:00:00.000Z',
    '2026-01-01 00:00:00Z',
  ])('rejects an unparsable value %j', (value) => {
    expect(() => canonicalizeTimestamp(value, 'agent "x"')).toThrow(RangeError);
    expect(() => canonicalizeTimestamp(value, 'agent "x"')).toThrow(/agent "x"/);
  });

  it.each([
    ['9999-12-31T23:00:00-05:00', '+010000-01-01T04:00:00.000Z'],
    ['0000-01-01T00:30:00+01:00', '-000001-12-31T23:30:00.000Z'],
  ])('rejects %s, whose instant needs an expanded year (%s)', (value) => {
    expect(() => canonicalizeTimestamp(value, 'ctx')).toThrow(/outside the four-digit year range/);
  });
});
