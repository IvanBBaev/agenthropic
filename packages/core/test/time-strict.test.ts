/**
 * Strict ISO-8601 instant parsing.
 *
 * `Date.parse` is lenient: it accepts non-ISO spellings ('2026',
 * 'Sep 23 2026'), reads a zone-less datetime in the machine's LOCAL zone (so
 * the same transcript would group and price differently per host), and
 * silently rolls impossible calendar values ('2026-02-30', hour 24) into a
 * different instant. Each of those is a computed claim about a moment nothing
 * observed; every one must fail loudly instead.
 */
import { describe, expect, it } from 'vitest';
import { computeCostUsd, groupSiblingsIntoWaves } from '../src/index';
import type { DedupedUsage, PricingEntry } from '../src/index';
import { parsePricingInstantMs, parseTimestampMs } from '../src/time';

const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

function pricing(effectiveFrom: string): PricingEntry[] {
  return BUCKETS.map((bucket) => ({
    model: 'claude-sonnet-5',
    bucket,
    usdPerMtok: 1,
    effectiveFrom,
  }));
}

function usage(timestamp: string): DedupedUsage {
  return {
    messageId: 'msg_1',
    agentId: null,
    model: 'claude-sonnet-5',
    timestamp,
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  };
}

describe('parseTimestampMs: accepted spellings', () => {
  it.each([
    ['2026-09-23T10:11:12.345Z', Date.UTC(2026, 8, 23, 10, 11, 12, 345)],
    ['2026-09-23T10:11:12Z', Date.UTC(2026, 8, 23, 10, 11, 12)],
    ['2026-09-23T10:11:12.5Z', Date.UTC(2026, 8, 23, 10, 11, 12, 500)],
    ['2026-09-23T10:11:12.345678Z', Date.UTC(2026, 8, 23, 10, 11, 12, 345)],
    ['2026-09-23T13:11:12.345+03:00', Date.UTC(2026, 8, 23, 10, 11, 12, 345)],
    ['2026-09-23T05:41:12-04:30', Date.UTC(2026, 8, 23, 10, 11, 12)],
    ['2026-09-23T10:11:12+00:00', Date.UTC(2026, 8, 23, 10, 11, 12)],
    ['2024-02-29T00:00:00Z', Date.UTC(2024, 1, 29)],
    ['2026-12-31T23:59:59.999Z', Date.UTC(2026, 11, 31, 23, 59, 59, 999)],
    ['0050-01-01T00:00:00Z', -60589296000000],
  ])('%s', (value, expected) => {
    expect(parseTimestampMs(value, 'ctx')).toBe(expected);
  });

  it('an offset carrying the instant across midnight still names the right day', () => {
    expect(parseTimestampMs('2026-03-01T01:00:00+02:00', 'ctx')).toBe(
      Date.UTC(2026, 1, 28, 23, 0, 0),
    );
  });
});

describe('parseTimestampMs: rejected spellings', () => {
  it.each([
    // Non-ISO or partial spellings Date.parse accepts.
    '2026',
    '2026-09',
    'Sep 23 2026',
    'Wed, 23 Sep 2026 10:11:12 GMT',
    '2026-09-23',
    // Zone-less: Date.parse reads these in the machine's local zone.
    '2026-09-23T10:11:12',
    '2026-09-23T10:11:12.345',
    // Missing seconds, alternative separators and zone spellings.
    '2026-09-23T10:11Z',
    '2026-09-23 10:11:12Z',
    '2026-09-23t10:11:12z',
    '2026-09-23T10:11:12+0300',
    '2026-09-23T10:11:12+03',
    '2026-09-23T10:11:12 Z',
    '2026-09-23T10:11:12.Z',
    '+002026-09-23T10:11:12Z',
    ' 2026-09-23T10:11:12Z',
    '2026-09-23T10:11:12Z ',
    // Out-of-range components that Date.parse rolls over or rejects.
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-09-00T00:00:00Z',
    '2026-09-32T00:00:00Z',
    '2026-09-23T24:00:00Z',
    '2026-09-23T10:60:00Z',
    '2026-09-23T10:11:60Z',
    '2026-09-23T10:11:12+24:00',
    '2026-09-23T10:11:12+03:60',
    '',
    'not-a-timestamp',
  ])('%j', (value) => {
    expect(() => parseTimestampMs(value, 'ctx')).toThrow(RangeError);
    expect(() => parseTimestampMs(value, 'ctx')).toThrow(/ctx: unparsable ISO-8601 timestamp/);
  });
});

describe('parsePricingInstantMs', () => {
  it('accepts a bare date as UTC midnight, the documented pricing-date spelling', () => {
    expect(parsePricingInstantMs('2020-01-01', 'ctx')).toBe(Date.UTC(2020, 0, 1));
  });

  it('accepts a zoned datetime exactly as parseTimestampMs does', () => {
    expect(parsePricingInstantMs('2026-05-01T08:00:00+03:00', 'ctx')).toBe(
      Date.UTC(2026, 4, 1, 5, 0, 0),
    );
  });

  it.each(['2026-02-30', '2026-13-01', '2026', '2026-03-01T00:00:00', 'Mar 1 2026'])(
    'rejects %j',
    (value) => {
      expect(() => parsePricingInstantMs(value, 'ctx')).toThrow(/unparsable ISO-8601/);
    },
  );
});

describe('callers reject lenient spellings', () => {
  it('wave grouping refuses a zone-less first-record timestamp', () => {
    expect(() =>
      groupSiblingsIntoWaves([{ firstRecordTimestamp: '2026-09-23T10:11:12.345' }]),
    ).toThrow(/unparsable ISO-8601/);
  });

  it('wave grouping refuses a rolled-over calendar date', () => {
    expect(() =>
      groupSiblingsIntoWaves([{ firstRecordTimestamp: '2026-02-30T10:11:12.345Z' }]),
    ).toThrow(/unparsable ISO-8601/);
  });

  it('cost refuses a date-only usage timestamp', () => {
    expect(() => computeCostUsd([usage('2026-09-23')], pricing('2020-01-01'))).toThrow(
      /unparsable ISO-8601/,
    );
  });

  it('cost refuses a zone-less pricing datetime', () => {
    expect(() =>
      computeCostUsd([usage('2026-09-23T10:11:12.345Z')], pricing('2026-03-01T00:00:00')),
    ).toThrow(/unparsable ISO-8601/);
  });

  it('cost still prices against a bare-date pricing row', () => {
    expect(computeCostUsd([usage('2026-09-23T10:11:12.345Z')], pricing('2020-01-01'))).toBe(1);
  });
});
