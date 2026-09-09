/**
 * Shell integration tests (WP-U5, updated for WP-U6..U9): token gate +
 * pre-store validation, 401 handling, hash routing across the four real
 * views, the connection chip, the lock action, and the live status board
 * reached through the shell. Per-view behaviour lives in the dedicated
 * *-view.test.tsx suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../src/App';
import { ABSENT_STATUS_META, ABSENT_STATUS_REASON, NO_FIGURE_META } from '../src/views/status';
import {
  costSummary,
  deferred,
  globalDag,
  jsonResponse,
  sessionList,
  sessionSummary,
  sessionTree,
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

/**
 * Route fetches by URL: the shell probes /api/health while the mounted real
 * views fetch their own endpoints - feeding the health body to every fetch
 * would crash them. Empty datasets keep every view on its honest empty state.
 */
function routeFetch(sessions = sessionList(), health: Response = healthOk()): void {
  fetchMock.mockImplementation((url: string) => {
    // AMENDED 2026-09-03 (AU-2 follow-up): the health answer is a parameter
    // now. The three unreachable verdicts are three different chips, and the
    // only way to reach two of them is a health response that is NOT ok -
    // while the mounted views still need their own well-formed bodies, or the
    // test would be measuring a view crash instead of the header.
    if (url.startsWith('/api/health')) return Promise.resolve(health);
    if (url.includes('/tree')) return Promise.resolve(jsonResponse(200, sessionTree()));
    if (url.startsWith('/api/sessions')) return Promise.resolve(jsonResponse(200, sessions));
    if (url.startsWith('/api/dag/global')) return Promise.resolve(jsonResponse(200, globalDag()));
    if (url.startsWith('/api/cost/summary'))
      return Promise.resolve(jsonResponse(200, costSummary()));
    return Promise.reject(new Error(`unrouted fetch in test: ${url}`));
  });
}

function submitToken(value: string): void {
  fireEvent.change(screen.getByLabelText('Dashboard token'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

function setHash(hash: string): void {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event('hashchange'));
  });
}

describe('token gate', () => {
  it('renders the token entry screen when no token is stored', () => {
    render(<App />);
    const input = screen.getByLabelText('Dashboard token');
    expect(input.getAttribute('type')).toBe('password');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('stays on the entry screen with an inline error on 401 and stores nothing', async () => {
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'Unauthorized.' }));
    render(<App />);
    submitToken('bad-token');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Invalid token');
    expect(screen.getByLabelText('Dashboard token')).toBeDefined();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('shows a server-unreachable error when the health probe fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<App />);
    submitToken('secret-token');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Server unreachable');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('validates via /api/health with a Bearer header, then enters the shell', async () => {
    routeFetch();
    render(<App />);
    submitToken('secret-token');

    await screen.findByRole('navigation', { name: 'views' });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', {
      headers: { Authorization: 'Bearer secret-token' },
      signal: null,
    });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('secret-token');
    expect(localStorage.length).toBe(0);
  });

  it('ignores a blank submit', () => {
    render(<App />);
    submitToken('   ');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('shell with a stored token', () => {
  beforeEach(() => {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
  });

  it('opens the SSE stream with the token only in the EventSource URL', async () => {
    routeFetch();
    render(<App />);

    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    expect(MockEventSource.latest().url).toBe('/api/stream?token=secret-token');
    await screen.findByText('schema v3');
  });

  it('bounces back to the entry screen with a notice when the server answers 401', async () => {
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'Unauthorized.' }));
    render(<App />);

    await screen.findByLabelText('Dashboard token');
    expect(screen.getByRole('status').textContent).toContain('rejected the stored token');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(MockEventSource.instances.every((source) => source.closed)).toBe(true);
  });

  it('shows server unreachable on the chip when the health probe fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId('connection-chip').textContent).toBe('server unreachable'),
    );
  });

  /*
   * AU-2 follow-up. `api.ts` returns three distinct reasons and this header
   * printed one word for all of them. Each of these two would previously have
   * read `server unreachable`, and each of those sentences was false in a way
   * that sends the reader somewhere useless.
   */
  it('does not call a running server unreachable when it answers with an error', async () => {
    routeFetch(sessionList(), healthResponse(503, { error: 'starting' }));
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId('connection-chip').textContent).toBe('server error'),
    );
    // The status is the evidence that something answered, so it has to survive
    // into the visible text rather than being summarised away.
    const detail = screen.getByTestId('connection-detail').textContent ?? '';
    expect(detail).toContain('HTTP 503');
    expect(detail).toContain('the server answered, so it is running');
    // And the token verdict is not silently implied either way.
    expect(detail).toContain('neither accepted nor rejected');
  });

  it('does not call an accepted token a lost connection when the body is unreadable', async () => {
    // 200 with no schemaVersion. Every route on this server is auth-gated, so
    // this 200 is proof the token was ACCEPTED - the app used to answer that
    // by telling the user the server could not be reached.
    routeFetch(sessionList(), healthResponse(200, { status: 'ok' }));
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId('connection-chip').textContent).toBe('unreadable response'),
    );
    const detail = screen.getByTestId('connection-detail').textContent ?? '';
    expect(detail).toContain('this token was accepted');
    expect(detail).toContain('not the connection');
    // The schema version is genuinely unknown, so it must not be on screen.
    expect(screen.queryByText(/schema v/)).toBeNull();
  });

  it('tracks the SSE state on the connection chip', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');
    const source = MockEventSource.latest();

    act(() => source.open());
    expect(screen.getByTestId('connection-chip').textContent).toBe('● live');

    act(() => source.fail());
    expect(screen.getByTestId('connection-chip').textContent).toBe('○ reconnecting');

    act(() => source.fail({ fatal: true }));
    expect(screen.getByTestId('connection-chip').textContent).toBe('stream closed');
  });

  // SH-2. EventSource fires the same retryable error for a connection that
  // dropped and for a first attempt that never landed. `sse.ts` reports both as
  // `reconnecting` on purpose - LiveView needs the second one to count as an
  // interruption - but the chip is the sentence a person reads, and `re-`
  // asserts a connection that existed and was lost. Here none ever did: the
  // health probe answered, so the server is up, and this is the only signal on
  // the page that the stream cannot get in.
  it('does not claim a reconnect on a stream that has never been open', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');

    act(() => MockEventSource.latest().fail());

    const chip = screen.getByTestId('connection-chip').textContent ?? '';
    expect(chip).not.toContain('reconnecting');
    expect(chip).toBe('○ connecting…');
    expect(screen.getByTestId('connection-detail').textContent).toContain('has not connected yet');
  });

  it('keeps the chip glyph out of the accessible name and announces state changes', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');
    const source = MockEventSource.latest();

    // The whole chip lives inside one polite live region: a reader who has
    // navigated away from the header still gets told when the numbers stopped
    // being live, which is the only reason this element exists.
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.contains(screen.getByTestId('connection-chip'))).toBe(true);

    act(() => source.open());
    // `●` is paint. Announcing it reads a character to someone who cannot see
    // it and learns nothing; the word beside it carries the whole meaning.
    const glyph = screen.getByTestId('connection-chip').querySelector('[aria-hidden="true"]');
    expect(glyph?.textContent).toBe('●');
  });

  it('says in visible text why a closed stream will not come back', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');
    const source = MockEventSource.latest();

    act(() => source.open());
    // Nothing to explain while it works. A disclosure that is permanently on
    // screen stops being read, so the healthy states carry no detail at all.
    expect(screen.queryByTestId('connection-detail')).toBeNull();

    act(() => source.fail());
    // `reconnecting` is EventSource retrying by itself. There is no user
    // action to recommend, so recommending one would be noise.
    expect(screen.queryByTestId('connection-detail')).toBeNull();

    act(() => source.fail({ fatal: true }));
    // `closed` is the one state the browser will not leave on its own. Before
    // this the difference lived in a `title` attribute - unreachable by
    // keyboard, unreachable by touch, and not reliably read by assistive tech -
    // so the reader was left with a red chip and no way to learn that the
    // figures had frozen permanently.
    const detail = screen.getByTestId('connection-detail');
    expect(detail.textContent).toContain('will not reconnect on its own');
    expect(detail.textContent).toContain('reload');
    // Outside the chip, so the chip's own label stays the state and nothing else.
    expect(screen.getByTestId('connection-chip').contains(detail)).toBe(false);
  });

  it('puts the health failure beside the chip instead of inside a tooltip', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId('connection-chip').textContent).toBe('server unreachable'),
    );
    expect(screen.getByTestId('connection-detail').textContent).toContain('Failed to fetch');
    expect(screen.getByTestId('connection-chip').getAttribute('title')).toBeNull();
  });

  /**
   * F-2. The chip had two independent honesty defects that pointed in opposite
   * directions: it over-claimed when it was green (its only input is the
   * socket, yet it is painted above three views that never read the socket),
   * and it could be permanently wrong when it was red (the probe behind
   * `server unreachable` ran once, at mount, and was never re-run).
   */
  describe('what the connection chip actually measures (F-2)', () => {
    /** Health answers however the test says; every view still loads normally. */
    function routeFetchWithHealth(health: () => Promise<Response>): void {
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith('/api/health')) return health();
        if (url.includes('/tree')) return Promise.resolve(jsonResponse(200, sessionTree()));
        if (url.startsWith('/api/sessions'))
          return Promise.resolve(jsonResponse(200, sessionList()));
        if (url.startsWith('/api/dag/global'))
          return Promise.resolve(jsonResponse(200, globalDag()));
        if (url.startsWith('/api/cost/summary'))
          return Promise.resolve(jsonResponse(200, costSummary()));
        return Promise.reject(new Error(`unrouted fetch in test: ${url}`));
      });
    }

    it('names its subject, so a green chip cannot be read as a claim about the figures', async () => {
      routeFetch();
      render(<App />);
      await screen.findByText('schema v3');
      act(() => MockEventSource.latest().open());

      const scope = screen.getByTestId('connection-scope');
      // The subject is on screen in the healthy state too. Naming it only
      // while the chip is red would scope the claim in exactly the states
      // where the claim was never the problem.
      expect(scope.textContent).toBe('event stream');
      // Beside the chip, not inside it: the chip's own text stays the state
      // and nothing else, which is what every existing assertion here reads.
      expect(screen.getByTestId('connection-chip').contains(scope)).toBe(false);
      expect(screen.getByRole('status').contains(scope)).toBe(true);
      expect(screen.getByTestId('connection-chip').textContent).toBe('● live');
    });

    it('lets an open stream outrank a probe that failed once and was never re-run', async () => {
      routeFetchWithHealth(() => Promise.reject(new TypeError('Failed to fetch')));
      render(<App />);

      await waitFor(() =>
        expect(screen.getByTestId('connection-chip').textContent).toBe('server unreachable'),
      );

      // The socket is the newer evidence: the server answered, took the token
      // and is holding a connection open. The chip must stop calling that
      // server unreachable.
      act(() => MockEventSource.latest().open());
      expect(screen.getByTestId('connection-chip').textContent).toBe('● live');

      // The stale verdict is not discarded, because it is still the reason the
      // schema version is missing from the header.
      const detail = screen.getByTestId('connection-detail');
      expect(detail.textContent).toContain('the stream is open, so the server is reachable');
      expect(detail.textContent).toContain('Failed to fetch');
      expect(detail.textContent).toContain('schema version is unknown');
      expect(screen.queryByText(/^schema v/)).toBeNull();
    });

    it('offers a keyboard-reachable re-check rather than pinning the header for the tab', async () => {
      let healthy = false;
      routeFetchWithHealth(() =>
        healthy ? Promise.resolve(healthOk()) : Promise.reject(new TypeError('Failed to fetch')),
      );
      render(<App />);

      await waitFor(() =>
        expect(screen.getByTestId('connection-chip').textContent).toBe('server unreachable'),
      );
      // A real button, not a hover affordance: before this there was no way at
      // all to ask the question a second time, which is what made a single
      // transient failure permanent.
      const recheck = screen.getByRole('button', { name: 'Re-check server' });
      expect(recheck.getAttribute('type')).toBe('button');

      healthy = true;
      fireEvent.click(recheck);
      // The superseded verdict is cleared while its replacement is in flight -
      // showing an answer to a question already asked again is the same defect
      // one scale smaller.
      expect(screen.getByTestId('connection-chip').textContent).toBe('checking…');

      await screen.findByText('schema v3');
      expect(screen.getByTestId('connection-chip').textContent).toBe('connecting…');
      // Gone once there is nothing to re-check: a control that is always there
      // is a control the reader stops seeing.
      expect(screen.queryByTestId('recheck-health')).toBeNull();
    });

    it('keeps offering the re-check when the second probe fails too', async () => {
      routeFetchWithHealth(() => Promise.reject(new TypeError('Failed to fetch')));
      render(<App />);

      await waitFor(() => expect(screen.getByTestId('recheck-health')).toBeDefined());
      fireEvent.click(screen.getByTestId('recheck-health'));

      await waitFor(() =>
        expect(screen.getByTestId('connection-chip').textContent).toBe('server unreachable'),
      );
      expect(screen.getByTestId('recheck-health')).toBeDefined();
    });
  });

  it('shows how many frames arrived unreadable, and nothing until one does', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');
    const source = MockEventSource.latest();
    act(() => source.open());

    // Silence is the healthy state. A permanent "0 unread" badge is one more
    // always-on marker to stop noticing, and this one's whole value is that
    // its appearance IS the message.
    expect(screen.queryByTestId('dropped-frames')).toBeNull();

    // A truncated `ingest-failed` is the worst case in the whole app: a
    // quarantined session never reaches the read API, so that frame was the
    // only place its failure was ever going to be visible.
    act(() => source.emit('ingest-failed', 'truncated {"sessionId":'));
    expect(screen.getByTestId('dropped-frames').textContent).toBe('1 unread frame');
    expect(screen.getByTestId('dropped-frames-detail').textContent).toContain('not on this screen');

    act(() => source.emit('agent-status-changed', 'also truncated {'));
    expect(screen.getByTestId('dropped-frames').textContent).toBe('2 unread frames');

    // It rides inside the connection live region, so the count arriving is
    // announced rather than appearing silently in a header nobody re-reads.
    expect(screen.getByRole('status').contains(screen.getByTestId('dropped-frames'))).toBe(true);
  });

  it('does not count a frame it could read', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');
    const source = MockEventSource.latest();
    act(() => source.open());

    act(() => source.emit('agent-status-changed', { sessionId: 's-1' }));

    expect(screen.queryByTestId('dropped-frames')).toBeNull();
  });

  it('counts the frames the server numbered and this page never received', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');
    const source = MockEventSource.latest();
    act(() => source.open());

    // The first id is a baseline, not a gap: nothing before it was promised.
    act(() => source.emit('agent-status-changed', { sessionId: 's-1' }, { id: '1' }));
    expect(screen.queryByTestId('missed-frames')).toBeNull();

    // Frame 2 was published and never arrived. The sequence is the only
    // evidence of it that will ever exist - the server keeps no replay buffer.
    act(() => source.emit('agent-status-changed', { sessionId: 's-1' }, { id: '3' }));
    expect(screen.getByTestId('missed-frames').textContent).toBe('1 missed frame');

    act(() => source.emit('agent-status-changed', { sessionId: 's-1' }, { id: '6' }));
    expect(screen.getByTestId('missed-frames').textContent).toBe('3 missed frames');

    // The detail has to say what a reload will NOT fix, because for the worst
    // frame in this app - an ingest failure - a refetch cannot bring it back:
    // a quarantined session is not served by the read API at all.
    expect(screen.getByTestId('missed-frames-detail').textContent).toContain(
      'cannot be recovered by any refetch',
    );
    expect(screen.getByRole('status').contains(screen.getByTestId('missed-frames'))).toBe(true);
  });

  it('keeps a frame that never arrived apart from one that arrived unreadable', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');
    const source = MockEventSource.latest();
    act(() => source.open());

    // A frame this build could not parse is a DROP, not a gap: it arrived.
    act(() => source.emit('ingest-failed', 'truncated {"sessionId":', { id: '1' }));
    expect(screen.getByTestId('dropped-frames').textContent).toBe('1 unread frame');
    expect(screen.queryByTestId('missed-frames')).toBeNull();

    // And a gap is not a drop: nothing arrived to be unread.
    act(() => source.emit('agent-status-changed', { sessionId: 's-1' }, { id: '3' }));
    expect(screen.getByTestId('missed-frames').textContent).toBe('1 missed frame');
    expect(screen.getByTestId('dropped-frames').textContent).toBe('1 unread frame');
  });

  it('explains every gap glyph it paints in the legend', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');

    // The legend is built from the same constants the views render, so a glyph
    // cannot reach the screen without its own line here. `no figure` is the
    // third member of a vocabulary that used to have two entries and one
    // borrowing.
    const legend = screen.getByLabelText('uncertainty legend');
    expect(legend.textContent).toContain(`${NO_FIGURE_META.symbol} ${NO_FIGURE_META.label}`);
    expect(legend.textContent).toContain('observed');
    expect(legend.textContent).toContain('inferred');
    expect(legend.textContent).toContain('unpriced');
  });

  // SH-1. `?` carries two different facts since SV-3 - a status word this build
  // has never learned, and no status word in the payload at all - and the split
  // lives in the parenthetical, which is exactly where a legend that only lists
  // SYMBOLS stops looking. A reader who meets `? unrecognised (no status word
  // sent)` in a row has to work out for themselves that the legend's single
  // `unrecognised` covers a case about the server's payload rather than about
  // the agent.
  it('distinguishes the two things the unrecognised glyph can mean', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');

    const legend = screen.getByLabelText('uncertainty legend').textContent ?? '';
    expect(legend).toContain('the raw word');
    // Quoted from the constant the row itself renders, so the legend and the
    // row cannot come to disagree about the wording.
    expect(legend).toContain(ABSENT_STATUS_REASON);
    expect(ABSENT_STATUS_META.label).toContain(ABSENT_STATUS_REASON);
  });

  it('routes by hash across the four views and defaults unknown hashes to live', async () => {
    routeFetch();
    render(<App />);
    await screen.findByRole('heading', { name: 'Live status' });

    setHash('#/cost');
    expect(screen.getByRole('heading', { name: 'Cost and savings' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Cost' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Live' }).getAttribute('aria-current')).toBeNull();

    setHash('#/sessions');
    expect(screen.getByRole('heading', { name: 'Session subagent tree' })).toBeDefined();

    setHash('#/dag');
    expect(screen.getByRole('heading', { name: 'Global orchestration DAG' })).toBeDefined();

    setHash('#/bogus');
    expect(screen.getByRole('heading', { name: 'Live status' })).toBeDefined();
  });

  it('locks: clears the token, closes the stream and returns to the entry screen', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText('schema v3');

    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));

    expect(screen.getByLabelText('Dashboard token')).toBeDefined();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(MockEventSource.instances.every((source) => source.closed)).toBe(true);
  });

  it('ignores a health result that lands after unmount instead of dropping the token', async () => {
    const health = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/health')) return health.promise;
      if (url.startsWith('/api/sessions')) return Promise.resolve(jsonResponse(200, sessionList()));
      return Promise.reject(new Error(`unrouted fetch in test: ${url}`));
    });
    const { unmount } = render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId('connection-chip').textContent).toBe('checking…'),
    );
    unmount();

    await act(async () => {
      health.resolve(healthResponse(401, { error: 'Unauthorized.' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The probe belonged to a shell that no longer exists; a 401 answer to an
    // aborted request must not log the (possibly still valid) session out.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('secret-token');
  });

  it('closes the EventSource on unmount', async () => {
    routeFetch();
    const { unmount } = render(<App />);
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    unmount();
    expect(MockEventSource.instances.every((source) => source.closed)).toBe(true);
  });
});

describe('live status board through the shell', () => {
  beforeEach(() => {
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
  });

  it('renders the default view as the live board with all five status buckets', async () => {
    const session = sessionSummary();
    routeFetch(sessionList([session]));
    render(<App />);

    const buckets = await screen.findByLabelText(`status counts for ${session.id}`);
    for (const fragment of ['1 working', '0 waiting', '2 done', '0 error', '0 unknown']) {
      expect(buckets.textContent).toContain(fragment);
    }
  });

  it('refetches the board snapshot when session-ingested arrives on the stream', async () => {
    const session = sessionSummary();
    routeFetch(sessionList([session]));
    render(<App />);
    await screen.findByLabelText(`status counts for ${session.id}`);
    const callsBefore = fetchMock.mock.calls.filter((call) =>
      (call[0] as string).startsWith('/api/sessions'),
    ).length;

    act(() => {
      MockEventSource.latest().emit('session-ingested', {
        type: 'session-ingested',
        sessionId: session.id,
        occurredAt: '2026-07-29T10:10:00.000Z',
      });
    });

    await waitFor(() => {
      const callsAfter = fetchMock.mock.calls.filter((call) =>
        (call[0] as string).startsWith('/api/sessions'),
      ).length;
      expect(callsAfter).toBe(callsBefore + 1);
    });
  });

  it('renders the honest empty state before any session is persisted', async () => {
    routeFetch();
    render(<App />);
    await screen.findByText(/No sessions ingested yet/);
  });
});
