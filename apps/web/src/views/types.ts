/**
 * The single props contract every routed view receives (WP-U5).
 *
 * NEXT WAVE (WP-U6..U9): replace each view's INTERNALS, keep this signature -
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
}
