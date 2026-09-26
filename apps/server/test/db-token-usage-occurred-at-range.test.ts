import { describe, expect, it } from 'vitest';
import { canonicalizeTimestamp } from '@agenthropic/core';
import { canonicalizeOccurredAt } from '../src/db/token-usage';

/**
 * `canonicalizeOccurredAt` promises that its output orders as text exactly as
 * the instants order on the clock. That holds only for the four-digit-year
 * `toISOString` form: an offset can carry an input whose own year has four
 * digits across a year boundary into the expanded six-digit form
 * ('+010000-...', '-000001-...'), which sorts nowhere near its instant.
 *
 * The second half pins the precise difference between this canonicalizer and
 * core's `canonicalizeTimestamp` (agent and session timestamps). The two are
 * deliberately NOT unified: their acceptance sets differ, and the stored
 * contract of `token_usage.occurred_at` (mirrored by migration 15's triggers)
 * must neither widen nor narrow.
 */

const CONTEXT = 'test';

function serverAccepts(value: string): boolean {
  try {
    canonicalizeOccurredAt(value);
    return true;
  } catch {
    return false;
  }
}

function coreAccepts(value: string): boolean {
  try {
    canonicalizeTimestamp(value, CONTEXT);
    return true;
  } catch {
    return false;
  }
}

describe('canonicalizeOccurredAt: four-digit-year range of the canonical form', () => {
  it.each([
    ['9999-12-31T23:00:00-05:00', 'offset pushes the instant into year 10000'],
    ['9999-12-31T23:59:59.999-00:01', 'one minute past the last four-digit instant'],
    ['0000-01-01T00:30:00+01:00', 'offset pulls the instant before year 0000'],
    ['0000-01-01T00:00:00.000+00:01', 'one minute before the first four-digit instant'],
  ])('rejects %s (%s)', (value) => {
    expect(() => canonicalizeOccurredAt(value)).toThrow(
      /token_usage\.occurred_at ".*" is outside the four-digit year range once normalized to UTC/,
    );
  });

  it.each([
    ['9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
    ['9999-12-31T23:59:59.999+00:00', '9999-12-31T23:59:59.999Z'],
    ['9999-12-31', '9999-12-31T00:00:00.000Z'],
    ['0000-01-01', '0000-01-01T00:00:00.000Z'],
    ['0000-01-01T00:00:00Z', '0000-01-01T00:00:00.000Z'],
    ['0000-01-01T01:00:00+01:00', '0000-01-01T00:00:00.000Z'],
  ])('keeps the boundary instant %s -> %s', (value, canonical) => {
    expect(canonicalizeOccurredAt(value)).toBe(canonical);
  });
});

describe('canonicalizeOccurredAt: byte-identical output for previously accepted input', () => {
  // The zero-UPDATE idempotence of the upsert and the byte-identical
  // double-replay proof both depend on these outputs never moving.
  it.each([
    ['2026-09-23', '2026-09-23T00:00:00.000Z'],
    ['2026-09-23T10:00:05Z', '2026-09-23T10:00:05.000Z'],
    ['2026-09-23T10:00:05.123Z', '2026-09-23T10:00:05.123Z'],
    ['2026-02-28T20:00:00-05:00', '2026-03-01T01:00:00.000Z'],
    ['2026-09-23T10:00:05.123+02:30', '2026-09-23T07:30:05.123Z'],
    ['2026-09-23T10:00:05+00:00', '2026-09-23T10:00:05.000Z'],
    ['2026-09-23T10:00:05-00:00', '2026-09-23T10:00:05.000Z'],
    ['2024-02-29T23:59:59.999Z', '2024-02-29T23:59:59.999Z'],
  ])('%s -> %s', (value, canonical) => {
    expect(canonicalizeOccurredAt(value)).toBe(canonical);
    // Idempotent: the canonical form is itself accepted and returned as-is.
    expect(canonicalizeOccurredAt(canonical)).toBe(canonical);
  });

  it('still rejects malformed input with the original message', () => {
    expect(() => canonicalizeOccurredAt('2026-03-01 09:30')).toThrow(
      /occurred_at "2026-03-01 09:30" is not an unambiguous instant/,
    );
  });
});

describe('acceptance sets: canonicalizeOccurredAt (server) versus canonicalizeTimestamp (core)', () => {
  // [input, server accepts, core accepts]
  const table: readonly (readonly [string, boolean, boolean])[] = [
    // Where the sets DIFFER.
    ['2026-09-23', true, false], // bare date
    ['2026-09-23T10:00:05.1Z', false, true], // one fraction digit
    ['2026-09-23T10:00:05.12Z', false, true], // two fraction digits
    ['2026-09-23T10:00:05.1234Z', false, true], // four fraction digits
    ['2026-09-23T10:00:05.123456789Z', false, true], // nine fraction digits
    ['2026-09-23T10:00:05.123+02:00', true, true], // three digits with an offset
    ['2026-09-23T10:00:05.1234+02:00', false, true], // four digits with an offset
    // Where the sets AGREE.
    ['2026-09-23T10:00:05Z', true, true],
    ['2026-09-23T10:00:05.123Z', true, true],
    ['2026-09-23T10:00:05+00:00', true, true],
    ['2026-09-23T10:00:05-00:00', true, true],
    ['2026-09-23T10:00:05+23:59', true, true],
    ['2026-09-23T10:00:05+24:00', false, false], // offset hour out of range
    ['2026-09-23T10:00:05+05:60', false, false], // offset minute out of range
    ['2026-09-23t10:00:05z', false, false], // lowercase separator and zone
    ['2026-09-23T10:00:05z', false, false], // lowercase zone only
    ['2026-09-23T10:00Z', false, false], // missing seconds
    ['2026-09-23T10:00:05', false, false], // zone-less date-time
    ['2026-09-23T10:00:05.Z', false, false], // empty fraction
    ['2026-09-23T24:00:00Z', false, false], // hour 24
    ['2026-09-23T10:00:60Z', false, false], // leap second
    ['2026-02-30T10:00:00Z', false, false], // day the calendar lacks
    ['2026-13-01T10:00:00Z', false, false], // month 13
    ['2026-09-23 10:00:05Z', false, false], // space separator
    ['+002026-09-23T10:00:05Z', false, false], // expanded-year input
    ['9999-12-31T23:00:00-05:00', false, false], // out of range after the offset
    ['0000-01-01T00:30:00+01:00', false, false], // out of range after the offset
    ['', false, false],
  ];

  it.each(table)('%s: server=%s core=%s', (value, server, core) => {
    expect(serverAccepts(value)).toBe(server);
    expect(coreAccepts(value)).toBe(core);
  });

  it('produces byte-identical output wherever both accept', () => {
    for (const [value, server, core] of table) {
      if (server && core) {
        expect(canonicalizeOccurredAt(value)).toBe(canonicalizeTimestamp(value, CONTEXT));
      }
    }
  });
});
