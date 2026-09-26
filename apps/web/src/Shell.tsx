/**
 * App shell (WP-U5): header (brand, connection chip, lock), sidebar nav for
 * the four v1.0 views (ux0-design SS1), and the routed view mount. Persistent
 * chrome carries the uncertainty legend - the honesty vocabulary is never
 * hidden behind a tooltip.
 */
import { useEffect, useState } from 'react';
import { checkHealth, type HealthUnreachableReason } from './api';
import { useHashRoute, viewHash, VIEW_IDS } from './router';
import {
  createSseClient,
  SERVER_EVENT_TYPES,
  type SseClient,
  type SseConnectionState,
} from './sse';
import {
  ABSENT_STATUS_REASON,
  AGENT_STATUSES,
  NO_FIGURE_META,
  NULL_STATUS_META,
  STATUS_META,
  UNRECOGNISED_STATUS_LABEL,
  UNRECOGNISED_STATUS_SYMBOL,
} from './views/status';
import { ErrorBoundary, SERVER_DATA_CAUSE } from './ErrorBoundary';
import { VIEWS } from './views/index';

/**
 * The legend is generated from the status vocabulary itself, so every symbol
 * the app can paint - including `unrecorded` and the `unrecognised` fallback
 * for a status this build does not know - is explained. A symbol that could
 * appear but is missing here would be uncertainty conveyed by glyph alone.
 *
 * AMENDED 2026-09-08 (SH-1). The rule above is about SYMBOLS, and by that
 * rule the legend was complete: `?` was listed. But SV-3 split what `?` means
 * without the legend noticing, because the split happened in the parenthetical
 * rather than in the glyph. A row can now read `? unrecognised (zombie)` - the
 * server sent a status word this build has never learned - or
 * `? unrecognised (no status word sent)` - no status word arrived at all, which
 * is a fact about the SERVER'S PAYLOAD and not about the agent. Those are
 * different events with different people to go and ask, and the legend answered
 * both with the single word `unrecognised`, leaving the reader to infer from a
 * parenthetical it had never mentioned that there were two cases at all.
 *
 * The glyph deliberately stays one glyph (see `status.ts`: in both cases this
 * build cannot map what it got onto the vocabulary, and a fourth symbol would
 * buy precision the reader has to memorise). What changes is that the legend
 * now names both parentheticals it can produce, and quotes the absence phrase
 * from the constant that renders it rather than restating it here.
 *
 * AMENDED 2026-09-23 (lane-P). `unrecognisedStatusMeta` now prints the raw
 * word inside quotes, so that a word which renders as nothing - `''`, or
 * whitespace - is still visible as something the server sent. The legend says
 * "in quotes" because that punctuation is now carrying meaning: it is the
 * boundary of the server's own bytes, and a reader who meets `unrecognised
 * ("")` needs to have been told that the quotes are the page's and the
 * emptiness is the server's, not the other way round.
 */
const LEGEND_STATUSES = [
  ...AGENT_STATUSES.map((status) => `${STATUS_META[status].symbol} ${STATUS_META[status].label}`),
  `${NULL_STATUS_META.symbol} ${NULL_STATUS_META.label}`,
  `${UNRECOGNISED_STATUS_SYMBOL} ${UNRECOGNISED_STATUS_LABEL} (the raw word in quotes, or "${ABSENT_STATUS_REASON}")`,
].join(' ');

/**
 * The second legend line: the DATA-gap vocabulary, as distinct from the
 * agent-status vocabulary above it. `no figure` is spelled out from its
 * constant rather than typed in here, so a glyph can never be painted in a
 * view without appearing in the legend that explains it.
 */
const LEGEND_GAPS = `— observed ┄ inferred ~ unpriced ${NO_FIGURE_META.symbol} ${NO_FIGURE_META.label}`;

/**
 * What the connection chip is ABOUT, printed beside it (F-2).
 *
 * The chip's only input is `SseConnectionState` - a property of the
 * EventSource socket and of nothing else. But it is rendered once, in the
 * persistent header, ABOVE ALL FOUR VIEWS, and three of those four never read
 * the stream: they fetch on mount and hold that answer for as long as the
 * reader stays on them. So a bare green "live" over a Cost view whose figures
 * were computed twenty minutes ago was not a mild overstatement - it was the
 * app's single honesty signal certifying precisely the thing it does not
 * measure, in the one colour a reader trusts without checking.
 *
 * Naming the subject costs two words and makes the claim true. What the
 * FIGURES are worth is a per-view fact, and each view states it beside its own
 * numbers rather than borrowing this chip's colour.
 */
const CONNECTION_SCOPE_LABEL = 'event stream';

type HealthState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly schemaVersion: number }
  | {
      readonly kind: 'unreachable';
      readonly message: string;
      /**
       * WHICH failure it was. `api.ts` has distinguished the three since the
       * token screen was fixed; this header discarded the distinction and
       * called all three the same thing. The HTTP status is deliberately not
       * carried alongside: for `server-error` it is already inside `message`,
       * and a second copy would be a field with no reader.
       */
      readonly reason: HealthUnreachableReason;
    };

export interface ShellProps {
  readonly token: string;
  /** Explicit user action: clear the token and return to the entry screen. */
  readonly onLock: () => void;
  /** The server answered 401 for the stored token: clear it and bounce back. */
  readonly onAuthRejected: () => void;
}

interface Chip {
  /**
   * Decorative glyph, rendered `aria-hidden` with the word beside it - the
   * convention every view already follows. It used to be part of `label`, so
   * the accessible name of the app's only staleness signal was the literal
   * string "● live", read out as a character.
   */
  readonly symbol: string | null;
  readonly label: string;
  readonly className: string;
  /**
   * What actually went wrong, as VISIBLE text beside the chip.
   *
   * This was a `title` attribute. A `title` on a span is unreachable by
   * keyboard and by touch and is not reliably exposed to assistive tech, so
   * the only explanation of "server unreachable" was a mouse tooltip - on the
   * one element in this app that says the numbers may be stale. Null in the
   * healthy states: a disclosure that is always on screen stops being read.
   */
  readonly detail: string | null;
}

/**
 * `closed` is not `reconnecting`. EventSource retries on its own for the
 * latter; the former is reached only by an explicit close or a fatal error,
 * after which nothing will bring the stream back by itself. That difference
 * is the whole content of the message, and the user cannot act on it without
 * being told.
 */
const STREAM_CLOSED_DETAIL =
  'the stream will not reconnect on its own - reload the page to resume live updates';

/**
 * The detail shown while the stream is retrying and has NEVER been open (SH-2).
 *
 * `sse.ts` reports `reconnecting` for any retryable failure, which is the right
 * call there and is load-bearing: LiveView treats it as an interruption and
 * refetches the board on the next open, and it must keep doing that whether or
 * not a connection existed before. But EventSource fires that same error for a
 * FIRST attempt that never landed, so the chip printed the word `reconnecting`
 * over a connection that had never existed. `re-` is a claim about the past,
 * and the reader who accepts it waits for something to come back that was never
 * there - and stops looking for the reason the app has no live data at all.
 *
 * A wrong or expired token does not reach here: the server answers 401,
 * EventSource treats a non-200 as fatal, and the state is `closed`. Nor does a
 * server that was already down at mount: the health probe fails and the
 * `unreachable` arm above answers first. What is left is the case with no other
 * signal on the page - the probe succeeded, so the server is up, and the stream
 * alone cannot get in.
 *
 * AMENDED 2026-09-09 (L3, D6): the wording is unchanged and stays true at any
 * attempt number - the first attempt did fail, and the browser is still
 * retrying. HOW MANY have failed since is carried by the chip's label beside
 * it (see `attemptSuffix`) rather than restated here, so the two never drift
 * into disagreeing about the same number.
 */
const STREAM_NEVER_OPENED_DETAIL =
  'the event stream has not connected yet - the first attempt failed and the browser is retrying';

/**
 * `(attempt N)` for a retrying chip, or nothing at all (D6).
 *
 * From the SECOND failed attempt on. `attempt 1` tells a reader nothing the
 * word beside it has not already said, and a counter that appears on every
 * blip is a counter people stop reading. From two upwards it is the entire
 * difference between a hiccup and a stream that is never coming back - the
 * header knew it had tried forty times and printed the same three words it
 * printed after one.
 *
 * Anything below 2 yields the empty string rather than a confident
 * `attempt 0`. The test is written as `>= 2` precisely so that a count which
 * is not a real number falls out on the SILENT side: an unknown figure is
 * said as nothing, never as a figure.
 */
function attemptSuffix(failedAttempts: number): string {
  return failedAttempts >= 2 ? ` (attempt ${String(failedAttempts)})` : '';
}

/**
 * The detail shown when the socket is open but the mount probe failed (F-2).
 *
 * The two disagree, and the reader is owed the disagreement rather than
 * whichever half is easier to paint: the open socket is proof the server is up
 * and accepted the token, and the failed probe is the whole reason the schema
 * version is missing from the header beside it. Saying only the first would
 * leave that absence unexplained; saying only the second would be false.
 */
function staleProbeDetail(message: string): string {
  return `the stream is open, so the server is reachable - but the health check this page ran failed (${message}), so the schema version is unknown until you re-check`;
}

/**
 * The three unreachable verdicts, said apart (AU-2 follow-up).
 *
 * `api.ts` separated these when the token screen was fixed, and this header
 * went on collapsing them into `server unreachable`. In two of the three that
 * word is false, and falsest exactly where it matters:
 *
 * - `server-error`: something ANSWERED - the dashboard server, or a proxy in
 *   front of it (PP2: under the two-dev-server setup Vite's proxy answers 500
 *   itself when the API server is down, so "the server is running" is NOT
 *   known). What is known is that this was not a network failure.
 * - `malformed`: the answer was 200. Every /api/* route on this server is auth-gated,
 *   so a 200 is proof the token was ACCEPTED - and the app's one chip for
 *   "can these numbers be trusted" was reporting a shape disagreement as a
 *   lost connection while hiding a successful authentication behind it.
 *
 * `no-response` keeps the original wording, because there it was always the
 * true one: nothing answered, and nothing judged the token.
 *
 * AMENDED 2026-09-23 (R-1): the three verdicts are built here and dressed as a
 * chip below, so that a CLOSED stream can add its own sentence to any of them
 * without the wording above being restated three times.
 */
function unreachableVerdict(health: Extract<HealthState, { kind: 'unreachable' }>): {
  readonly label: string;
  readonly detail: string;
} {
  switch (health.reason) {
    case 'no-response':
      return { label: 'server unreachable', detail: health.message };
    case 'server-error':
      return {
        label: 'server error',
        detail: `${health.message}: something on this origin answered - the dashboard server, or a proxy in front of it - so this token was neither accepted nor rejected`,
      };
    case 'malformed':
      return {
        label: 'unreadable response',
        detail: `${health.message} - the server answered, and because every /api/* route here is auth-gated that answer means this token was accepted; the disagreement is about the shape of the body, not the connection`,
      };
  }
}

/**
 * The unreachable verdict, plus the stream's own state when that state is
 * terminal (R-1).
 *
 * B3 stopped an UNANSWERED probe from outranking a dead stream and left this
 * arm's precedence resting on one argument: "the server is not answering both
 * outranks and explains a dead stream". That argument holds for `no-response`
 * and collapses for the other two, which exist precisely because something
 * ANSWERED - their own text says so, and `malformed` goes further and tells the
 * reader in as many words that the disagreement is "not the connection" while
 * the connection is the thing that has died. Either way the chip dropped
 * `STREAM_CLOSED_DETAIL`, the page's only sentence saying that live updates
 * have stopped for good and that a reload is the way back.
 *
 * The route in is not exotic and the app supplies it: a reader looking at a
 * correct `stream closed` chip presses `Re-check server`, the probe answers
 * 500 or answers 200 with a body this build cannot read, and the diagnosis of
 * the breakage is replaced by a sentence about the server being up.
 *
 * Both facts are kept, in the order they matter to the reader: the probe's
 * verdict is the news, and the dead stream is the part that is still true
 * whatever the probe found. `no-response` gets the sentence too - "the server
 * is down" explains why the stream died, but not that it will stay dead after
 * the server comes back, which is the only part anyone can act on.
 */
function unreachableChip(
  health: Extract<HealthState, { kind: 'unreachable' }>,
  streamClosed: boolean,
): Chip {
  const verdict = unreachableVerdict(health);
  return {
    symbol: null,
    label: verdict.label,
    className: 'chip chip-error',
    detail: streamClosed
      ? `${verdict.detail}; separately, ${STREAM_CLOSED_DETAIL}`
      : verdict.detail,
  };
}

function chipFor(
  health: HealthState,
  stream: SseConnectionState,
  everOpened: boolean,
  failedAttempts: number,
): Chip {
  /*
   * AMENDED 2026-09-02 (F-2): the `unreachable` arm used to short-circuit HERE,
   * above the stream switch entirely. The reasoning was sound as far as it went
   * - if the server cannot be reached there is nothing live to report - but the
   * health probe runs EXACTLY ONCE, at mount, and was never re-run. So the arm
   * did not report "the server is unreachable"; it reported "the server was
   * unreachable at some moment in this tab's history". One transient failure -
   * a probe fired while the server was still binding its port - pinned the
   * header to `server unreachable` for the life of the tab, while the stream
   * was open and every view was loading data fine. The app's one honesty
   * signal could be stuck wrong in both directions at once.
   *
   * An OPEN socket is the newer and the stronger evidence: the server
   * answered, accepted the token, and is holding a connection open right now.
   * It is read first. The stale verdict is not discarded - it survives as the
   * detail beside the chip, which is where it belongs, because it is still the
   * explanation for the missing schema version.
   */
  if (stream === 'open') {
    return {
      symbol: '●',
      label: 'live',
      className: 'chip chip-ok',
      detail: health.kind === 'unreachable' ? staleProbeDetail(health.message) : null,
    };
  }
  /*
   * AMENDED 2026-09-23 (B3): the guard used to be a bare `health.kind ===
   * 'checking'`, which let a probe with no answer yet outrank a stream that had
   * already given its last one. `closed` is terminal - EventSource reached a
   * fatal error or was closed outright, and nothing will bring it back without
   * a reload - so with a probe in flight the chip said `checking…`, under a
   * scope label that names the EVENT STREAM as its subject, over a stream this
   * code knew was dead; and `STREAM_CLOSED_DETAIL`, the only sentence telling
   * the reader a reload is required, was not on screen at all. Two ways in, and
   * neither is exotic: at mount the stream route can fail fatally (any non-200,
   * including the same-origin refusal) while the health request is still
   * outstanding, and `Re-check server` puts health back into `checking` by hand
   * - so the one control offered to a reader whose connection is broken
   * WITHDREW the diagnosis of the breakage. A probe that has not answered is
   * the absence of evidence; a closed stream is evidence. The closed arm of the
   * switch below is reached instead, unchanged, and is still the only place
   * that wording lives.
   *
   * The `unreachable` arm keeps its precedence: there the probe HAS answered,
   * and "the server is not answering" both outranks and explains a dead stream.
   *
   * AMENDED 2026-09-23 (R-1): that last sentence is still why the arm keeps its
   * precedence, and it was wrong about what the precedence COSTS. It is an
   * argument about `no-response` only - the other two verdicts are reached
   * because the server answered - and even there it explains why the stream
   * died without saying that it will stay dead once the server returns. The arm
   * is unchanged and still wins; it now carries the closed stream's own
   * sentence with it (see `unreachableChip`), so nothing outranks that sentence
   * off the page any more.
   */
  if (health.kind === 'checking' && stream !== 'closed') {
    return { symbol: null, label: 'checking…', className: 'chip chip-wait', detail: null };
  }
  if (health.kind === 'unreachable') {
    return unreachableChip(health, stream === 'closed');
  }
  switch (stream) {
    case 'connecting':
      return { symbol: null, label: 'connecting…', className: 'chip chip-wait', detail: null };
    case 'reconnecting': {
      // SH-2. Same amber, same glyph - a retrying stream is a warning either
      // way - but the word only claims a previous connection when there was
      // one, and the case that has no other signal on the page says so itself.
      //
      // AMENDED 2026-09-09 (L3, D6): the attempt count is appended to BOTH
      // forks, because it is a fact about the RETRYING and not about the word
      // chosen to describe it. A stream that has never been open can be on its
      // fortieth attempt exactly as a dropped one can, and that reader has the
      // least other evidence on the page - suppressing the number there would
      // hide it precisely where it is worth most.
      //
      // It is APPENDED, never allowed to change the word: forty failed first
      // attempts are still not a past connection, so the never-opened fork
      // keeps saying `connecting…` at attempt 40 as firmly as at attempt 1.
      // The count goes in the label rather than beside it so that it lands in
      // the chip's accessible name, inside the polite live region - a reader
      // who cannot see the header is told the retry is the fortieth too.
      const suffix = attemptSuffix(failedAttempts);
      return everOpened
        ? {
            symbol: '○',
            label: `reconnecting${suffix}`,
            className: 'chip chip-warn',
            detail: null,
          }
        : {
            symbol: '○',
            label: `connecting…${suffix}`,
            className: 'chip chip-warn',
            detail: STREAM_NEVER_OPENED_DETAIL,
          };
    }
    case 'closed':
      return {
        symbol: null,
        label: 'stream closed',
        className: 'chip chip-error',
        detail: STREAM_CLOSED_DETAIL,
      };
  }
}

export function Shell({ token, onLock, onAuthRejected }: ShellProps) {
  const view = useHashRoute();
  const [health, setHealth] = useState<HealthState>({ kind: 'checking' });
  const [stream, setStream] = useState<SseConnectionState>('connecting');
  /** Whether the stream has ever been open - the evidence `reconnecting` needs. */
  const [streamEverOpened, setStreamEverOpened] = useState(false);
  /**
   * Consecutive failed connection attempts, straight from the stream client's
   * own ledger (D6) - never counted here. The Shell would have to re-derive it
   * from a state sequence it only partly sees, and a second tally of the same
   * events is a second chance to disagree with the first.
   */
  const [streamAttempts, setStreamAttempts] = useState(0);
  const [sse, setSse] = useState<SseClient | null>(null);
  /**
   * Frames that arrived and could not be read. Held here rather than in a view
   * because it outlives any one of them: the frame that was lost may have been
   * the ingest-failure notice for a session that consequently appears NOWHERE,
   * and a counter that unmounts with the Live view cannot say so.
   */
  const [droppedFrames, setDroppedFrames] = useState(0);
  /**
   * Frames that never arrived at all (LV-2). `sse.ts` proves these from the
   * server's `id:` sequence and has exposed them since that fix; nothing read
   * the number, so the one loss the client can prove was the one it never
   * mentioned. Kept apart from `droppedFrames` for the reason the stream
   * client keeps them apart: a dropped frame arrived and could not be used, a
   * missed frame never came, and a single total would understate both.
   */
  const [missedFrames, setMissedFrames] = useState(0);
  /**
   * Bumped by the re-check button (F-2). The probe lives in an effect rather
   * than in the click handler so that BOTH the mount probe and every re-check
   * inherit the same `AbortController` teardown - a re-check fired just before
   * the reader hits Lock must not be able to answer 401 for a shell that no
   * longer exists and log out the session that replaced it.
   */
  const [probeNonce, setProbeNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void checkHealth(token, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'ok') {
        setHealth({ kind: 'ok', schemaVersion: result.schemaVersion });
      } else if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else {
        setHealth({ kind: 'unreachable', message: result.message, reason: result.reason });
      }
    });
    return () => controller.abort();
  }, [token, onAuthRejected, probeNonce]);

  useEffect(() => {
    const client = createSseClient(token, { knownEventTypes: SERVER_EVENT_TYPES });
    setSse(client);
    // A new client is a new tally. Carrying the old count over would attribute
    // one connection's losses to another.
    setDroppedFrames(0);
    setMissedFrames(0);
    const unsubscribe = client.onStateChange((state, attempts) => {
      setStream(state);
      setStreamAttempts(attempts);
      if (state === 'open') setStreamEverOpened(true);
    });
    const unsubscribeDrops = client.onFrameDropped((frame) => setDroppedFrames(frame.total));
    const unsubscribeGaps = client.onFrameGap((gap) => setMissedFrames(gap.total));
    return () => {
      unsubscribe();
      unsubscribeDrops();
      unsubscribeGaps();
      client.close();
      setSse(null);
    };
  }, [token]);

  /**
   * Ask again. The old verdict is cleared first: leaving `server unreachable`
   * on screen while its replacement is in flight would be showing the answer
   * to a question that has already been asked again.
   */
  const recheckHealth = (): void => {
    setHealth({ kind: 'checking' });
    setProbeNonce((nonce) => nonce + 1);
  };

  const chip = chipFor(health, stream, streamEverOpened, streamAttempts);
  const active = VIEWS[view];

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">agenthropic</span>
        {/* The live region wraps chip AND detail, so a state change is
            announced with its explanation rather than as a silent DOM mutation
            in a header the reader has no reason to re-visit. */}
        <span className="connection" role="status" aria-live="polite">
          {/* Static, so the live region does not re-announce it; present at
              all times, because a chip that only names its subject while it is
              red would be scoping the claim exactly where the claim is safe. */}
          <span className="muted connection-scope" data-testid="connection-scope">
            {CONNECTION_SCOPE_LABEL}
          </span>{' '}
          <span className={chip.className} data-testid="connection-chip">
            {chip.symbol !== null && (
              <>
                <span aria-hidden="true">{chip.symbol}</span>{' '}
              </>
            )}
            {chip.label}
          </span>
          {chip.detail !== null && (
            <span className="muted chip-detail" data-testid="connection-detail">
              {chip.detail}
            </span>
          )}
          {/* Only once there is something to say. A permanent "0 unread" would
              be one more always-on badge for a reader to stop noticing, and the
              whole value of this one is that its appearance is the message. */}
          {droppedFrames > 0 && (
            <span className="chip chip-warn" data-testid="dropped-frames">
              {droppedFrames} unread {droppedFrames === 1 ? 'frame' : 'frames'}
            </span>
          )}
          {/* Its own chip, not added to the one above: the two numbers answer
              different questions, and a reader who sees them summed cannot
              tell which loss they are looking at. */}
          {missedFrames > 0 && (
            <span className="chip chip-warn" data-testid="missed-frames">
              {missedFrames} missed {missedFrames === 1 ? 'frame' : 'frames'}
            </span>
          )}
        </span>
        {/* Outside the live region: a control that is re-announced every time
            the stream flickers is a control the reader learns to ignore. A
            real button, so it is reachable by keyboard and by touch - the
            failure it answers used to be permanent precisely because there was
            no way at all to ask the question a second time. */}
        {health.kind === 'unreachable' && (
          <button
            type="button"
            className="recheck"
            data-testid="recheck-health"
            onClick={recheckHealth}
          >
            Re-check server
          </button>
        )}
        {missedFrames > 0 && (
          <span className="muted chip-detail" data-testid="missed-frames-detail">
            the server numbered frames that never reached this page - a reload re-reads the current
            state, but an ingest-failure notice among them cannot be recovered by any refetch,
            because a quarantined session is either missing from the read API or still showing its
            last good pass, and neither body says which
          </span>
        )}
        {/* Neutral on purpose (PP1): a drop is either a frame that could not be
            parsed or a parsed frame a handler failed on, and this header holds
            only the count, not which - so it claims neither. */}
        {droppedFrames > 0 && (
          <span className="muted chip-detail" data-testid="dropped-frames-detail">
            the stream delivered {droppedFrames === 1 ? 'a frame' : 'frames'} this build failed to
            parse or to apply - something changed that is not on this screen; reload to re-read from
            the server
          </span>
        )}
        {health.kind === 'ok' && (
          <span className="muted schema">schema v{health.schemaVersion}</span>
        )}
        <button type="button" className="lock" onClick={onLock}>
          Lock
        </button>
      </header>
      <div className="shell-body">
        <nav className="sidebar" aria-label="views">
          {VIEW_IDS.map((id) => (
            <a
              key={id}
              href={viewHash(id)}
              className={id === view ? 'nav-link nav-active' : 'nav-link'}
              aria-current={id === view ? 'page' : undefined}
            >
              {VIEWS[id].navLabel}
            </a>
          ))}
          <p className="legend" aria-label="uncertainty legend">
            {LEGEND_STATUSES}
            <br />
            {LEGEND_GAPS}
          </p>
        </nav>
        <main className="view">
          <h1>{active.title}</h1>
          {sse !== null && (
            /* Keyed by the route so navigating away from a crashed view
               genuinely leaves it behind: without the key React would reuse
               this boundary instance across the switch and the next view
               would inherit a failure that was never its own. */
            <ErrorBoundary
              key={view}
              subject={`The ${active.title} view`}
              stillWorks="The navigation above still works, and the connection chip still reports the stream. The other views read the same server, so if this is a version mismatch they may be wrong in ways that do not crash."
              cause={SERVER_DATA_CAUSE}
            >
              <active.Component token={token} sse={sse} onAuthRejected={onAuthRejected} />
            </ErrorBoundary>
          )}
        </main>
      </div>
    </div>
  );
}
