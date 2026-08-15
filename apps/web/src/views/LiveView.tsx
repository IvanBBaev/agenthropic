/**
 * (a) Live status board (WP-U6): what every session is doing right now.
 *
 * Ground truth is GET /api/sessions; the SSE stream then keeps the snapshot
 * honest between refetches - `agent-status-changed` moves one agent between
 * its session's status buckets in place, and `session-ingested` (or an event
 * for a session the snapshot does not know) triggers a refetch of persisted
 * truth rather than a client-side guess. `ingest-failed` frames render as
 * dismissible banners: a quarantined session never reaches the read API, so
 * the banner is the only place its failure is visible - dropping the frame
 * would present a partial corpus as complete. All five status buckets -
 * including `unknown`, the watchdog's honest state - are always rendered,
 * never filtered. Heartbeats are SSE comment frames and never reach
 * EventSource; stream liveness lives in the shell's connection chip.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSessions } from '../api';
import type { SessionSummaryDto } from '../dto';
import { formatRelativeTime, formatTokens, formatUsd, projectLabel, shortId } from '../format';
import {
  applyAgentStatusChange,
  bucketCount,
  isAgentStatusChangedEvent,
  sortSessionsByRecency,
} from './live-model';
import { AGENT_STATUSES, STATUS_META, statusMeta } from './status';
import type { ViewProps } from './types';

/** Page size for the board snapshot (server max is far above this). */
export const SESSION_LIMIT = 50;

/**
 * Relative-time labels re-render on this cadence. A quiet stream re-renders
 * nothing on its own, so a per-render Date.now() would freeze "just now" on
 * screen for hours. 30 s sits well inside formatRelativeTime's coarsest
 * boundary (the 90 s "just now" window), so a label is never more than one
 * bucket stale.
 */
export const CLOCK_INTERVAL_MS = 30_000;

/**
 * Shape of an `ingest-failed` payload the board can render. The frame rides
 * the shared union's generic arm (`{ type, payload }`), so the payload is
 * narrowed field-by-field here instead of by a shared schema.
 */
export interface IngestFailureNotice {
  readonly sessionId: string;
  readonly reason: string;
  readonly attempt: number;
  readonly willRetry: boolean;
}

/** Narrow a raw `ingest-failed` frame; null means "unreadable, still bad news". */
export function toIngestFailureNotice(data: unknown): IngestFailureNotice | null {
  if (typeof data !== 'object' || data === null) return null;
  const payload = (data as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (
    typeof record.sessionId !== 'string' ||
    typeof record.reason !== 'string' ||
    typeof record.attempt !== 'number' ||
    typeof record.willRetry !== 'boolean'
  ) {
    return null;
  }
  return {
    sessionId: record.sessionId,
    reason: record.reason,
    attempt: record.attempt,
    willRetry: record.willRetry,
  };
}

/** Session id carried by a `session-ingested` frame, when readable. */
export function ingestedSessionId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const sessionId = (data as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' ? sessionId : null;
}

type BoardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly sessions: readonly SessionSummaryDto[];
      readonly total: number;
    };

export function LiveView({ token, sse, onAuthRejected }: ViewProps) {
  const [board, setBoard] = useState<BoardState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  // One banner per failed session (a retry replaces its predecessor), kept
  // until dismissed or superseded by a successful ingest - never toast-and-gone.
  const [failures, setFailures] = useState<readonly IngestFailureNotice[]>([]);
  const [unreadableFailures, setUnreadableFailures] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Mirror of the latest board so SSE handlers patch the current snapshot
  // even before React re-renders between two quick events.
  const boardRef = useRef<BoardState>(board);
  const applyBoard = useCallback((next: BoardState) => {
    boardRef.current = next;
    setBoard(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSessions(token, { limit: SESSION_LIMIT }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        applyBoard({ kind: 'error', message: result.message });
      } else {
        applyBoard({ kind: 'ready', sessions: result.data.sessions, total: result.data.total });
      }
    });
    return () => controller.abort();
  }, [token, reload, onAuthRejected, applyBoard]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const unsubscribeIngest = sse.subscribe('session-ingested', (event) => {
      const sessionId = ingestedSessionId(event.data);
      if (sessionId !== null) {
        // A successful ingest supersedes the session's failure banner -
        // keeping it would present a resolved failure as current.
        setFailures((current) => current.filter((notice) => notice.sessionId !== sessionId));
      }
      // New persisted data exists; refetch instead of guessing its summary.
      setReload((current) => current + 1);
    });
    const unsubscribeFailed = sse.subscribe('ingest-failed', (event) => {
      const notice = toIngestFailureNotice(event.data);
      if (notice === null) {
        // A failure frame this build cannot read still announces a failure;
        // count it visibly instead of dropping the bad news on the floor.
        setUnreadableFailures((count) => count + 1);
        return;
      }
      setFailures((current) => [
        ...current.filter((existing) => existing.sessionId !== notice.sessionId),
        notice,
      ]);
    });
    const unsubscribeStatus = sse.subscribe('agent-status-changed', (event) => {
      if (!isAgentStatusChangedEvent(event.data)) {
        // A frame this build cannot read still announces that something
        // changed. Dropping it silently would leave a board that looks
        // current but is not; refetch persisted truth instead.
        setReload((value) => value + 1);
        return;
      }
      const current = boardRef.current;
      if (current.kind !== 'ready') return;
      const result = applyAgentStatusChange(current.sessions, event.data);
      if (!result.matched) {
        setReload((value) => value + 1);
        return;
      }
      applyBoard({ ...current, sessions: result.sessions });
    });
    return () => {
      unsubscribeIngest();
      unsubscribeFailed();
      unsubscribeStatus();
    };
  }, [sse, applyBoard]);

  useEffect(() => {
    // A dropped stream is a hole in the board's event feed: every transition
    // that fired while disconnected is simply gone (SSE replays nothing), so
    // patched-in-place statuses go stale with no visual sign. Refetch persisted
    // truth once per recovery. The handler runs immediately with the CURRENT
    // state (see sse.ts), so a mount on an already-open stream sets no flag and
    // triggers no extra fetch.
    let wasInterrupted = false;
    return sse.onStateChange((state) => {
      if (state === 'reconnecting' || state === 'closed') {
        wasInterrupted = true;
      } else if (state === 'open' && wasInterrupted) {
        wasInterrupted = false;
        setReload((value) => value + 1);
      }
    });
  }, [sse]);

  const dismissFailure = useCallback((sessionId: string) => {
    setFailures((current) => current.filter((notice) => notice.sessionId !== sessionId));
  }, []);

  // Rendered in every board state: a failure that arrives while the snapshot
  // is still loading (or failed to load) is no less real.
  const failureBanners = (
    <>
      {failures.map((notice) => (
        <p key={notice.sessionId} className="truncation-banner" role="alert">
          <span className="status-error" aria-hidden="true">
            ✕
          </span>{' '}
          Ingest failed for session <code>{shortId(notice.sessionId)}</code>: {notice.reason}{' '}
          (attempt {notice.attempt},{' '}
          {notice.willRetry ? 'will retry' : 'quarantined until its transcript changes'}).{' '}
          <button type="button" onClick={() => dismissFailure(notice.sessionId)}>
            Dismiss
          </button>
        </p>
      ))}
      {unreadableFailures > 0 && (
        <p className="truncation-banner" role="alert">
          {unreadableFailures} ingest-failure frame{unreadableFailures === 1 ? '' : 's'} arrived in
          a shape this build cannot read - a session failed to ingest, details unknown.{' '}
          <button type="button" onClick={() => setUnreadableFailures(0)}>
            Dismiss
          </button>
        </p>
      )}
    </>
  );

  if (board.kind === 'loading') {
    return (
      <section aria-label="live status board">
        {failureBanners}
        <p className="muted">Loading sessions…</p>
      </section>
    );
  }
  if (board.kind === 'error') {
    return (
      <section aria-label="live status board">
        {failureBanners}
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load sessions: {board.message}
        </p>
        <button type="button" onClick={() => setReload((value) => value + 1)}>
          Retry
        </button>
      </section>
    );
  }

  const sessions = sortSessionsByRecency(board.sessions);

  return (
    <section aria-label="live status board">
      {failureBanners}
      {sessions.length === 0 ? (
        <p className="empty-state">
          No sessions ingested yet. The board fills as soon as the watcher persists a session from
          ~/.claude/projects.
        </p>
      ) : (
        <>
          <p className="muted">
            {board.total > sessions.length
              ? `Showing ${String(sessions.length)} of ${String(board.total)} sessions (most recent first).`
              : `${String(sessions.length)} session${sessions.length === 1 ? '' : 's'}, most recent first.`}
          </p>
          <ul className="board" aria-label="sessions">
            {sessions.map((session) => {
              const recency = formatRelativeTime(session.lastActivityAt, nowMs);
              const sessionStatus = statusMeta(session.status);
              return (
                <li key={session.id} className="card">
                  <div className="card-head">
                    <code>{shortId(session.id)}</code>
                    <span className={session.projectSlug === null ? 'muted' : undefined}>
                      {projectLabel(session.projectSlug)}
                    </span>
                    <span
                      className={`session-status ${sessionStatus.className}`}
                      data-testid={`session-status-${session.id}`}
                    >
                      <span aria-hidden="true">{sessionStatus.symbol}</span> {sessionStatus.label}
                    </span>
                    <span className="muted card-recency">{recency ?? 'no timestamp'}</span>
                  </div>
                  <div className="card-buckets" aria-label={`status counts for ${session.id}`}>
                    {AGENT_STATUSES.map((status) => {
                      const meta = STATUS_META[status];
                      // A bucket the server omitted is a hole in the snapshot,
                      // not a zero - it renders as `?`, never as "0 waiting".
                      const count = bucketCount(session.statusCounts, status);
                      return (
                        <span
                          key={status}
                          className={count === 0 ? 'bucket bucket-zero' : 'bucket'}
                        >
                          <span className={meta.className} aria-hidden="true">
                            {meta.symbol}
                          </span>{' '}
                          {count ?? '?'} {meta.label}
                        </span>
                      );
                    })}
                  </div>
                  <div className="card-metrics muted">
                    <span>
                      {session.agentCount} agent{session.agentCount === 1 ? '' : 's'}
                    </span>
                    <span>{formatTokens(session.totalTokens)} tokens</span>
                    <span>{formatUsd(session.totalCostUsd)}</span>
                    {session.unpricedTokens > 0 && (
                      <span className="unpriced">
                        ~ {formatTokens(session.unpricedTokens)} unpriced
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
