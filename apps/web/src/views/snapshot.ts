/**
 * Fetch provenance for the two views that read once and then keep painting
 * (F-3 `SessionsView`, F-4 `DagView` - 2026-09-02).
 *
 * Neither view subscribes to the stream, and neither should on this wave:
 * whether the fetch-once views consume SSE at all is an open OWNER decision.
 * So everything they draw is a snapshot with an age, and the honest thing is
 * to make that age visible rather than to make the snapshot live. This module
 * answers the only question the disclosure needs: is what is on screen still
 * what the app itself calls "now"?
 *
 * The boundary is NOT a new policy number. `formatRelativeMs` already owns one
 * - its "just now" window - it is the wording the reader is already looking at
 * beside the figures, and asking the formatter for its own word makes the
 * disclosure appear at exactly the moment the app stops calling the reading
 * current. A threshold invented here could disagree with the label next to it,
 * which is the same class of defect as the freeze it exists to disclose.
 */
import { formatRelativeMs } from '../format';

/**
 * What `formatRelativeMs` prints for an instant it still counts as now. Taken
 * from the formatter itself (an instant compared against itself) instead of
 * repeated as a literal here, so the two cannot drift apart: whatever that
 * window becomes, this is the word printed inside it.
 */
const JUST_NOW = formatRelativeMs(0, 0);

export interface SnapshotAge {
  /** The age, worded exactly as every other relative time in the app. */
  readonly label: string;
  /**
   * The snapshot has outlived the app's own "just now" window, so every figure
   * drawn from it is remembered rather than observed - and must say so.
   */
  readonly aged: boolean;
}

/**
 * Age one snapshot against the shared clock. `fetchedAtMs` must come from
 * `readNowMs()` at the moment the response landed - a `useNowMs()` reading is
 * up to CLOCK_INTERVAL_MS old by design and would date a snapshot before it
 * arrived, which is the one direction this label must never err in.
 */
export function snapshotAge(fetchedAtMs: number, nowMs: number): SnapshotAge {
  const label = formatRelativeMs(fetchedAtMs, nowMs);
  return { label, aged: label !== JUST_NOW };
}
