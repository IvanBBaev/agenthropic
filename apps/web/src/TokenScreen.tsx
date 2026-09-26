/**
 * Token entry screen (WP-U5). The SPA renders nothing else until possession
 * of the DASHBOARD_TOKEN is proven against /api/health. The token value is
 * validated BEFORE it is stored: a 401 keeps the user here with an inline
 * error and nothing persisted.
 *
 * AMENDED 2026-09-03 (AU-2, AU-4, AU-5). Three things this screen did to the
 * only person who ever sees it:
 *
 *   - it reported every non-401 outcome as "Server unreachable", including the
 *     one where the server had just ACCEPTED the token and only its response
 *     body was unreadable. That sentence sends a user to restart a running
 *     server, or to throw away a working token, and it is the only diagnostic
 *     they get before they are allowed anywhere else;
 *   - it answered an empty submit with nothing whatsoever: no request, no
 *     message, no movement. A button that does nothing reads as a broken app,
 *     and the user's next move is to reload or to go looking for a server
 *     fault that does not exist;
 *   - it left the focus on the button after a rejection, so the field that has
 *     to be corrected was not the one the keyboard was pointed at, and a
 *     screen-reader user heard the error with nothing to navigate to.
 *
 * AMENDED 2026-09-07 (TK-3). AU-5 landed the caret on the field after a
 * REJECTION and stopped there, so the other way a user arrives on this screen
 * - being sent back to it, by Lock or by a 401 from inside the shell - was
 * still silent. The shell unmounts, the document becomes a completely
 * different document, focus falls back to `document.body`, and a non-sighted
 * user is told nothing has changed. The notice is now bound to the field the
 * same way the error already was, and the arrival moves the caret there.
 *
 * AMENDED 2026-09-23 (B1). The field stays editable while a probe is in flight
 * - only the button is disabled - so a user who corrects a mistyped token
 * before the verdict on the old one lands was shown "Invalid token: the server
 * rejected it." beside a string the server had never seen, with `aria-invalid`
 * on the input asserting the same thing to a screen reader. The onChange
 * handler below already states the policy this broke ("a stale verdict left on
 * screen is a claim nobody made"); it simply could not enforce it against a
 * verdict that arrives AFTER the edit. A verdict is now stored together with
 * the string it judges, so the screen can tell the two apart: when the field
 * has moved on under it, the sentence says which string it is about and the
 * field - whose contents nothing has judged - is not marked invalid.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { checkHealth, type HealthResult } from './api';

export interface TokenScreenProps {
  /** Called with the validated token; the caller stores it and mounts the shell. */
  readonly onSuccess: (token: string) => void;
  /** Optional message shown when the shell bounced the user back here. */
  readonly notice?: string;
}

/** Said in the form the user can act on: the field, not the transport. */
const EMPTY_TOKEN_ERROR = 'The token field is empty - paste the dashboard token first.';

/**
 * Appended when the field no longer holds the string the verdict judges (B1).
 * It names the subject rather than withdrawing the verdict: the probe really
 * did fail, and dropping that on the floor would leave the user waiting for an
 * answer that has already come and gone.
 */
const STALE_VERDICT_NOTE =
  'That verdict is about the token that was submitted; the field has been edited since, and the text now in it has not been checked.';

/**
 * A displayed message together with the exact string it is a verdict about -
 * the trimmed field text at submit time, or `''` for the empty-field answer.
 * Keeping the subject is what lets the screen notice that the field has moved
 * on since the verdict was asked for.
 */
interface TokenVerdict {
  readonly message: string;
  readonly judged: string;
}

/**
 * Turn a failed health probe into the sentence that is actually true (AU-2).
 * The three `unreachable` reasons are three different situations with three
 * different next actions, and only one of them is about the token.
 */
function describeFailure(result: Exclude<HealthResult, { kind: 'ok' }>): string {
  if (result.kind === 'unauthorized') {
    return 'Invalid token: the server rejected it.';
  }
  switch (result.reason) {
    case 'no-response':
      return `Server unreachable: ${result.message}. Nothing answered on this origin - check that the dashboard server is running.`;
    case 'server-error':
      // PP2: an HTTP error proves only that SOMETHING answered on this origin.
      // Under the two-dev-server setup Vite's proxy answers 500 itself when the
      // API server is down, so "the server is running" was not known.
      return `Something on this origin answered with HTTP ${String(result.status)} - the dashboard server, or a proxy in front of it - and the health check failed: ${result.message}. The token was neither accepted nor rejected - check that the dashboard server is running and healthy, then try again.`;
    case 'malformed':
      return `The server accepted this token, but this page cannot read its health response (${result.message}). The token is fine; this build and the server disagree about the shape of the data.`;
  }
}

export function TokenScreen({ onSuccess, notice }: TokenScreenProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TokenVerdict | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Put the caret back where the correction has to be made. The ref is
   * non-null by construction here: the input is rendered unconditionally by
   * this same component, and every caller is an event handler on it.
   */
  function refocus(): void {
    inputRef.current!.focus();
  }

  /**
   * TK-3. A notice means the user did not come here, they were SENT here -
   * they locked, or the shell bounced them. Putting the caret in the field is
   * the difference between "a page changed somewhere" and "you are here, and
   * this is the thing to do". On a cold open there is no notice and the user
   * moved themselves, so nothing is taken from them.
   */
  useEffect(() => {
    if (notice !== undefined) {
      inputRef.current!.focus();
    }
  }, [notice]);

  /**
   * Both the notice and the error describe this one field, so both ids belong
   * here; a screen reader reads them in order at the point of correction.
   */
  /**
   * The verdict on screen judges `error.judged`; the field holds `value`. They
   * can only differ through the in-flight race B1 describes, because any edit
   * made while a verdict is displayed clears it outright.
   */
  const staleVerdict = error !== null && error.judged !== value.trim();

  const describedBy = [
    notice !== undefined ? 'token-notice' : null,
    error !== null ? 'token-error' : null,
  ]
    .filter((id): id is string => id !== null)
    .join(' ');

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // A probe is already in flight; a second Enter must not start another.
    if (busy) return;
    const token = value.trim();
    if (token.length === 0) {
      // Deliberately without a request: the answer is knowable here, and a
      // probe with an empty credential only teaches the log a bad habit.
      setError({ message: EMPTY_TOKEN_ERROR, judged: '' });
      refocus();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await checkHealth(token);
    setBusy(false);
    if (result.kind === 'ok') {
      onSuccess(token);
      return;
    }
    setError({ message: describeFailure(result), judged: token });
    refocus();
  }

  return (
    <form
      className="token-form"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      aria-label="token entry"
    >
      <h1>agenthropic</h1>
      <p>Enter the dashboard token to connect.</p>
      {notice !== undefined && (
        <p className="status-warn" role="status" id="token-notice">
          {notice}
        </p>
      )}
      <label htmlFor="token-input">Dashboard token</label>
      <input
        id="token-input"
        ref={inputRef}
        type="password"
        autoComplete="off"
        aria-invalid={error !== null && !staleVerdict}
        // Bound to the live region so the reason is re-read at the field the
        // focus has just moved to, instead of only once as it appears.
        // AMENDED 2026-09-07 (TK-3): this bound only `token-error`, so a
        // notice - the sentence explaining why the user is back on this screen
        // at all - was announced once on arrival and then unreachable from the
        // field. Both ids are composed now; the error half is unchanged.
        {...(describedBy !== '' ? { 'aria-describedby': describedBy } : {})}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          // The message is a verdict about a specific string. Once the string
          // changes, the verdict is stale, and a stale verdict left on screen
          // is a claim nobody made.
          setError(null);
        }}
      />
      {error !== null && (
        <p className="status-error" role="alert" id="token-error">
          {staleVerdict ? `${error.message} ${STALE_VERDICT_NOTE}` : error.message}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}
