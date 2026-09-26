/**
 * Red-team pass on the authentication plumbing, 2026-09-03 (findings AU-2,
 * AU-4, AU-5, AU-6).
 *
 * The token gate already has integration coverage in `app.test.tsx`; this file
 * does not repeat it. It covers the paths that were reachable by an ordinary
 * user and produced either nothing, or a sentence that was not true:
 *
 *   - AU-2: the entry screen turned three different server verdicts into one
 *     "Server unreachable", including the case where the token had just been
 *     ACCEPTED. A user acting on that message goes and restarts a healthy
 *     server, or throws away a working token.
 *   - AU-4: submitting an empty field did nothing at all - no request, no
 *     message, no movement. Indistinguishable from a dead button.
 *   - AU-5: after a rejection the focus stayed on the button, so the field the
 *     user has to correct was not the one their keyboard was pointed at, and a
 *     screen-reader user was left with an announcement and no anchor.
 *   - AU-6: every storage access was unguarded. A browser configured to refuse
 *     site data (or Safari's old private mode) throws on those calls, and the
 *     throw came out of App's state initialiser - a white page instead of a
 *     dashboard - or out of the Lock handler, which is the one action that must
 *     never fail to end a session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../src/App';
import { TokenScreen } from '../src/TokenScreen';
import { clearToken, readToken, storeToken } from '../src/token';
import {
  costSummary,
  deferred,
  globalDag,
  jsonResponse,
  sessionList,
  sessionTree,
  textResponse,
} from './fixtures';
import { MockEventSource } from './mock-event-source';

const TOKEN_KEY = 'agenthropic.token';

const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = '';
  MockEventSource.reset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function healthResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function healthOk(): Response {
  return healthResponse(200, { status: 'ok', schemaVersion: 3 });
}

/** Same routing shape as the shell integration suite: the views fetch too. */
function routeFetch(): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/health')) return Promise.resolve(healthOk());
    if (url.includes('/tree')) return Promise.resolve(jsonResponse(200, sessionTree()));
    if (url.startsWith('/api/sessions')) return Promise.resolve(jsonResponse(200, sessionList()));
    if (url.startsWith('/api/dag/global')) return Promise.resolve(jsonResponse(200, globalDag()));
    if (url.startsWith('/api/cost/summary'))
      return Promise.resolve(jsonResponse(200, costSummary()));
    return Promise.reject(new Error(`unrouted fetch in test: ${url}`));
  });
}

function tokenInput(): HTMLElement {
  return screen.getByLabelText('Dashboard token');
}

function submitToken(value: string): void {
  fireEvent.change(tokenInput(), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

/**
 * Make one Storage method hostile. A browser that refuses site data throws a
 * SecurityError from the access itself; stubbing the method reproduces the
 * same throw at the same place in our code.
 */
function refuseStorage(method: 'getItem' | 'setItem' | 'removeItem'): void {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
}

describe('the entry screen names which of the three failures happened (AU-2)', () => {
  it('says "unreachable" only when nothing answered', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<App />);
    submitToken('secret-token');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Server unreachable');
    expect(alert.textContent).toContain('Failed to fetch');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('does not call a server that answered "unreachable"', async () => {
    // A 503 means the server is up, listening, and failing. Telling the user it
    // is unreachable sends them to restart a process that is already running,
    // and says nothing about the token - which was neither accepted nor
    // rejected, because the request never got as far as a verdict.
    fetchMock.mockResolvedValue(healthResponse(503, { error: 'maintenance' }));
    render(<App />);
    submitToken('secret-token');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('Server unreachable');
    expect(alert.textContent).toContain('503');
    // Under the two-dev-server setup Vite's proxy answers 500 itself when the
    // API server is down, so an HTTP error proves only that SOMETHING answered.
    expect(alert.textContent).toContain(
      'Something on this origin answered with HTTP 503 - the dashboard server, or a proxy in front of it',
    );
    expect(alert.textContent).not.toContain('The server is running');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('does not blame the token when the token was accepted', async () => {
    // 200 with a body this build cannot read. Every /api/* route is auth-gated, so a
    // 200 is proof the token IS valid. The old message accused the network and
    // left the user re-typing a token that was never the problem.
    fetchMock.mockResolvedValue(textResponse(200));
    render(<App />);
    submitToken('secret-token');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('Server unreachable');
    expect(alert.textContent).toContain('accepted');
    // Still not stored: this build cannot talk to that server, so letting the
    // user in would only move the failure one screen later.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('still blames the token on 401', async () => {
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'Unauthorized.' }));
    render(<App />);
    submitToken('bad-token');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Invalid token');
  });
});

describe('the entry screen answers an empty submit (AU-4)', () => {
  it('says the field is empty instead of doing nothing', async () => {
    render(<App />);
    submitToken('   ');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('empty');
    // The existing contract in app.test.tsx: no request is made for a blank
    // value. Answering the user must not be paid for with a pointless probe.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the one alert region, not a second one', async () => {
    // Two live regions racing to announce is how a screen reader ends up
    // reading neither cleanly.
    render(<App />);
    submitToken('');
    await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('the entry screen puts the cursor where the fix is (AU-5)', () => {
  it('focuses the token field after the server rejects the token', async () => {
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'Unauthorized.' }));
    render(<App />);
    submitToken('bad-token');

    await screen.findByRole('alert');
    expect(document.activeElement).toBe(tokenInput());
  });

  it('focuses the token field after an empty submit', async () => {
    render(<App />);
    submitToken('  ');

    await screen.findByRole('alert');
    expect(document.activeElement).toBe(tokenInput());
  });

  it('describes the field by its error so the reason survives the focus move', async () => {
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'Unauthorized.' }));
    render(<App />);
    submitToken('bad-token');

    const alert = await screen.findByRole('alert');
    const input = tokenInput();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.id).not.toBe('');
  });

  it('drops the stale verdict as soon as the value changes', async () => {
    // The message is a verdict about a specific string. Leaving it on screen
    // next to a different string is a claim nobody made.
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'Unauthorized.' }));
    render(<App />);
    submitToken('bad-token');
    await screen.findByRole('alert');

    fireEvent.change(tokenInput(), { target: { value: 'another-token' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(tokenInput().getAttribute('aria-invalid')).toBe('false');
  });

  /**
   * B1. The sibling test above covers the edit that happens while the verdict
   * is ON SCREEN; this is the edit that happens while the verdict is still IN
   * FLIGHT, which the same handler cannot clear because it has not been said
   * yet. Nothing disables the field during a probe, so the window is exactly as
   * wide as the request - and on a rejected token, correcting it immediately is
   * the single most likely thing a user does inside that window.
   */
  it('names which string a late verdict judges when the field moved on under it (B1)', async () => {
    const gate = deferred<Response>();
    fetchMock.mockReturnValue(gate.promise);
    render(<TokenScreen onSuccess={() => undefined} />);

    fireEvent.change(tokenInput(), { target: { value: 'bad-token' } });
    fireEvent.submit(screen.getByRole('form', { name: 'token entry' }));
    fireEvent.change(tokenInput(), { target: { value: 'corrected-token' } });
    await act(async () => {
      gate.resolve(healthResponse(401, { error: 'Unauthorized.' }));
      await gate.promise;
    });

    const alert = await screen.findByRole('alert');
    // The verdict is kept - the probe really did fail, and swallowing it would
    // leave the user waiting for an answer that has already come and gone.
    expect(alert.textContent).toContain('Invalid token');
    expect(alert.textContent).toContain('submitted');
    // ...but nothing has judged the string now in the box, so nothing may mark
    // it invalid - least of all to a reader who only hears the attribute.
    expect(tokenInput().getAttribute('aria-invalid')).toBe('false');
  });

  it('keeps marking the field invalid when the verdict is about what it holds', async () => {
    // The other side of the same branch: an untouched field IS the string the
    // server rejected, and the qualifier would be a lie there.
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'Unauthorized.' }));
    render(<App />);
    submitToken('bad-token');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('submitted');
    expect(tokenInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('ignores a second submit while the first is still in flight', async () => {
    const gate = deferred<Response>();
    fetchMock.mockReturnValue(gate.promise);
    render(<TokenScreen onSuccess={() => undefined} />);

    fireEvent.change(tokenInput(), { target: { value: 'secret-token' } });
    const form = screen.getByRole('form', { name: 'token entry' });
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(healthOk());
      await gate.promise;
    });
  });
});

describe('a browser that refuses site data cannot take the dashboard down (AU-6)', () => {
  it('reads no token instead of throwing out of the state initialiser', () => {
    refuseStorage('getItem');
    // AMENDED 2026-09-07 (TK-2). This line read `expect(readToken()).toBeNull()`.
    // The assertion was true but the answer it pinned was not: `null` was also
    // what an empty store returned, so this test certified that a browser which
    // REFUSES site data is indistinguishable from one that simply has nothing
    // stored - which is the whole of TK-2. `readToken` now returns a tagged
    // outcome and the refusal is a case of its own; the property this test
    // exists for (no throw out of the state initialiser, entry screen renders)
    // is unchanged and still asserted below.
    expect(readToken()).toEqual({ kind: 'refused' });
    render(<App />);
    expect(tokenInput()).toBeDefined();
  });

  it('lets the user in even when the token cannot be persisted', async () => {
    refuseStorage('setItem');
    routeFetch();
    expect(() => {
      storeToken('secret-token');
    }).not.toThrow();

    render(<App />);
    submitToken('secret-token');
    // The session works; only its survival across a reload is lost.
    await screen.findByRole('navigation', { name: 'views' });
  });

  it('locks the session even when the stored copy cannot be removed', async () => {
    routeFetch();
    render(<App />);
    submitToken('secret-token');
    await screen.findByRole('navigation', { name: 'views' });

    refuseStorage('removeItem');
    expect(() => {
      clearToken();
    }).not.toThrow();

    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));

    // Lock is the one control whose failure is a security failure: the user
    // asked for the session to end and must not be left inside it.
    await waitFor(() => {
      expect(tokenInput()).toBeDefined();
    });
    expect(screen.queryByRole('navigation', { name: 'views' })).toBeNull();
  });
});

/**
 * Red-team pass on the entry / routing surface, 2026-09-07 (TK-1, TK-2, TK-3,
 * RT-1). The App-level route test lives here rather than in `router.test.ts`
 * because that file is `.ts` and cannot render JSX; this file already owns the
 * `<App />` + fetch + EventSource harness.
 */

/**
 * A storage that accepts the call and does nothing. This is not a hypothetical
 * shape: it is what a `Storage` shim from a privacy extension, a partitioned
 * third-party context, or a quota-exhausted store looks like from our side -
 * no throw, no effect. `refuseStorage` above only covers the loud variant.
 */
function ignoreStorage(method: 'setItem' | 'removeItem'): void {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => undefined);
}

/**
 * TK-1 (security).
 *
 * WRONG BELIEF: "I clicked Lock, so this browser no longer holds the token."
 *
 * `clearToken` swallowed a failed `removeItem` on the stated inference that
 * "a storage that refuses to delete is a storage that never stored: the same
 * call refused to write". That inference is not sound. Deletion and writing
 * are separately gated - a store can hold a value written earlier in the
 * session and then start refusing (or silently ignoring) mutations when a
 * setting changes, a quota is hit, or an extension swaps the object out. In
 * that case Lock puts the entry screen back, the user believes the session is
 * over and walks away, and `sessionStorage['agenthropic.token']` still holds a
 * live dashboard credential that the next reload of this tab reads straight
 * back in. The credential outliving the act that was supposed to destroy it is
 * the failure; a Lock that cannot verify it must say so rather than assume.
 */
describe('Lock either erases the token or admits it could not (TK-1)', () => {
  it('reports the ordinary case as erased, and really erases it', () => {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    expect(clearToken()).toBe('persisted');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('overwrites the slot when the delete throws, so the token does not survive', () => {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    refuseStorage('removeItem');
    expect(clearToken()).toBe('persisted');
    // Blanked rather than removed: an empty slot is already treated as "no
    // token" by `readToken`, and a write that works is the only lever left
    // when the delete does not.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('');
  });

  it('reports "refused" when the delete is silently ignored and the write is too', () => {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    ignoreStorage('removeItem');
    ignoreStorage('setItem');
    expect(clearToken()).toBe('refused');
    // The point of the finding: the credential is demonstrably still there.
    expect(Storage.prototype.getItem.call(sessionStorage, TOKEN_KEY)).toBe('secret-token');
  });

  it('reports "refused" when both the delete and the overwrite throw', () => {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    refuseStorage('removeItem');
    refuseStorage('setItem');
    expect(clearToken()).toBe('refused');
  });

  it('tells the user, on the entry screen, that the token was not erased', async () => {
    routeFetch();
    render(<App />);
    submitToken('secret-token');
    await screen.findByRole('navigation', { name: 'views' });

    ignoreStorage('removeItem');
    ignoreStorage('setItem');
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));

    const status = await waitFor(() => screen.getByRole('status'));
    // The user's next act depends on this sentence: on a shared machine the
    // honest advice is to close the tab, which is the one thing that does end
    // a sessionStorage session no matter what the store decided to do.
    expect(status.textContent ?? '').toContain('could not remove');
    expect(status.textContent ?? '').toContain('close this tab');
  });
});

/**
 * TK-2 (honesty).
 *
 * WRONG BELIEF: "the dashboard forgot me" / "my token expired".
 *
 * AU-6 stopped a browser that refuses site data from crashing the app, and
 * stopped there: the refusal now returns `null`, which is the same answer as
 * "nothing was ever stored here". So a user in private mode, or with site data
 * blocked, is sent back to the entry screen on every single reload with no
 * explanation, and the only story available to them is that the dashboard or
 * the token is broken. The two situations need different next actions - one is
 * "paste it again", the other is "this browser will never remember it, so
 * either accept re-entering it or change the setting" - and the code had
 * collapsed them into one indistinguishable answer.
 */
describe('a browser that will not remember the token says so (TK-2)', () => {
  it('distinguishes an empty store from a store that refused', () => {
    expect(readToken()).toEqual({ kind: 'absent' });
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    expect(readToken()).toEqual({ kind: 'token', token: 'secret-token' });
    refuseStorage('getItem');
    expect(readToken()).toEqual({ kind: 'refused' });
  });

  it('treats a blank stored value as absent, not as a token', () => {
    sessionStorage.setItem(TOKEN_KEY, '');
    expect(readToken()).toEqual({ kind: 'absent' });
  });

  it('reports whether the write actually took', () => {
    expect(storeToken('secret-token')).toBe('persisted');
    refuseStorage('setItem');
    expect(storeToken('secret-token')).toBe('refused');
  });

  it('reports "refused" when the write is accepted and silently dropped', () => {
    // Verified by read-back rather than by the absence of a throw: a store
    // that returns normally and keeps nothing is the quiet half of this bug.
    ignoreStorage('setItem');
    expect(storeToken('secret-token')).toBe('refused');
  });

  it('warns on the entry screen when the store refused the read', () => {
    refuseStorage('getItem');
    render(<App />);
    const status = screen.getByRole('status');
    expect(status.textContent ?? '').toContain('will not remember');
  });

  it('warns after a lock when the token could not be persisted in the first place', async () => {
    refuseStorage('setItem');
    routeFetch();
    render(<App />);
    submitToken('secret-token');
    await screen.findByRole('navigation', { name: 'views' });

    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    const status = await waitFor(() => screen.getByRole('status'));
    expect(status.textContent ?? '').toContain('will not remember');
  });

  it('says nothing at all when the store works and no session was interrupted', () => {
    render(<App />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

/**
 * TK-3 (screen-reader parity).
 *
 * WRONG BELIEF: "nothing happened."
 *
 * Lock replaced the whole shell with the entry screen and set the notice to
 * `null`, so the one action a user takes deliberately to end their session was
 * the only transition in the app that announced nothing. The shell unmounts,
 * focus falls back to `document.body`, and a screen-reader user is left in a
 * document that has silently become a different document. The visible change
 * is total and the announced change is nil.
 */
describe('locking is announced and lands the caret where the work resumes (TK-3)', () => {
  it('announces the lock in a live region', async () => {
    routeFetch();
    render(<App />);
    submitToken('secret-token');
    await screen.findByRole('navigation', { name: 'views' });

    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    const status = await waitFor(() => screen.getByRole('status'));
    expect(status.textContent ?? '').toContain('locked');
  });

  it('moves focus to the token field when the screen carries a notice', async () => {
    routeFetch();
    render(<App />);
    submitToken('secret-token');
    await screen.findByRole('navigation', { name: 'views' });

    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(tokenInput());
    });
  });

  it('binds the notice to the field, so it is read at the point of correction', async () => {
    routeFetch();
    render(<App />);
    submitToken('secret-token');
    await screen.findByRole('navigation', { name: 'views' });

    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await waitFor(() => {
      expect(tokenInput().getAttribute('aria-describedby')).toBe('token-notice');
    });
  });

  it('leaves the caret alone on a first visit, where there is nothing to announce', () => {
    // Auto-focus is the answer to "you were moved here"; on a cold open the
    // user moved themselves, and stealing focus there is just noise.
    render(<App />);
    expect(document.activeElement).not.toBe(tokenInput());
  });

  it('keeps the error bound to the field even while a notice is on screen', async () => {
    // Both are about the same input, so both ids belong in `aria-describedby`;
    // AU-5 established the error half and this must not displace it.
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'Unauthorized.' }));
    sessionStorage.setItem(TOKEN_KEY, 'stale-token');
    render(<App />);
    await screen.findByLabelText('Dashboard token');

    submitToken('another-bad-token');
    await screen.findByRole('alert');
    expect(tokenInput().getAttribute('aria-describedby')).toBe('token-notice token-error');
  });
});

/**
 * RT-1, at the level the user meets it.
 *
 * WRONG BELIEF: "the view on screen is the one this URL names." An unknown
 * hash silently resolves to Live, the nav marks Live as the current page, and
 * the address bar goes on naming a route that does not exist here.
 */
describe('a hash this build has no view for is disclosed (RT-1)', () => {
  async function mountAt(hash: string): Promise<void> {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    window.location.hash = hash;
    routeFetch();
    render(<App />);
    await screen.findByRole('navigation', { name: 'views' });
  }

  it('names the route that does not exist and the view shown instead', async () => {
    await mountAt('#/agents');
    const banner = screen.getByTestId('unknown-route');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent ?? '').toContain('#/agents');
    expect(banner.textContent ?? '').toContain('Live');
    // The fallback still happens - there is nothing else to render - so the
    // view itself must be unaffected.
    expect(screen.getByRole('heading', { name: 'Live status' })).toBeDefined();
  });

  it('stays silent on a route that exists', async () => {
    await mountAt('#/cost');
    expect(screen.queryByTestId('unknown-route')).toBeNull();
  });

  it('stays silent when no route was asked for', async () => {
    await mountAt('');
    expect(screen.queryByTestId('unknown-route')).toBeNull();
  });

  it('withdraws the warning as soon as the reader navigates to a real view', async () => {
    await mountAt('#/agents');
    expect(screen.getByTestId('unknown-route')).toBeDefined();
    act(() => {
      window.location.hash = '#/cost';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.queryByTestId('unknown-route')).toBeNull();
    // ...and comes back, because the warning is a fact about the current hash
    // and not a one-shot banner that has been "dismissed".
    act(() => {
      window.location.hash = '#/nope';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.getByTestId('unknown-route')).toBeDefined();
  });
});
