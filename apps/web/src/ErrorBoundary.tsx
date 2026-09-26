/**
 * The crash boundary the app did not have (F-5).
 *
 * Before this, `main.tsx` mounted `<App />` bare and nothing in the tree
 * implemented `getDerivedStateFromError`, so React unmounted the ENTIRE tree
 * on any render throw. The trigger did not have to be exotic: every payload
 * reaches the views as an unchecked `body as T` cast (`api.ts`), so a server
 * one version ahead - a renamed field, a nullable one finally coming back
 * null - hands a formatter `undefined`, `formatTokens(undefined)` throws on
 * `.toLocaleString`, and the user gets a WHITE PAGE. Not the shell, not the
 * connection chip, not the nav to click away from the broken view. Loud, and
 * completely uninterpretable: the console was the only place that said what
 * happened, and nothing on screen said "this build cannot read this server".
 *
 * The project's stated crash-surface requirement is that a server one version
 * ahead must not take the UI down. A boundary cannot make the figures right,
 * and it deliberately does not try: it scopes the damage to the subtree that
 * threw, says so in words, and leaves the reader somewhere to go.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * What to put on screen for a thrown value.
 *
 * Anything can be thrown, not just an `Error`, and `String(someObject)` is
 * `'[object Object]'` - a message that tells the reader nothing is worse than
 * no message, because it looks like an answer. An `Error` with an empty
 * message is the same trap, so both fall through to a stated absence rather
 * than to an empty line.
 *
 * AMENDED 2026-09-03 (AU-3): this function stringified the thrown value with no
 * guard, so the one thing standing between a crash and the page could be
 * crashed by the crash. Anything may be thrown, and several ordinary things
 * cannot be converted to a string at all - a value with a null prototype, a
 * symbol, an object whose `toString` throws. The throw happened inside
 * `getDerivedStateFromError`, which React does not treat as handling anything:
 * it propagated to the last-resort boundary in `main.tsx`, which failed on the
 * same value for the same reason, and the white page this module exists to
 * prevent came back - reached through the prevention. `null` and `undefined`
 * join `[object Object]` in the same trap: "null" is not a message the server
 * sent, it is the absence of one wearing the shape of an answer.
 *
 * AMENDED 2026-09-07 (EB-2): AU-3 closed the case where stringifying THROWS and
 * left open the case where the value converts fine and simply is not a string.
 * An `Error` whose `message` has been replaced by an object - what several HTTP
 * clients and validation libraries attach when they wrap a response body -
 * satisfies `instanceof Error`, is not `=== ''`, and was returned as the
 * description. React refuses an object child, so the BOUNDARY'S OWN render
 * threw, and a contained single-view crash was promoted into a crash of the
 * whole dashboard at the root boundary. A non-string message is now an absent
 * message, which is what it is.
 *
 * AMENDED 2026-09-07 (EB-1): the message was passed through verbatim and
 * painted into the panel as ordinary, selectable, screenshot-able page text.
 * `api.ts` runs everything it emits through `redact()`, but a throw does not
 * come from `api.ts`: the realtime stream is an `EventSource`, which cannot
 * send an Authorization header, so CD-5 puts the dashboard token in the URL as
 * `?token=...` - and any platform or library error that quotes the URL it was
 * working on carries the credential into its message. Same for anything that
 * echoes the `Bearer` value it was about to send. This function is the LAST
 * thing between such a string and the screen, so credential-shaped material is
 * blanked here, in the describing, rather than being trusted not to arrive.
 */
export const UNDESCRIBED_FAILURE = 'the failure carried no message';

/** Renderings that look like a message and carry none. */
const EMPTY_RENDERINGS: ReadonlySet<string> = new Set(['', '[object Object]', 'null', 'undefined']);

/**
 * The credential shapes that can reach a thrown message. Deliberately narrow:
 * each one blanks the VALUE and keeps its name and the rest of the sentence,
 * because which request died is the whole diagnostic worth of the message and
 * a message redacted into uselessness just trades a leak for a mystery.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /([?&#](?:token|access_token|auth_token|api_key|apikey)=)[^&#\s'"]+/gi,
  /\b(Bearer\s+)[\w.~+/-]+=*/gi,
];

const REDACTED = '[redacted]';

function scrubCredentials(message: string): string {
  let scrubbed = message;
  for (const pattern of CREDENTIAL_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, `$1${REDACTED}`);
  }
  return scrubbed;
}

export function describeFailure(error: unknown): string {
  try {
    if (error instanceof Error) {
      const { message } = error;
      // `typeof` rather than a truthiness check: an object message is not an
      // absent one to JavaScript, but it is to React, and to a reader.
      return typeof message !== 'string' || message === ''
        ? UNDESCRIBED_FAILURE
        : scrubCredentials(message);
    }
    const rendered = String(error);
    return EMPTY_RENDERINGS.has(rendered) ? UNDESCRIBED_FAILURE : scrubCredentials(rendered);
  } catch {
    // Reading `.message` or stringifying threw. There is nothing left to say
    // about this value, and saying nothing is still better than joining it.
    return UNDESCRIBED_FAILURE;
  }
}

/**
 * What the panel says about WHY it is showing (PP6). Supplied by the call site
 * because only the call site knows: a per-view boundary sits around code whose
 * only input is server data, so a crash there is very likely this build
 * failing to read a newer server; the root boundary in `main.tsx` also guards
 * the token screen, the router and the header, where a crash may have nothing
 * to do with server data - and a panel that names a cause it does not know
 * sends the reader after the wrong one.
 */
export interface FailureCause {
  /** The sentence that opens the panel, before `stillWorks`. */
  readonly summary: string;
  /** What a retry can and cannot do, given that cause. */
  readonly retryAdvice: string;
}

/** For a boundary around a view that renders server data. */
export const SERVER_DATA_CAUSE: FailureCause = {
  summary: 'This build could not render what the server returned.',
  retryAdvice:
    'A retry re-fetches and re-renders. If it fails the same way, this build and the server disagree about the shape of the data - reloading will not help, and the server is very likely newer than this page.',
};

/** For a boundary whose subtree can fail for reasons it cannot name. */
export const UNATTRIBUTED_CAUSE: FailureCause = {
  summary: 'Something in this page failed while rendering; the cause is not known here.',
  retryAdvice:
    'A retry re-renders the page. If it fails the same way, the message above and the browser console are the best clues to what broke.',
};

interface ErrorBoundaryProps {
  /** What stopped rendering, named the way the reader sees it on screen. */
  readonly subject: string;
  /**
   * What still works, and what to do next. Supplied by the call site rather
   * than branched on here, because the honest sentence differs: a crashed view
   * leaves the nav usable, a crashed root leaves nothing.
   */
  readonly stillWorks: string;
  /** Why the panel thinks this happened - see `FailureCause`. */
  readonly cause: FailureCause;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  /** The message to show, or `null` while the subtree is rendering normally. */
  readonly failure: string | null;
  /**
   * How many times this subtree has thrown since it mounted (EB-3). Kept
   * across a retry on purpose: it is the only thing that distinguishes the
   * first crash from the fifth.
   */
  readonly failures: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failure: null, failures: 0 };

  static getDerivedStateFromError(error: unknown): Pick<ErrorBoundaryState, 'failure'> {
    return { failure: describeFailure(error) };
  }

  /**
   * The console clue is kept, not replaced. The on-screen text is a summary a
   * reader can act on; the stack is what a bug report needs, and dropping it
   * would trade one incomplete channel for another.
   *
   * ACCEPTED RESIDUAL 2026-09-07 (EB-1): the raw `error` is logged unredacted,
   * so a message that quotes the stream URL puts the token in the console. It
   * is left that way knowingly: React logs the same error object itself on
   * every caught throw, so scrubbing this one line would remove the stack
   * without removing the value from the console. The redaction is scoped to
   * what is PAINTED - the channel this module actually controls.
   */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[agenthropic] render failed:', this.props.subject, error, info);
    // `getDerivedStateFromError` is static and cannot read the previous state,
    // so the tally is kept here, where an updater can.
    this.setState((prev) => ({ ...prev, failures: prev.failures + 1 }));
  }

  private readonly retry = (): void => {
    // `failures` is deliberately preserved: resetting it would erase the one
    // fact that makes the second click different from the first.
    this.setState((prev) => ({ ...prev, failure: null }));
  };

  override render(): ReactNode {
    const { failure, failures } = this.state;
    if (failure === null) return this.props.children;
    return (
      <div className="view-error" role="alert" data-testid="error-boundary">
        <h2>{this.props.subject} stopped rendering</h2>
        <p className="empty-state">
          {this.props.cause.summary} {this.props.stillWorks}
        </p>
        <p className="muted" data-testid="error-boundary-message">
          {failure}
        </p>
        <button type="button" onClick={this.retry}>
          Try again
        </button>
        {/* Said plainly because the retry is genuinely likely to fail the same
            way, and a reader who is not told that will read a second crash as
            a second unrelated bug. A boundary cannot repair a shape mismatch;
            it can only stop one from taking the page. */}
        <p className="muted">{this.props.cause.retryAdvice}</p>
        {/* EB-3. Without this the panel after a retry is byte-identical to the
            panel before it, so nothing on screen says the retry was already
            answered - and for a screen-reader user the re-announcement of the
            same alert text is indistinguishable from an echo. The subject is
            named because two boundaries can be on screen at once. */}
        {failures > 1 && (
          <p className="muted" data-testid="error-boundary-repeat">
            {this.props.subject} has now failed {failures} times, the last one after a retry. Retry
            has been answered; the next useful step is elsewhere.
          </p>
        )}
      </div>
    );
  }
}
