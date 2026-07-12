import { describe, expect, it } from 'vitest';
import { DEFAULT_WAVE_THRESHOLD_MS, groupSiblingsIntoWaves } from '../src/index';

interface Sibling {
  agentId: string;
  firstRecordTimestamp: string;
}

const BASE_MS = Date.parse('2026-07-10T12:00:00.000Z');

function sibling(agentId: string, offsetMs: number): Sibling {
  return { agentId, firstRecordTimestamp: new Date(BASE_MS + offsetMs).toISOString() };
}

function ids(wave: { agents: Sibling[] }): string[] {
  return wave.agents.map((a) => a.agentId);
}

describe('groupSiblingsIntoWaves', () => {
  it('exports the normative ~10 ms default threshold', () => {
    expect(DEFAULT_WAVE_THRESHOLD_MS).toBe(10);
  });

  it('returns an empty array for no siblings', () => {
    expect(groupSiblingsIntoWaves([])).toEqual([]);
  });

  it('returns a single ordered (not started-together) wave for one sibling', () => {
    const waves = groupSiblingsIntoWaves([sibling('a', 0)]);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.startedTogether).toBe(false);
    expect(ids(waves[0]!)).toEqual(['a']);
  });

  it('clean sequence: deltas above threshold yield singleton waves in time order', () => {
    const waves = groupSiblingsIntoWaves([sibling('a', 0), sibling('b', 100), sibling('c', 500)]);
    expect(waves.map((w) => w.startedTogether)).toEqual([false, false, false]);
    expect(waves.map(ids)).toEqual([['a'], ['b'], ['c']]);
  });

  it('3 ms cluster: siblings inside a parallel dispatch collapse into one UNORDERED wave', () => {
    const waves = groupSiblingsIntoWaves([sibling('a', 0), sibling('b', 3), sibling('c', 6)]);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.startedTogether).toBe(true);
    expect(ids(waves[0]!).sort()).toEqual(['a', 'b', 'c']);
  });

  it('boundary: a delta of exactly thresholdMs starts a NEW wave (strictly-below rule)', () => {
    const waves = groupSiblingsIntoWaves([sibling('a', 0), sibling('b', 10)]);
    expect(waves).toHaveLength(2);
    expect(waves.map((w) => w.startedTogether)).toEqual([false, false]);
  });

  it('boundary: a delta one ms below the threshold merges', () => {
    const waves = groupSiblingsIntoWaves([sibling('a', 0), sibling('b', 9)]);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.startedTogether).toBe(true);
  });

  it('chains successive sub-threshold deltas into one wave even when the total span exceeds the threshold', () => {
    // 0, 8, 16: each successive delta is 8 (< 10) although the span is 16.
    const waves = groupSiblingsIntoWaves([sibling('a', 0), sibling('b', 8), sibling('c', 16)]);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.agents).toHaveLength(3);
  });

  it('mixes waves and singletons, never manufacturing a total order inside a wave', () => {
    const waves = groupSiblingsIntoWaves([
      sibling('solo1', 0),
      sibling('w1', 1000),
      sibling('w2', 1003),
      sibling('solo2', 2000),
    ]);
    expect(waves.map((w) => w.startedTogether)).toEqual([false, true, false]);
    expect(waves.map(ids)).toEqual([['solo1'], ['w1', 'w2'], ['solo2']]);
  });

  it('sorts unsorted input by firstRecordTimestamp before grouping', () => {
    const waves = groupSiblingsIntoWaves([sibling('c', 500), sibling('a', 0), sibling('b', 100)]);
    expect(waves.map(ids)).toEqual([['a'], ['b'], ['c']]);
  });

  it('identical timestamps land in one started-together wave', () => {
    const waves = groupSiblingsIntoWaves([sibling('a', 0), sibling('b', 0)]);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.startedTogether).toBe(true);
  });

  it('honors a custom threshold', () => {
    const input = [sibling('a', 0), sibling('b', 50)];
    expect(groupSiblingsIntoWaves(input, 100)).toHaveLength(1);
    expect(groupSiblingsIntoWaves(input, 50)).toHaveLength(2);
  });

  it('a zero threshold never merges (no delta is strictly below 0)', () => {
    const waves = groupSiblingsIntoWaves([sibling('a', 0), sibling('b', 0)], 0);
    expect(waves).toHaveLength(2);
  });

  it('does not mutate the input array order', () => {
    const input = [sibling('c', 500), sibling('a', 0)];
    groupSiblingsIntoWaves(input);
    expect(input.map((s) => s.agentId)).toEqual(['c', 'a']);
  });

  it('throws on a negative threshold', () => {
    expect(() => groupSiblingsIntoWaves([sibling('a', 0)], -1)).toThrow(RangeError);
  });

  it('throws on a non-finite threshold', () => {
    expect(() => groupSiblingsIntoWaves([sibling('a', 0)], Number.NaN)).toThrow(RangeError);
  });

  it('throws loudly on an unparsable timestamp', () => {
    expect(() =>
      groupSiblingsIntoWaves([{ agentId: 'a', firstRecordTimestamp: 'not-a-timestamp' }]),
    ).toThrow(/unparsable ISO-8601/);
  });
});
