/**
 * App root (WP-U5): the token gate. No token in memory -> the entry screen
 * (which validates against /api/health before storing anything); a validated
 * token -> the shell. A 401 from inside the shell clears the token and
 * bounces back here with a notice.
 *
 * AMENDED 2026-09-07 (RT-1, TK-1, TK-2, TK-3). This component owns the two
 * questions the user can be silently wrong about, and it was answering neither:
 *
 *   - RT-1: an unrecognised hash resolves to the default view (there is nothing
 *     else to render) and NOTHING said so - so `#/agents` showed Live, the nav
 *     marked Live as the current page, and the address bar went on naming a
 *     route that does not exist here. The fallback stays; the silence does not.
 *   - TK-1/TK-2: `storeToken` and `clearToken` now report whether the store
 *     actually did what was asked, and the two ways that can go wrong have
 *     consequences the user has to be told about - one is a security fact ("the
 *     token is still on this machine"), the other a convenience fact ("this
 *     browser will not remember you"). Neither was surfaced anywhere.
 *   - TK-3: Lock cleared the notice, so the one transition a user performs
 *     deliberately to end their session was the only one that announced
 *     nothing at all.
 *
 * The notices are composed into the SINGLE `role="status"` paragraph the entry
 * screen already has, rather than added as extra live regions: two regions
 * racing to announce on the same mount is how a screen reader ends up reading
 * neither.
 */
import { useCallback, useState } from 'react';
import { Shell } from './Shell';
import { TokenScreen } from './TokenScreen';
import { clearToken, readToken, storeToken } from './token';
import { useRoute } from './router';
import { VIEWS } from './views/index';

/** Kept verbatim: the shell's 401 path is pinned to this sentence. */
const REJECTED_NOTICE = 'The server rejected the stored token. Enter it again.';

const LOCKED_NOTICE = 'You locked the dashboard. Enter the token again to reconnect.';

/**
 * TK-1. Said in terms of the thing the user can still do about it: closing the
 * tab is what ends a sessionStorage session regardless of what the store
 * decided, and on a shared machine that is the whole of the advice.
 */
const NOT_ERASED_NOTICE =
  'This browser could not remove the stored token, so a copy is still in this tab - close this tab to end the session on this machine.';

/** TK-2. The alternative story the user invents is "my token expired". */
const NOT_REMEMBERED_NOTICE =
  'This browser will not remember the token, so every reload will ask for it again.';

interface Session {
  readonly token: string | null;
  /** Why the user is on the entry screen, when they did not arrive by choice. */
  readonly notice: string | null;
  /** The store refused to keep the token (TK-2). */
  readonly notRemembered: boolean;
  /** The store still holds the token after a clear (TK-1). */
  readonly notErased: boolean;
}

export default function App() {
  const [session, setSession] = useState<Session>(() => {
    const stored = readToken();
    return {
      token: stored.kind === 'token' ? stored.token : null,
      notice: null,
      notRemembered: stored.kind === 'refused',
      notErased: false,
    };
  });
  const route = useRoute();

  const endSession = useCallback((why: string) => {
    const outcome = clearToken();
    setSession((prev) => ({
      ...prev,
      token: null,
      notice: why,
      notErased: outcome === 'refused',
    }));
  }, []);

  const handleAuthRejected = useCallback(() => {
    endSession(REJECTED_NOTICE);
  }, [endSession]);

  const handleLock = useCallback(() => {
    endSession(LOCKED_NOTICE);
  }, [endSession]);

  const handleSuccess = useCallback((value: string) => {
    const outcome = storeToken(value);
    setSession({
      token: value,
      notice: null,
      // A fresh write is fresh evidence about this browser, in both directions.
      notRemembered: outcome === 'refused',
      // Whatever was left behind has just been overwritten by this token.
      notErased: false,
    });
  }, []);

  if (session.token === null) {
    const parts: string[] = [];
    if (session.notice !== null) parts.push(session.notice);
    if (session.notErased) parts.push(NOT_ERASED_NOTICE);
    if (session.notRemembered) parts.push(NOT_REMEMBERED_NOTICE);
    const notice = parts.length > 0 ? parts.join(' ') : undefined;
    return <TokenScreen {...(notice !== undefined ? { notice } : {})} onSuccess={handleSuccess} />;
  }

  return (
    <>
      {/* RT-1. Above the shell rather than inside a view, because the miss is a
          fact about the whole page: the nav below is about to mark a view the
          reader did not ask for as the current one. */}
      {!route.recognised && (
        <p className="status-warn" role="alert" data-testid="unknown-route">
          This build has no view at <code>{route.requested}</code> - showing{' '}
          {VIEWS[route.view].navLabel} instead. The address bar still names a route that does not
          exist here, so a bookmark or a link to it will keep landing somewhere it did not ask for.
        </p>
      )}
      <Shell token={session.token} onLock={handleLock} onAuthRejected={handleAuthRejected} />
    </>
  );
}
