/**
 * The single props contract every routed view receives (WP-U5).
 *
 * WP-U6..U9 replaced each view's INTERNALS and kept this signature -
 * the shell, router and view registry then never change. If a view needs more
 * than this, extend ViewProps here (one place) rather than forking per-view
 * prop shapes.
 */
import type { SseClient } from '../sse';

export interface ViewProps {
  /**
   * Dashboard token for same-origin API calls - send it ONLY as an
   * `Authorization: Bearer` header. Never render it, never log it, never put
   * it in a URL (the SSE client already owns the one query-string exception).
   */
  readonly token: string;
  /** Shared live SSE client, already connected and managed by the shell. */
  readonly sse: SseClient;
  /**
   * A data fetch answered 401: the stored token is no longer valid. Views
   * call this instead of rendering an error - the app clears the token and
   * returns to the entry screen (same contract as the shell's health probe).
   */
  readonly onAuthRejected: () => void;
  /**
   * How many startup replays the shell has watched end (2026-10-05). It moves
   * exactly when figures read during a replay stop being excusable: a view
   * that fetches a corpus-wide answer once lists it among that fetch's
   * dependencies and so re-reads, keeping what is on screen until the new
   * answer lands. Optional: a view mounted on its own has no shell to count.
   */
  readonly replayEpoch?: number;
}
