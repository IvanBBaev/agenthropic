/**
 * (a) Live status board (WP-U6): what every session is doing right now.
 *
 * Ground truth is GET /api/sessions; the SSE stream then keeps the snapshot
 * honest between refetches - `agent-status-changed` moves one agent between
 * its session's status buckets in place, and `session-ingested` (or an event
 * for a session the snapshot does not know) triggers a refetch of persisted
 * truth rather than a client-side guess. All five status buckets - including
 * `unknown`, the watchdog's honest state - are always rendered, never
 * filtered. Heartbeats are SSE comment frames and never reach EventSource;
 * stream liveness lives in the shell's connection chip.
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
    const unsubscribeIngest = sse.subscribe('session-ingested', () => {
      // New persisted data exists; refetch instead of guessing its summary.
      setReload((current) => current + 1);
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

  if (board.kind === 'loading') {
    return (
      <section aria-label="live status board">
        <p className="muted">Loading sessions…</p>
      </section>
    );
  }
  if (board.kind === 'error') {
    return (
      <section aria-label="live status board">
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
  const now = Date.now();

  return (
    <section aria-label="live status board">
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
              const recency = formatRelativeTime(session.lastActivityAt, now);
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
