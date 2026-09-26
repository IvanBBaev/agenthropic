/**
 * (a) Live status board (WP-U6): what every session is doing right now.
 *
 * Ground truth is GET /api/sessions; the SSE stream then keeps the snapshot
 * honest between refetches - `agent-status-changed` moves one agent between
 * its session's status buckets in place, and `session-ingested` (or an event
 * for a session the snapshot does not know) triggers a refetch of persisted
 * truth rather than a client-side guess. `ingest-failed` frames render as
 * dismissible banners: the banner is the only place its failure is visible, so
 * dropping the frame would present a partial corpus as complete.
 *
 * AMENDED 2026-09-23 (coverage-claim): the reason given here used to be "a
 * quarantined session never reaches the read API", which holds only for a
 * session that never ingested at all. One that ingested and LATER began
 * failing keeps the rows of its last good pass, is still listed by
 * /api/sessions, and is still summed into /api/cost/summary - with nothing in
 * either body saying the corpus has since moved on. So the banner is not
 * standing in for an absence; it is the only thing contradicting a session
 * that reaches this page looking current, which is the worse of the two
 * cases. Proved in the server's test/ingest-quarantine-coverage.test.ts. All five status buckets -
 * including `unknown`, the watchdog's honest state - are always rendered,
 * never filtered. Heartbeats are SSE comment frames and never reach
 * EventSource; stream liveness lives in the shell's connection chip.
 *
 * AMENDED 2026-09-03 (LV-2): the board now also renders what the stream's frame
 * sequence proves it MISSED. The refetch-on-recovery effect below repairs the
 * snapshot, so sessions, buckets and costs come back by themselves - but it
 * cannot repair `ingest-failed`: the refetch either does not carry the session
 * at all, or carries it at the extent of its last good pass and says nothing
 * about the difference. A failure announced while this tab was not listening is
 * therefore unrecoverable, and the gap notice is the only thing that can say it
 * happened. It reports a count and a range, never a guess at the contents.
 *
 * AMENDED 2026-09-23 (R-2, lane R): the gap notice was never able to be that
 * only thing, and the sentence above is the reason the hole stayed open. The
 * notice is derived from the server's `id:` sequence, so it cannot exist until
 * a frame arrives AFTER the loss - and the ordinary shape of an interruption on
 * a local machine is a drop, a reconnect, and then quiet, which delivers no such
 * frame. The board then repainted a refetched snapshot as unbroken continuity
 * over a feed it knew had a hole. The seam notice below is the second half: the
 * client's own connection state proves the hole exists, the id sequence proves
 * what was in it, and neither claims the other's evidence.
 *
 * AMENDED 2026-09-03 (LV-7): not every unapplied frame is a reason to refetch.
 * A frame this board has already folded into the row is absorbed by the model
 * and reported as matched, so the handler below leaves the board alone rather
 * than reloading: the row is right, and a stream that redelivers would
 * otherwise buy one full board refetch per redelivered frame. The refetch stays
 * the answer to a DISAGREEMENT - an unknown session, a bucket the snapshot
 * cannot support, a payload this build cannot read.
 *
 * AMENDED 2026-09-08 (LV-9): a status frame that arrives before the first
 * snapshot exists is still dropped, and still does not abort the fetch that is
 * already in flight - but it is no longer forgotten. That fetch may have been
 * read before the dropped transition was persisted, and the board cannot tell;
 * rendering its response as current then presented a snapshot that is knowingly
 * incomplete, with nothing on the page saying so. One refetch once the response
 * has landed settles which side of the read the transition fell on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSessions } from '../api';
import { readNowMs, useNowMs } from '../clock';
import {
  formatRelativeMs,
  formatRelativeTime,
  formatTokens,
  formatUsd,
  nameOrBlank,
  projectLabel,
  shortId,
} from '../format';
import type { BoardSession } from './live-model';
import {
  applyAgentStatusChange,
  bucketCount,
  isAgentStatusChangedEvent,
  livePatchCount,
  sortSessionsByRecency,
} from './live-model';
import { AGENT_STATUSES, NO_FIGURE_META, STATUS_META, statusMeta } from './status';
import type { ViewProps } from './types';
import { UnpricedNote } from './unpriced';

/** Page size for the board snapshot (server max is far above this). */
export const SESSION_LIMIT = 50;

/**
 * Shape of an `ingest-failed` payload the board can render. The frame rides
 * the shared union's generic arm (`{ type, payload }`), so the payload is
 * narrowed field-by-field here instead of by a shared schema.
 *
 * AMENDED 2026-09-09 (L4). There is no generic arm any more: `ingest-failed`
 * is now a typed arm of the closed union in `packages/shared/src/schemas/
 * realtime.ts`. The `{ type, payload }` envelope survived that change on
 * purpose, so the sentence above still describes the bytes even though it no
 * longer describes the schema - flattening the frame to match its two sibling
 * arms would have made every field test below fail at once, and this board
 * would have turned every quarantine notice into an anonymous tally with no
 * gate going red. What did not change is why the narrowing exists at all:
 * this bundle takes the shared package type-only (see `dto.ts`), so no schema
 * runs here at runtime and this function is the only thing standing between a
 * drifted server and the board. `test/realtime-wire-shape.test.ts` now pins
 * the two shapes together at compile time, so the next such change fails
 * `tsc` rather than failing quietly.
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

/**
 * Frames the stream's `id:` sequence proves this board never received (LV-2).
 * `missed` accumulates across gaps; the range names the most recent gap only,
 * because merging two ranges would claim frames that did arrive between them.
 */
interface StreamGapNotice {
  readonly missed: number;
  readonly from: number;
  readonly to: number;
  /** Observation number of the most recent gap (MM3); see `observationRef`. */
  readonly observation: number;
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
      readonly sessions: readonly BoardSession[];
      readonly total: number;
      /**
       * When the figures in these rows were read from the server. Stamped with
       * `readNowMs` (the event clock) rather than the render clock, because a
       * reading up to CLOCK_INTERVAL_MS old would date the snapshot before it
       * arrived - and this number's whole job is to be compared against now.
       */
      readonly fetchedAtMs: number;
      /**
       * The last gap/seam observation this read was issued after (MM3). A
       * banner may say its cards were refetched only when this is at least the
       * observation it describes.
       */
      readonly covers: number;
    };

/**
 * What a gap or seam banner may say about the refetch it triggered (MM3). It
 * used to claim "The cards below were refetched" from the moment the refetch
 * was requested - while the old cards were still on screen, and even after
 * the refetch failed and there were no cards at all.
 */
function refetchClause(board: BoardState, observation: number): string {
  if (board.kind === 'ready' && board.covers >= observation) {
    return 'The cards below were refetched after it.';
  }
  if (board.kind === 'error') return 'A refetch was requested and failed.';
  return 'A refetch was requested.';
}

export function LiveView({ token, sse, onAuthRejected }: ViewProps) {
  const [board, setBoard] = useState<BoardState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  // One banner per failed session (a retry replaces its predecessor), kept
  // until dismissed or superseded by a successful ingest - never toast-and-gone.
  const [failures, setFailures] = useState<readonly IngestFailureNotice[]>([]);
  const [unreadableFailures, setUnreadableFailures] = useState(0);
  const [streamGap, setStreamGap] = useState<StreamGapNotice | null>(null);
  /**
   * How many times the stream has dropped and come back while this board was
   * mounted (R-2, lane R).
   *
   * Kept apart from `streamGap` because it is a different kind of knowledge.
   * The gap notice is DERIVED - it reads the server's `id:` sequence and can
   * name the frames it proves went missing - and it therefore needs a later
   * frame to exist before it can say anything at all. This counter is
   * OBSERVED: the client saw its own connection die and come back, which is
   * proof that a hole exists without any evidence of what was in it. A stream
   * that drops while the corpus is quiet produces exactly that - a hole no id
   * will ever describe - and it was the case the board rendered as continuity.
   */
  const [interruptions, setInterruptions] = useState(0);
  /** Observation number of the most recent seam (MM3); see `observationRef`. */
  const [seamObservation, setSeamObservation] = useState(0);
  /**
   * Whether a seam was ever observed while this board was mounted (MM2). Not
   * cleared by dismissing the seam: the server's frame ids restart at 1 on
   * every boot, so once the stream has reconnected, any gap count may span two
   * id epochs and miss what was published before the resubscribe. It can
   * undercount, never overcount, so the count is shown as a lower bound.
   */
  const [seamEverObserved, setSeamEverObserved] = useState(false);
  /**
   * Monotonic count of gap/seam observations (MM3). Bumped synchronously
   * before the refetch is requested, so the fetch that answers an observation
   * reads a value at least that high when it starts.
   */
  const observationRef = useRef(0);
  // M-10: the recency labels move on the app's SHARED clock (see clock.ts)
  // rather than a per-render Date.now(). A quiet stream re-renders nothing on
  // its own, so a per-render reading froze "just now" on screen for hours; and
  // sharing the tick with the cost view's UTC windows means no two panels can
  // disagree about what "now" is.
  const nowMs = useNowMs();
  // Mirror of the latest board so SSE handlers patch the current snapshot
  // even before React re-renders between two quick events.
  const boardRef = useRef<BoardState>(board);
  const applyBoard = useCallback((next: BoardState) => {
    boardRef.current = next;
    setBoard(next);
  }, []);
  /**
   * Whether a status frame was thrown away while the FIRST snapshot was still
   * in flight (LV-9). A ref rather than state: it is read once, when that
   * snapshot lands, and never rendered.
   */
  const missedWhileLoadingRef = useRef(false);

  useEffect(() => {
    // Each fetch starts after every frame seen so far, so its read already
    // contains them - the flag belongs to the response in flight, not to the
    // component. Clearing here matters when the first fetch is superseded by a
    // reload before it lands.
    missedWhileLoadingRef.current = false;
    const covers = observationRef.current;
    const controller = new AbortController();
    void fetchSessions(token, { limit: SESSION_LIMIT }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        applyBoard({ kind: 'error', message: result.message });
      } else {
        applyBoard({
          kind: 'ready',
          sessions: result.data.sessions,
          total: result.data.total,
          fetchedAtMs: readNowMs(),
          covers,
        });
        if (missedWhileLoadingRef.current) {
          // LV-9: a status frame was dropped while this response was in the
          // air, and the response may have been read before that transition was
          // persisted. Settle it the way the board settles every other
          // disagreement. Bounded to one extra fetch per mount: the board is
          // ready from here on, so no later frame takes the dropping path.
          missedWhileLoadingRef.current = false;
          setReload((value) => value + 1);
        }
      }
    });
    return () => controller.abort();
  }, [token, reload, onAuthRejected, applyBoard]);

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
      if (current.kind !== 'ready') {
        // LV-9 (2026-09-08). The frame is still dropped - there is no snapshot
        // to patch, and refetching one already in flight would only abort it.
        // What was missing is the consequence: that in-flight read may have
        // been taken BEFORE this transition was persisted, and it then lands
        // and is rendered as the current state of the board with nothing on the
        // page saying a frame was discarded. Which side of the read the
        // transition fell on cannot be known from here, so the snapshot is
        // re-read once it has arrived.
        //
        // Only while LOADING. In the error state the next fetch is issued after
        // this frame anyway, so its read already contains the transition and a
        // second one would buy nothing.
        if (current.kind === 'loading') missedWhileLoadingRef.current = true;
        return;
      }
      const result = applyAgentStatusChange(current.sessions, event.data);
      if (!result.matched) {
        setReload((value) => value + 1);
        return;
      }
      applyBoard({ ...current, sessions: result.sessions });
    });
    const unsubscribeGap = sse.onFrameGap((gap) => {
      // What the gap CONTAINED is unknowable, so the notice claims only what
      // the sequence proves: how many frames, and which ids.
      observationRef.current += 1;
      const observation = observationRef.current;
      setStreamGap((current) => ({
        missed: current === null ? gap.missed : current.missed + gap.missed,
        from: gap.from,
        to: gap.to,
        observation,
      }));
      // Everything except the failure notices is recoverable from the snapshot,
      // so recover it - the banner then covers only what a refetch cannot.
      setReload((value) => value + 1);
    });
    return () => {
      unsubscribeIngest();
      unsubscribeFailed();
      unsubscribeStatus();
      unsubscribeGap();
    };
  }, [sse, applyBoard]);

  useEffect(() => {
    // A dropped stream is a hole in the board's event feed: every transition
    // that fired while disconnected is simply gone (SSE replays nothing), so
    // patched-in-place statuses go stale with no visual sign. Refetch persisted
    // truth once per recovery. The handler runs immediately with the CURRENT
    // state (see sse.ts), so a mount on an already-open stream sets no flag and
    // triggers no extra fetch.
    //
    // AMENDED 2026-09-23 (R-2, lane R): the refetch stays exactly as it was and
    // is no longer the only thing that happens. Repairing the snapshot silently
    // made the recovery INVISIBLE - the cards came back, the shell's chip went
    // back to `live`, and the one loss a refetch cannot repair went unmentioned
    // unless the id sequence happened to be able to prove it later. Now the
    // same signal that justifies the refetch also raises the seam below.
    let wasInterrupted = false;
    return sse.onStateChange((state) => {
      if (state === 'reconnecting' || state === 'closed') {
        wasInterrupted = true;
      } else if (state === 'open' && wasInterrupted) {
        wasInterrupted = false;
        observationRef.current += 1;
        setSeamObservation(observationRef.current);
        setSeamEverObserved(true);
        setReload((value) => value + 1);
        setInterruptions((value) => value + 1);
      }
    });
  }, [sse]);

  const dismissFailure = useCallback((sessionId: string) => {
    setFailures((current) => current.filter((notice) => notice.sessionId !== sessionId));
  }, []);

  // Rendered in every board state: a failure that arrives while the snapshot
  // is still loading (or failed to load) is no less real.
  //
  // AMENDED 2026-09-23 (lane-P): the reason is passed through `nameOrBlank`.
  // This banner is a `role="alert"` whose whole job is to say WHY an ingest
  // failed, and `toIngestFailureNotice` admits any string - it checks the type
  // and stops there. A reason of `''` rendered the sentence "Ingest failed for
  // session ffffffff…:  (attempt 1, will retry)", which announces a failure and
  // then says nothing at all about it: the reader concludes the cause is
  // unknowable rather than unsent, and a whitespace-only reason looked
  // identical. The raw bytes are quoted now, so the reader can quote them back
  // to whoever published the frame.
  const failureBanners = (
    <>
      {failures.map((notice) => (
        <p key={notice.sessionId} className="truncation-banner" role="alert">
          <span className="status-error" aria-hidden="true">
            ✕
          </span>{' '}
          Ingest failed for session <code>{shortId(notice.sessionId)}</code>:{' '}
          {nameOrBlank(notice.reason, 'reason')} (attempt {notice.attempt},{' '}
          {notice.willRetry ? 'will retry' : 'quarantined until its transcript changes'}).{' '}
          <button type="button" onClick={() => dismissFailure(notice.sessionId)}>
            Dismiss
          </button>
        </p>
      ))}
      {streamGap !== null && (
        <p className="truncation-banner" role="alert" data-testid="stream-gap">
          {seamEverObserved ? 'At least ' : ''}
          {streamGap.missed} {streamGap.missed === 1 ? 'frame' : 'frames'} published by the server
          never reached this board (most recent gap:{' '}
          {streamGap.from === streamGap.to
            ? `id ${String(streamGap.from)}`
            : `ids ${String(streamGap.from)}-${String(streamGap.to)}`}
          ).{' '}
          {seamEverObserved &&
            'The stream has reconnected since this board opened, and the server restarts its id numbering on every boot, so frames published across a restart may be missing from this count. '}
          {refetchClause(board, streamGap.observation)} An ingest failure announced in the gap
          cannot be recovered by any refetch: a quarantined session is either missing from the read
          API or still showing its last good pass, and neither body says which.{' '}
          <button type="button" onClick={() => setStreamGap(null)}>
            Dismiss
          </button>
        </p>
      )}
      {interruptions > 0 && (
        <p className="truncation-banner" role="alert" data-testid="stream-seam">
          The event stream dropped and reconnected {interruptions}{' '}
          {interruptions === 1 ? 'time' : 'times'} while this board was open. The server replays
          nothing, so whatever it published in the break never reached here. If the server
          restarted, the frames it published during the outage and restart cannot be detected by the
          frame-id sequence at all: the ids begin again at 1 on every boot.{' '}
          {refetchClause(board, seamObservation)} An ingest failure announced in the break cannot be
          recovered by any refetch: a quarantined session is either missing from the read API or
          still showing its last good pass, and neither body says which.{' '}
          <button type="button" onClick={() => setInterruptions(0)}>
            Dismiss
          </button>
        </p>
      )}
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
  // One age for the whole snapshot: every non-bucket figure on every card was
  // read in the same response.
  const snapshotAge = formatRelativeMs(board.fetchedAtMs, nowMs);

  return (
    <section aria-label="live status board">
      {failureBanners}
      {sessions.length === 0 ? (
        <p className="empty-state">
          No sessions ingested yet. The board fills when the ingest watcher persists a session, if
          ingest is enabled.
        </p>
      ) : (
        <>
          {/*
            A2 (2026-09-23). This was a two-way test, and `>` is not a total
            partition of two served numbers. `dto-guards.ts` checks that
            `total` is a number, not that it is a sane one, so a `total` that
            arrives NaN or Infinity fails `>` as quietly as an equal one does -
            and the else arm is an ASSERTION: "1 session, most recent first."
            says this board holds the corpus. A page of 50 rows then presents
            itself as the whole database while the figure that would have
            contradicted it is the one that could not be read.

            `total < sessions.length` is the same contradiction CV-5 states at
            the foot of the cost table: the server cannot serve more rows than
            it counts, so a payload that does is disagreeing with itself, and
            the view says so rather than picking the number it prefers.
          */}
          <p className="muted" data-testid="board-scope">
            {!Number.isFinite(board.total)
              ? 'Most recent first. The session count served with these rows came back unreadable, so whether this page is the whole corpus or a slice of it is unknown.'
              : board.total > sessions.length
                ? `Showing ${String(sessions.length)} of ${String(board.total)} sessions (most recent first).`
                : board.total < sessions.length
                  ? `Most recent first. These rows outnumber the ${String(board.total)} sessions the same read counts, so the served rows and the served count disagree.`
                  : `${String(sessions.length)} session${sessions.length === 1 ? '' : 's'}, most recent first.`}
          </p>
          <ul className="board" aria-label="sessions">
            {sessions.map((session) => {
              const recency = formatRelativeTime(session.lastActivityAt, nowMs);
              const sessionStatus = statusMeta(session.status);
              const patches = livePatchCount(session);
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
                      // not a zero - it renders as NO_FIGURE_META (∅, "no figure"),
                      // never as "0 waiting".
                      const count = bucketCount(session.statusCounts, status);
                      return (
                        <span
                          key={status}
                          className={count === 0 ? 'bucket bucket-zero' : 'bucket'}
                        >
                          <span className={meta.className} aria-hidden="true">
                            {meta.symbol}
                          </span>{' '}
                          {/*
                            LV-3 (2026-09-03). `?` is UNRECOGNISED_STATUS_SYMBOL:
                            printing it here said "the server sent a status this
                            build does not know", when the truth is "the server
                            sent no count for a status we do know". NO_FIGURE_META
                            is the vocabulary for a missing figure and already
                            exists. Symbol AND word, like every other entry in
                            this legend, so the fact survives for a reader who
                            gets no glyphs.
                          */}
                          {count ?? (
                            <>
                              <span className={NO_FIGURE_META.className}>
                                {NO_FIGURE_META.symbol}
                              </span>{' '}
                              {NO_FIGURE_META.label}
                            </>
                          )}{' '}
                          {meta.label}
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
                    {/* A3 (2026-09-23): was `session.unpricedTokens > 0 && ...`,
                        which withdrew this whole clause when the count arrived
                        unreadable - the card then showed a dollar figure with
                        nothing beside it, which on this board means "fully
                        priced". See views/unpriced.tsx. */}
                    <UnpricedNote tokens={session.unpricedTokens} lead="" />
                  </div>
                  {/* Only on a card the stream has actually rewritten. An
                      unpatched card is uniformly as old as the snapshot, and
                      saying so on every row would bury the rows where it is a
                      warning under the rows where it is a truism. */}
                  {patches > 0 && (
                    <p className="muted card-provenance" data-testid={`provenance-${session.id}`}>
                      Live from the stream: the buckets above, and the time beside them. Read{' '}
                      {snapshotAge} and not updated since: the session status, agent count, tokens
                      and cost ({patches} status {patches === 1 ? 'frame' : 'frames'} applied).
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
