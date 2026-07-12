/**
 * Sibling wave grouping — parser-spec section 6.3 (gate #11, EMP-1 amended).
 *
 * The substrate carries only a wave-partial sibling order: the two temporal
 * signals agree on every pair started >~3 ms apart and disagree only inside a
 * genuinely parallel dispatch wave (max inverted-pair delta corpus-wide:
 * 3 ms). Siblings are therefore ordered by first-record timestamp and
 * same-wave siblings are collapsed into an EXPLICITLY UNORDERED group —
 * never a manufactured total order the substrate does not carry.
 */
import type { SiblingWave } from '../types';
import { parseTimestampMs } from '../time';

export const DEFAULT_WAVE_THRESHOLD_MS = 10;

/**
 * Orders `siblings` by `firstRecordTimestamp` and collapses runs whose
 * successive start deltas are strictly below `thresholdMs` into one wave with
 * `startedTogether: true`. A delta exactly at the threshold starts a new
 * wave. Singleton waves carry `startedTogether: false`. Within a wave the
 * `agents` array is timestamp-ordered for determinism only — the flag marks
 * that order as meaningless.
 */
export function groupSiblingsIntoWaves<T extends { firstRecordTimestamp: string }>(
  siblings: readonly T[],
  thresholdMs: number = DEFAULT_WAVE_THRESHOLD_MS,
): Array<SiblingWave<T>> {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    throw new RangeError(
      `thresholdMs must be a non-negative finite number (got ${String(thresholdMs)})`,
    );
  }

  const timed = siblings.map((sibling) => ({
    sibling,
    startMs: parseTimestampMs(sibling.firstRecordTimestamp, 'sibling firstRecordTimestamp'),
  }));
  timed.sort((a, b) => a.startMs - b.startMs);

  const waves: Array<SiblingWave<T>> = [];
  let currentWave: SiblingWave<T> | undefined;
  let previousStartMs = Number.NEGATIVE_INFINITY;

  for (const { sibling, startMs } of timed) {
    if (currentWave !== undefined && startMs - previousStartMs < thresholdMs) {
      currentWave.agents.push(sibling);
      currentWave.startedTogether = true;
    } else {
      currentWave = { startedTogether: false, agents: [sibling] };
      waves.push(currentWave);
    }
    previousStartMs = startMs;
  }

  return waves;
}
