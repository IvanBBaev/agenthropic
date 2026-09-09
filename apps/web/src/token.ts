/**
 * Dashboard token handling. The token lives ONLY in sessionStorage (and React
 * state) - never in localStorage, never in a cookie, and it must never be
 * logged or rendered.
 *
 * AMENDED 2026-09-03 (AU-6): every access here was unguarded, and Storage is
 * not guaranteed to exist or to work. A browser told to refuse site data
 * throws a SecurityError from the access itself; Safari's private mode used to
 * throw a QuotaExceededError from any write. The consequences were not equal:
 *
 *   - a throw from `readToken` came out of App's `useState` initialiser, which
 *     is a render throw before any boundary is mounted - a white page instead
 *     of a dashboard, for a browser setting;
 *   - a throw from `clearToken` came out of the Lock handler, so the one
 *     control whose whole job is to END a session could fail to end it and
 *     leave the user sitting inside the shell they just asked to leave.
 *
 * All three degrade to memory-only behaviour instead. The session still works;
 * only its survival across a reload is lost, which is the honest consequence
 * of a browser that will not store anything.
 *
 * AMENDED 2026-09-07 (TK-1, TK-2). AU-6 stopped the crashes and then answered
 * every refusal with the same value a healthy empty store returns, so the
 * caller could not tell the two apart and told the user nothing:
 *
 *   - TK-1 (security): `clearToken` swallowed a failed `removeItem` on the
 *     stated inference that "a storage that refuses to delete is a storage
 *     that never stored: the same call refused to write". That is not sound.
 *     Deletion and writing are separately gated, and a store can hold a value
 *     written earlier and only then start refusing - or silently ignoring -
 *     mutations, when a setting changes, a quota fills, or an extension swaps
 *     the object out. Lock then put the entry screen back over a credential
 *     that was still sitting in `sessionStorage`, ready for the next reload of
 *     the tab to read straight back in. The clear now tries a second lever
 *     (overwrite the slot, which `readToken` already treats as empty) and
 *     VERIFIES by read-back instead of inferring, so a caller that cannot
 *     erase the token at least knows it.
 *   - TK-2 (honesty): a refused read returned `null`, which is exactly what an
 *     empty store returns, so a user whose browser blocks site data was sent
 *     back to the entry screen on every reload with no explanation available
 *     to anyone. "Paste it again" and "this browser will never remember it"
 *     are different situations with different next actions; they now have
 *     different answers.
 *
 * Neither change widens where the token can live: still sessionStorage only,
 * still never logged, still never rendered.
 */
const TOKEN_KEY = 'agenthropic.token';

/** What the store held, distinguishing "nothing here" from "will not say". */
export type StoredToken =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'refused' };

/** Whether a write actually took effect, verified rather than assumed. */
export type StorageOutcome = 'persisted' | 'refused';

export function readToken(): StoredToken {
  let value: string | null;
  try {
    value = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return { kind: 'refused' };
  }
  // An empty string is not a credential; it is the shape `clearToken` leaves
  // behind when a delete was refused but a write was not.
  return value !== null && value.length > 0 ? { kind: 'token', token: value } : { kind: 'absent' };
}

export function storeToken(token: string): StorageOutcome {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    return 'refused';
  }
  // Read back rather than trust the absence of a throw: a store that accepts
  // the call and keeps nothing is the quiet half of the same failure, and the
  // user's expectation ("it will remember me") is identical in both.
  return readToken().kind === 'token' ? 'persisted' : 'refused';
}

/**
 * Erase the stored token. `'refused'` means the value is still in the store
 * after both attempts - the caller has to say so, because the user's session
 * is over in this tab's memory and NOT over on this machine.
 */
export function clearToken(): StorageOutcome {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Not fatal on its own: the overwrite below is a separate permission and
    // may still work. Falling through is the second attempt, not a shrug.
  }
  if (readToken().kind === 'absent') return 'persisted';
  try {
    sessionStorage.setItem(TOKEN_KEY, '');
  } catch {
    return 'refused';
  }
  return readToken().kind === 'absent' ? 'persisted' : 'refused';
}
