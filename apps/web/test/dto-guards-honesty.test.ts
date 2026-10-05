/**
 * Owner decisions 1 and 2 (NN1) at the web boundary: `partial` and
 * `usageRecordsDropped` gate a disclosure ("totals are a lower bound", "N usage
 * records ... were excluded"), so an absent one is not a blank - it is an
 * assertion that the session is whole and nothing was dropped. A payload that
 * predates the pair is refused whole, on the precedent of `hasMore` and
 * `counts.truncated`.
 */
import { describe, expect, it } from 'vitest';
import { isCostSummary, isSessionList, isSessionTree } from '../src/dto-guards';
import {
  OVERSIZE_PARTIAL,
  costSummary,
  sessionCost,
  sessionList,
  sessionSummary,
  sessionTree,
} from './fixtures';

function body(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function omit<T extends object>(value: T, key: keyof T & string): Record<string, unknown> {
  const clone = { ...value } as Record<string, unknown>;
  delete clone[key];
  return clone;
}

/** Every malformed `partial` value the guard must refuse. */
const BAD_PARTIALS: readonly [string, unknown][] = [
  ['an array', []],
  ['a string', 'main-transcript-oversize'],
  ['an unknown reason', { reason: 'unreadable', skippedBytes: 1 }],
  ['a missing reason', { skippedBytes: 1 }],
  ['a missing skippedBytes', { reason: 'main-transcript-oversize' }],
  ['a string skippedBytes', { reason: 'main-transcript-oversize', skippedBytes: '1' }],
];

describe('session list rows', () => {
  it('accepts a whole row and a partial row with or without a byte size', () => {
    const rows = [
      sessionSummary(),
      sessionSummary({ partial: OVERSIZE_PARTIAL, usageRecordsDropped: 4 }),
      sessionSummary({ partial: { ...OVERSIZE_PARTIAL, skippedBytes: null } }),
    ];
    expect(isSessionList(body(sessionList(rows)))).toBe(true);
  });

  it.each(['partial', 'usageRecordsDropped'] as const)('refuses a row with no `%s`', (key) => {
    expect(isSessionList(body(sessionList([omit(sessionSummary(), key) as never])))).toBe(false);
  });

  it.each(BAD_PARTIALS)('refuses a `partial` that is %s', (_label, partial) => {
    expect(isSessionList(body(sessionList([sessionSummary({ partial: partial as never })])))).toBe(
      false,
    );
  });

  it('refuses a `usageRecordsDropped` sent as null', () => {
    expect(
      isSessionList(body(sessionList([sessionSummary({ usageRecordsDropped: null as never })]))),
    ).toBe(false);
  });
});

describe('session tree', () => {
  it('accepts a whole tree and a partial one', () => {
    expect(isSessionTree(body(sessionTree()))).toBe(true);
    expect(
      isSessionTree(body(sessionTree({ partial: OVERSIZE_PARTIAL, usageRecordsDropped: 2 }))),
    ).toBe(true);
  });

  it.each(['partial', 'usageRecordsDropped'] as const)('refuses a tree with no `%s`', (key) => {
    expect(isSessionTree(omit(sessionTree(), key))).toBe(false);
  });

  it.each(BAD_PARTIALS)('refuses a `partial` that is %s', (_label, partial) => {
    expect(isSessionTree(body(sessionTree({ partial: partial as never })))).toBe(false);
  });
});

describe('cost summary', () => {
  it('accepts partial top sessions and the corpus aggregates', () => {
    expect(
      isCostSummary(
        body(
          costSummary({
            topSessions: [sessionCost({ partial: OVERSIZE_PARTIAL, usageRecordsDropped: 1 })],
            partialSessions: 1,
            usageRecordsDropped: 1,
          }),
        ),
      ),
    ).toBe(true);
  });

  it.each(['partialSessions', 'usageRecordsDropped'] as const)(
    'refuses a summary with no `%s`',
    (key) => {
      expect(isCostSummary(omit(costSummary(), key))).toBe(false);
    },
  );

  it.each(['partial', 'usageRecordsDropped'] as const)(
    'refuses a top-session row with no `%s`',
    (key) => {
      expect(
        isCostSummary(body(costSummary({ topSessions: [omit(sessionCost(), key) as never] }))),
      ).toBe(false);
    },
  );

  it.each(BAD_PARTIALS)('refuses a top-session `partial` that is %s', (_label, partial) => {
    expect(
      isCostSummary(
        body(costSummary({ topSessions: [sessionCost({ partial: partial as never })] })),
      ),
    ).toBe(false);
  });
});
