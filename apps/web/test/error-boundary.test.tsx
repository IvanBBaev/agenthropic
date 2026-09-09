/**
 * Crash-boundary tests (F-5). The defect these pin: `main.tsx` mounted `<App />`
 * bare, nothing in the tree implemented `getDerivedStateFromError`, and every
 * payload reaches the views through an unchecked `body as T` cast - so one
 * renamed or newly-absent server field threw inside a formatter and React
 * unmounted the whole app to a blank white page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../src/App';
import { describeFailure, ErrorBoundary, UNDESCRIBED_FAILURE } from '../src/ErrorBoundary';
import { MockEventSource } from './mock-event-source';
import { UNREADABLE_BODY_MESSAGE } from '../src/api';
import { costSummary, jsonResponse, sessionList, sessionTree, globalDag } from './fixtures';

const TOKEN_KEY = 'agenthropic.token';

const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  window.location.hash = '';
  MockEventSource.reset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', MockEventSource);
  // React itself logs every boundary-caught error, and so does the boundary.
  // Silenced here so a PASSING suite does not print stack traces that read
  // like failures - the calls are asserted rather than merely suppressed.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Boom({ thrown }: { readonly thrown: unknown }): never {
  throw thrown;
}

function renderBoundary(thrown: unknown) {
  return render(
    <ErrorBoundary subject="The cost view" stillWorks="The navigation above still works.">
      <Boom thrown={thrown} />
    </ErrorBoundary>,
  );
}

describe('describeFailure', () => {
  it('uses the message of a real Error', () => {
    expect(describeFailure(new Error('perDay is not iterable'))).toBe('perDay is not iterable');
  });

  it('refuses to show an empty message as if it were one', () => {
    // An empty line under the heading reads as "no further detail available",
    // which is a claim; saying so in words is the same fact without the guess.
    expect(describeFailure(new Error(''))).toBe(UNDESCRIBED_FAILURE);
    expect(describeFailure('')).toBe(UNDESCRIBED_FAILURE);
  });

  it('refuses to show "[object Object]"', () => {
    // A message that tells the reader nothing is worse than no message,
    // because it looks like an answer.
    expect(describeFailure({ code: 'E_SHAPE' })).toBe(UNDESCRIBED_FAILURE);
  });

  it('passes a non-Error through when it stringifies to something readable', () => {
    expect(describeFailure('perDay is not iterable')).toBe('perDay is not iterable');
    expect(describeFailure(42)).toBe('42');
  });
});

describe('ErrorBoundary', () => {
  it('renders its children untouched while nothing throws', () => {
    render(
      <ErrorBoundary subject="The cost view" stillWorks="ignored">
        <p>the real view</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the real view')).toBeDefined();
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });

  it('names what failed, what still works, and why a retry may not help', () => {
    renderBoundary(new Error("Cannot read properties of undefined (reading 'map')"));

    const panel = screen.getByTestId('error-boundary');
    expect(panel.getAttribute('role')).toBe('alert');
    expect(screen.getByText('The cost view stopped rendering')).toBeDefined();
    expect(panel.textContent).toContain('The navigation above still works.');
    expect(screen.getByTestId('error-boundary-message').textContent).toBe(
      "Cannot read properties of undefined (reading 'map')",
    );
    // The honest half of the offer: the boundary cannot repair a shape
    // mismatch, and a reader not told that reads a second crash as a second
    // unrelated bug.
    expect(panel.textContent).toContain('reloading will not help');
  });

  it('keeps the console clue rather than trading one incomplete channel for another', () => {
    const error = new Error('boom');
    renderBoundary(error);

    const logged = vi
      .mocked(console.error)
      .mock.calls.filter((call) => call[0] === '[agenthropic] render failed:');
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toBe('The cost view');
    expect(logged[0]![2]).toBe(error);
  });

  it('re-renders the subtree on retry', () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('first render only');
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary subject="The cost view" stillWorks="ignored">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary')).toBeDefined();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('recovered')).toBeDefined();
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });
});

describe('the shell survives a view that cannot read the server', () => {
  /**
   * A cost summary that satisfies `isCostSummary` and that `CostView` still
   * cannot render: a `topSessions` row carrying all three figures and no
   * `sessionId`.
   */
  const costSummaryTheGuardsAccept = {
    ...costSummary(),
    topSessions: [{ tokens: 10, costUsd: 1, unpricedTokens: 0 }],
  };

  /**
   * The finding's own scenario, end to end: the server answers 200 with a body
   * this build cannot read (a renamed or dropped field), `api.ts` casts it
   * through unchecked, and the view throws inside render.
   *
   * AMENDED 2026-09-06 (CA-8/AU-10). The payload this helper sends changed, and
   * the reason is the amendment rather than a detail of it. It used to answer
   * `/api/cost/summary` with `{}`. `api.ts` now checks every body against
   * `dto-guards.ts` before it casts, so `{}` no longer reaches the view at all -
   * it is refused at the api layer and the panel says so in place. That is the
   * guards working, and it is pinned as its own test at the end of this block
   * rather than deleted.
   *
   * The boundary still has to be proved against a real render-time throw, so the
   * body sent here is one the guards ACCEPT and the view still cannot survive.
   * `dto-guards.ts` states in its own words that it certifies the load-bearing
   * subset of each DTO and not the whole contract: strings are left unchecked on
   * purpose, because a wrong string prints as itself and the reader can see it.
   * A MISSING string does not print as itself - `shortId(undefined)` reads
   * `.length` off it and throws. That is precisely the risk the guards leave
   * behind, which makes it the right thing to point the boundary at.
   */
  function routeFetchWithUnreadableCostSummary(body: unknown = costSummaryTheGuardsAccept): void {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/health'))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: 'ok', schemaVersion: 3 }),
        } as Response);
      if (url.includes('/tree')) return Promise.resolve(jsonResponse(200, sessionTree()));
      if (url.startsWith('/api/sessions')) return Promise.resolve(jsonResponse(200, sessionList()));
      if (url.startsWith('/api/dag/global')) return Promise.resolve(jsonResponse(200, globalDag()));
      if (url.startsWith('/api/cost/summary')) return Promise.resolve(jsonResponse(200, body));
      return Promise.reject(new Error(`unrouted fetch in test: ${url}`));
    });
  }

  it('shows the crash in place and leaves the nav and the chip standing', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    window.location.hash = '#/cost';
    routeFetchWithUnreadableCostSummary();
    render(<App />);

    await screen.findByTestId('error-boundary');
    // The whole point: chrome survives. Before the boundary existed this was a
    // blank page - no shell, no chip, and no nav to click away from the view
    // that broke.
    expect(screen.getByRole('navigation', { name: 'views' })).toBeDefined();
    expect(screen.getByTestId('connection-chip')).toBeDefined();
    // Named with the view's own title, the way the reader sees it in the nav
    // and the heading - not with a component name only this repo knows.
    expect(screen.getByText('The Cost and savings view stopped rendering')).toBeDefined();
  });

  it("does not carry one view's failure into the next", async () => {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    window.location.hash = '#/cost';
    routeFetchWithUnreadableCostSummary();
    render(<App />);
    await screen.findByTestId('error-boundary');

    fireEvent.click(screen.getByRole('link', { name: 'Live' }));
    window.location.hash = '#/live';
    window.dispatchEvent(new Event('hashchange'));

    // Keyed by the route: without the key React reuses the boundary instance
    // across the switch and the next view inherits a failure that was never
    // its own.
    await screen.findByText(/No sessions ingested yet/);
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });

  it('never reaches the boundary for a body the guards can refuse first', async () => {
    // The payload the two tests above used before CA-8/AU-10, kept as the proof
    // that the layer now standing in front of them does its job. A boundary is a
    // last resort, and every crash it catches is one the reader is told about in
    // the vocabulary of a formatter that died rather than of the payload that
    // was wrong. Refused at the api layer, the same body produces a sentence
    // about the body - and the panel around it keeps working.
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    window.location.hash = '#/cost';
    routeFetchWithUnreadableCostSummary({});
    render(<App />);

    // Asserted on the panel rather than on the sentence: the message shares its
    // paragraph with the `Could not load cost summary:` lead-in, so it is a
    // fragment of an element's text and not an element's text.
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'cost summary' }).textContent).toContain(
        UNREADABLE_BODY_MESSAGE,
      ),
    );
    expect(screen.queryByTestId('error-boundary')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'views' })).toBeDefined();
  });
});

/**
 * AU-3 (2026-09-03, red-team pass on the auth/crash plumbing). `describeFailure`
 * called `String(error)` unguarded, so the one function standing between a
 * thrown value and the page could itself throw on that value. When it throws
 * inside `getDerivedStateFromError`, React does not treat the boundary as
 * having handled anything: it propagates upward, and the last-resort boundary
 * in `main.tsx` fails on the same value for the same reason - so the blank
 * white page this whole module exists to prevent comes back, reached through
 * the prevention.
 *
 * The trigger is not exotic: any value with a null prototype, and any object
 * whose `toString` (or whose `message` getter) throws, produces it. A thrown
 * symbol was expected to and does not - `String()` accepts symbols - so that
 * case is recorded below as the edge of the finding, not as an instance.
 */
describe('describeFailure cannot be crashed by the value it describes (AU-3)', () => {
  it('survives a thrown value that has no prototype to stringify with', () => {
    // `String(Object.create(null))` throws TypeError: Cannot convert object to
    // primitive value.
    expect(describeFailure(Object.create(null) as unknown)).toBe(UNDESCRIBED_FAILURE);
  });

  it('survives a thrown symbol', () => {
    // Checked, not assumed: `String(sym)` is the one coercion path the language
    // lets a symbol through, so this case never was a crash - it produces a
    // perfectly readable description and is kept here as the boundary of the
    // finding rather than as part of it.
    expect(describeFailure(Symbol('token-refresh'))).toBe('Symbol(token-refresh)');
  });

  it('survives a thrown object whose toString throws', () => {
    const hostile = {
      toString(): string {
        throw new Error('nested');
      },
    };
    expect(describeFailure(hostile)).toBe(UNDESCRIBED_FAILURE);
  });

  it('survives an Error whose message getter throws', () => {
    const error = new Error('outer');
    Object.defineProperty(error, 'message', {
      get(): string {
        throw new Error('nested');
      },
    });
    expect(describeFailure(error)).toBe(UNDESCRIBED_FAILURE);
  });

  it('refuses to show "null" or "undefined" as if they were messages', () => {
    // Same trap the function already closes for `[object Object]`: a word that
    // looks like an answer and carries none. `String(null)` is not a message
    // the server sent, it is the absence of one.
    expect(describeFailure(null)).toBe(UNDESCRIBED_FAILURE);
    expect(describeFailure(undefined)).toBe(UNDESCRIBED_FAILURE);
  });

  it('still paints the fallback panel when the thrown value cannot be stringified', () => {
    // The end-to-end shape of the defect: before the fix this render threw out
    // of the boundary entirely and took the tree with it.
    renderBoundary(Object.create(null) as unknown);
    expect(screen.getByTestId('error-boundary')).toBeDefined();
    expect(screen.getByTestId('error-boundary-message').textContent).toBe(UNDESCRIBED_FAILURE);
    // The recovery affordance survives too - a boundary that cannot be clicked
    // out of is a nicer-looking dead end.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});

/**
 * Red-team pass on the failure-containment surface, 2026-09-07 (EB-1).
 *
 * LEAKED VALUE: the dashboard token itself. `describeFailure` returns the
 * thrown message verbatim and the boundary paints it into
 * `<p data-testid="error-boundary-message">` - ordinary page text, so it is
 * selectable, copyable, and in every screenshot of the crash that anyone
 * pastes into an issue. `api.ts` is careful about this and runs every message
 * it emits through `redact()`, but a throw does not come from `api.ts`: the
 * realtime stream is an `EventSource`, which cannot send an Authorization
 * header, so CD-5 puts the token in the URL as `?token=...`, and any library
 * or platform error that quotes the URL it was working on carries the
 * credential into the message. Same for anything that echoes the header value
 * it was about to send. The boundary is the LAST thing between that string and
 * the screen, and it was passing it straight through.
 */
describe('describeFailure keeps credential material off the screen (EB-1)', () => {
  const SECRET = 'kP9x-live-dashboard-secret';

  it('redacts a token carried in the stream URL', () => {
    const described = describeFailure(
      new Error(`EventSource failed: GET http://127.0.0.1:4317/api/stream?token=${SECRET} 500`),
    );
    expect(described).not.toContain(SECRET);
    expect(described).toContain('token=[redacted]');
    // Redacted, not erased: which request died is the whole diagnostic value
    // of the message, and dropping it would trade a leak for a mystery.
    expect(described).toContain('/api/stream');
    expect(described).toContain('500');
  });

  it('redacts a token carried as a bearer credential', () => {
    const described = describeFailure(new Error(`request failed with Bearer ${SECRET}`));
    expect(described).not.toContain(SECRET);
    expect(described).toContain('Bearer [redacted]');
  });

  it('redacts the other query spellings a proxy or a library may use', () => {
    for (const url of [
      `/api/stream?tail=1&token=${SECRET}`,
      `/api/stream#access_token=${SECRET}`,
      `/api/stream?api_key=${SECRET}&x=1`,
    ]) {
      const described = describeFailure(new Error(`fetch ${url} failed`));
      expect(described).not.toContain(SECRET);
    }
  });

  it('leaves an ordinary render failure exactly as it was', () => {
    // The redaction must not become a second source of doubt: a message with
    // no credential in it has to survive byte-for-byte, or a reader can no
    // longer trust that what they are reading is what was thrown.
    const message = 'perDay is not iterable';
    expect(describeFailure(new Error(message))).toBe(message);
  });

  it('does not paint the token into the crash panel', () => {
    renderBoundary(new Error(`GET /api/stream?token=${SECRET} failed`));
    const panel = screen.getByTestId('error-boundary');
    expect(panel.textContent ?? '').not.toContain(SECRET);
    expect(screen.getByTestId('error-boundary-message').textContent).toContain('token=[redacted]');
  });
});

/**
 * 2026-09-07 (EB-2).
 *
 * WRONG BELIEF: "this boundary can survive anything thrown at it."
 *
 * AU-3 closed the case where STRINGIFYING the thrown value throws. It did not
 * close the case where the value converts fine and simply is not a string: an
 * `Error` whose `message` has been replaced by an object. `error instanceof
 * Error` is true, `error.message === ''` is false, so the object is returned
 * as the description and handed to React as a child - and React refuses an
 * object child. The boundary's OWN render throws, which React does not treat
 * as handled, so a contained single-view crash is promoted into a crash of the
 * whole dashboard at the root boundary in `main.tsx`. That is precisely the
 * white page this module exists to prevent, reached through the prevention.
 * A structured `message` is not exotic: it is what several HTTP clients and
 * validation libraries attach when they wrap a response body in an Error.
 */
describe('describeFailure always returns something React can render (EB-2)', () => {
  function errorWithMessage(message: unknown): Error {
    const error = new Error('placeholder');
    Object.defineProperty(error, 'message', { value: message });
    return error;
  }

  it('refuses an Error whose message is an object', () => {
    const described = describeFailure(errorWithMessage({ code: 'E_SHAPE' }));
    expect(typeof described).toBe('string');
    expect(described).toBe(UNDESCRIBED_FAILURE);
  });

  it('refuses an Error whose message is a number or null', () => {
    // Same shape of lie as `[object Object]`: `String(0)` is "0", which reads
    // on screen as a message the server sent rather than as a missing one.
    expect(describeFailure(errorWithMessage(0))).toBe(UNDESCRIBED_FAILURE);
    expect(describeFailure(errorWithMessage(null))).toBe(UNDESCRIBED_FAILURE);
  });

  it('still paints the contained panel instead of taking the tree down', () => {
    renderBoundary(errorWithMessage({ code: 'E_SHAPE' }));
    expect(screen.getByTestId('error-boundary')).toBeDefined();
    expect(screen.getByTestId('error-boundary-message').textContent).toBe(UNDESCRIBED_FAILURE);
  });
});

/**
 * 2026-09-07 (EB-3).
 *
 * WRONG BELIEF: "Try again is worth another click."
 *
 * `retry` clears the failure and re-renders the identical children; when the
 * children fail the identical way the boundary redraws the identical panel.
 * Nothing distinguishes the first failure from the fifth - same heading, same
 * message, same button, and for a screen-reader user the same `role="alert"`
 * with text it has already announced, so the second announcement is
 * indistinguishable from an echo. The closing paragraph already warns that a
 * retry MAY fail the same way; what the panel never says is that it just DID.
 * The reader is left clicking a button that has already been answered.
 */
describe('the crash panel says when the retry has already been answered (EB-3)', () => {
  it('says nothing about repeats on the first failure', () => {
    renderBoundary(new Error('perDay is not iterable'));
    expect(screen.queryByTestId('error-boundary-repeat')).toBeNull();
  });

  it('reports the repeat, and the count, after Try again fails the same way', () => {
    renderBoundary(new Error('perDay is not iterable'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const repeat = screen.getByTestId('error-boundary-repeat');
    expect(repeat.textContent ?? '').toContain('2 times');
    // The detail is added to the panel that is already the alert, so it is
    // announced with the rest rather than needing a second live region.
    expect(screen.getByTestId('error-boundary').contains(repeat)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('error-boundary-repeat').textContent ?? '').toContain('3 times');
  });

  it('names the subject in the repeat notice, so a reader knows WHICH view keeps dying', () => {
    // Two boundaries can be on screen at once (a view inside the shell, the
    // shell inside the root boundary). A bare "it failed again" leaves the
    // reader guessing which of them is talking.
    renderBoundary(new Error('perDay is not iterable'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('error-boundary-repeat').textContent ?? '').toContain(
      'The cost view',
    );
  });
});
