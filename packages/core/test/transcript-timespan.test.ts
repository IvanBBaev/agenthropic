/**
 * C-3 regression: an agent's `startedAt` / `endedAt` are the EARLIEST and
 * LATEST instants among its timestamped records, not the first and last
 * records in file order.
 *
 * File order is not instant order on the real corpus (48 of 3777 transcripts
 * on 2026-10-23 had a first or last record that was not the min or max): a
 * resumed or compacted transcript can append records stamped before earlier
 * lines. Taking file order then shrinks or even inverts the span
 * (`endedAt < startedAt`). The comparison is by instant, so an offset spelling
 * orders correctly against a `Z` spelling; the winning value is returned
 * verbatim and canonicalized downstream, exactly as before. Every timestamp is
 * now a candidate boundary, so an unparsable one ANYWHERE fails the session
 * (before, only a first or last one did, at ingest canonicalization).
 */
import { describe, expect, it } from 'vitest';
import { parseSession, SubstrateError, type SessionSubstrate } from '../src/index';

const SESSION = 'c3c30001-1111-4222-8333-444444444444';

function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function mainWith(timestamps: Array<string | undefined>): SessionSubstrate {
  return {
    files: [
      {
        relativePath: `${SESSION}.jsonl`,
        lines: timestamps.map((timestamp) =>
          jline({
            sessionId: SESSION,
            type: 'user',
            ...(timestamp === undefined ? {} : { timestamp }),
            message: { role: 'user', content: 'x' },
          }),
        ),
      },
    ],
  };
}

function mainSpan(substrate: SessionSubstrate): { startedAt: string; endedAt: string } {
  const main = parseSession(substrate).agents.find((agent) => agent.id === SESSION);
  if (main === undefined) {
    throw new Error('main agent missing');
  }
  return { startedAt: main.startedAt, endedAt: main.endedAt };
}

describe('parseSession — transcript timespan is min/max by instant (C-3)', () => {
  it('takes the earliest and latest instants when file order disagrees', () => {
    expect(
      mainSpan(
        mainWith([
          '2026-09-01T00:00:05.000Z',
          '2026-09-01T00:00:01.000Z',
          '2026-09-01T00:00:09.000Z',
          '2026-09-01T00:00:03.000Z',
        ]),
      ),
    ).toEqual({ startedAt: '2026-09-01T00:00:01.000Z', endedAt: '2026-09-01T00:00:09.000Z' });
  });

  it('never yields an inverted span when the file runs backwards', () => {
    const span = mainSpan(mainWith(['2026-09-01T00:00:09.000Z', '2026-09-01T00:00:01.000Z']));
    expect(span).toEqual({
      startedAt: '2026-09-01T00:00:01.000Z',
      endedAt: '2026-09-01T00:00:09.000Z',
    });
  });

  it('compares offset spellings as instants and returns the winning value verbatim', () => {
    // 02:00:00+03:00 is 23:00:00Z the previous day — earlier than both Z values,
    // although it sorts last as text.
    expect(
      mainSpan(
        mainWith(['2026-09-01T00:00:00.000Z', '2026-09-01T02:00:00+03:00', '2026-09-01T00:30:00Z']),
      ),
    ).toEqual({ startedAt: '2026-09-01T02:00:00+03:00', endedAt: '2026-09-01T00:30:00Z' });
  });

  it('keeps the first spelling on an instant tie', () => {
    expect(
      mainSpan(mainWith(['2026-09-01T00:00:00Z', '2026-09-01T03:00:00+03:00', undefined])),
    ).toEqual({ startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:00:00Z' });
  });

  it('fails loudly on an unparsable timestamp in any position', () => {
    for (const substrate of [
      mainWith(['2026-09-01T00:00:00.000Z', 'yesterday', '2026-09-01T00:00:02Z']),
      mainWith(['yesterday', undefined]),
    ]) {
      expect(() => parseSession(substrate)).toThrow(SubstrateError);
      expect(() => parseSession(substrate)).toThrow(/unparsable ISO-8601 timestamp "yesterday"/);
    }
  });
});
