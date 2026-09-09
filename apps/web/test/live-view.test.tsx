/**
 * LiveView (WP-U6): initial snapshot from GET /api/sessions, SSE patching of
 * status buckets, honest refetch on anything the snapshot cannot absorb, and
 * the always-visible five-bucket rendering (including `unknown` and zeros).
 * fetch and EventSource are mocked - no real server, no real ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import {
  ingestedSessionId,
  LiveView,
  SESSION_LIMIT,
  toIngestFailureNotice,
} from '../src/views/LiveView';
// M-10: the cadence now belongs to the app-wide clock, not to this view.
import { CLOCK_INTERVAL_MS } from '../src/clock';
import { createSseClient, type SseClient } from '../src/sse';
import { deferred, jsonResponse, sessionList, sessionSummary, statusCounts } from './fixtures';
import { MockEventSource } from './mock-event-source';

const fetchMock = vi.fn();
let sse: SseClient;
const onAuthRejected = vi.fn();

beforeEach(() => {
  MockEventSource.reset();
  fetchMock.mockReset();
  onAuthRejected.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', MockEventSource);
  sse = createSseClient('secret-token');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderView() {
  return render(<LiveView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
}

function sessionsCalls(): readonly string[] {
  return fetchMock.mock.calls
    .map((call) => call[0] as string)
    .filter((url) => url.startsWith('/api/sessions'));
}

describe('LiveView', () => {
  it('shows a loading state, then fetches the snapshot with the Bearer header and the limit', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();

    expect(screen.getByText('Loading sessions…')).toBeDefined();
    await screen.findByRole('list', { name: 'sessions' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/sessions?limit=${String(SESSION_LIMIT)}`);
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });
    expect(url.includes('secret-token')).toBe(false);
  });

  it('renders a card with all five status buckets - zero counts stay visible, dimmed', async () => {
    const session = sessionSummary({
      unpricedTokens: 3000,
      statusCounts: statusCounts({ working: 1, completed: 2 }),
    });
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([session])));
    const { container } = renderView();
    await screen.findByRole('list', { name: 'sessions' });

    const buckets = screen.getByLabelText(`status counts for ${session.id}`);
    expect(buckets.textContent).toContain('1 working');
    expect(buckets.textContent).toContain('0 waiting');
    expect(buckets.textContent).toContain('2 done');
    expect(buckets.textContent).toContain('0 error');
    expect(buckets.textContent).toContain('0 unknown');
    // Symbols pair with the words - color is never the only channel.
    expect(buckets.textContent).toContain('●');
    expect(buckets.textContent).toContain('▲');
    expect(container.querySelectorAll('.bucket-zero')).toHaveLength(3);

    expect(screen.getByText('aaaaaaaa…')).toBeDefined();
    expect(screen.getByText('agenthropic')).toBeDefined();
    expect(screen.getByText('3 agents')).toBeDefined();
    expect(screen.getByText('1,200 tokens')).toBeDefined();
    expect(screen.getByText('$0.42')).toBeDefined();
    expect(screen.getByText('~ 3,000 unpriced')).toBeDefined();
    expect(screen.getByText('1 session, most recent first.')).toBeDefined();
  });

  it('says "Showing N of M" when the server holds more sessions than the page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()], { total: 120 })));
    renderView();
    await screen.findByText('Showing 1 of 120 sessions (most recent first).');
  });

  it('renders the honest empty state when no sessions are persisted', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList()));
    renderView();
    await screen.findByText(/No sessions ingested yet/);
  });

  it('shows the error with a Retry button that refetches', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'Internal server error.' }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();

    await screen.findByText(/Could not load sessions: Internal server error\./);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('list', { name: 'sessions' });
    expect(sessionsCalls()).toHaveLength(2);
  });

  it('calls onAuthRejected on 401 instead of rendering an error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized.' }));
    renderView();

    await waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Could not load sessions/)).toBeNull();
  });

  it('patches the status buckets in place on agent-status-changed without a refetch', async () => {
    const session = sessionSummary();
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([session])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('agent-status-changed', {
        type: 'agent-status-changed',
        sessionId: session.id,
        agentId: 'agent-main',
        status: 'completed',
        previousStatus: 'working',
        occurredAt: '2026-07-29T10:10:00.000Z',
      });
    });

    const buckets = screen.getByLabelText(`status counts for ${session.id}`);
    expect(buckets.textContent).toContain('0 working');
    expect(buckets.textContent).toContain('3 done');
    expect(sessionsCalls()).toHaveLength(1);
  });

  it('absorbs a redelivered status frame instead of moving a second agent (LV-7)', async () => {
    const session = sessionSummary({ statusCounts: statusCounts({ working: 3 }) });
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([session])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    const frame = {
      type: 'agent-status-changed',
      sessionId: session.id,
      agentId: 'agent-main',
      status: 'completed',
      previousStatus: 'working',
      occurredAt: '2026-07-29T10:10:00.000Z',
    };
    act(() => {
      MockEventSource.latest().emit('agent-status-changed', frame);
      // The stream gives no uniqueness guarantee: the same frame, again.
      MockEventSource.latest().emit('agent-status-changed', frame);
    });

    // ONE agent finished. Reading `1 working / 2 done` here would tell the user
    // that two of the three agents are done when only one is.
    const buckets = screen.getByLabelText(`status counts for ${session.id}`);
    expect(buckets.textContent).toContain('2 working');
    expect(buckets.textContent).toContain('1 done');
    // And a repeat is not a disagreement: there is nothing to refetch, so a
    // redelivering stream must not turn into a refetch storm.
    expect(sessionsCalls()).toHaveLength(1);
  });

  it('refetches when a status event names a session the snapshot does not know', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('agent-status-changed', {
        type: 'agent-status-changed',
        sessionId: 'bbbbbbbb-0000-0000-0000-000000000000',
        agentId: 'agent-x',
        status: 'working',
        previousStatus: null,
        occurredAt: '2026-07-29T10:10:00.000Z',
      });
    });

    await waitFor(() => expect(sessionsCalls()).toHaveLength(2));
  });

  it('refetches on session-ingested', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('session-ingested', {
        type: 'session-ingested',
        sessionId: 'whatever',
        occurredAt: '2026-07-29T10:10:00.000Z',
      });
    });

    await waitFor(() => expect(sessionsCalls()).toHaveLength(2));
  });

  it('refetches on a malformed agent-status-changed payload instead of patching it', async () => {
    const session = sessionSummary();
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([session])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('agent-status-changed', { type: 'agent-status-changed' });
      // Not JSON at all: dropped by the SSE wrapper, so it never reaches the
      // board and cannot trigger anything.
      MockEventSource.latest().emit('agent-status-changed', 'not json at all {');
    });

    // The unreadable-but-parsed frame still means something changed, so the
    // board reloads persisted truth rather than showing a stale snapshot.
    await waitFor(() => expect(sessionsCalls()).toHaveLength(2));
    expect(screen.getByLabelText(`status counts for ${session.id}`).textContent).toContain(
      '1 working',
    );
  });

  it('counts the sessions on the board when the page holds them all', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        sessionList([
          sessionSummary(),
          sessionSummary({ id: 'bbbbbbbb-5555-6666-7777-888888888888', projectSlug: 'kiko' }),
        ]),
      ),
    );
    renderView();

    await screen.findByText('2 sessions, most recent first.');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('writes a one-agent card in the singular', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, sessionList([sessionSummary({ agentCount: 1 })])),
    );
    renderView();

    await screen.findByText('1 agent');
    expect(screen.getByText('1 session, most recent first.')).toBeDefined();
  });

  it('ignores a status event that arrives before the first snapshot exists', async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation(() => pending.promise);
    const session = sessionSummary();
    renderView();
    expect(screen.getByText('Loading sessions…')).toBeDefined();

    act(() => {
      MockEventSource.latest().emit('agent-status-changed', {
        type: 'agent-status-changed',
        sessionId: session.id,
        agentId: 'agent-main',
        status: 'completed',
        previousStatus: 'working',
        occurredAt: '2026-07-29T10:10:00.000Z',
      });
    });

    // There is no snapshot to patch yet, and no reason to refetch one that is
    // already in flight.
    expect(screen.getByText('Loading sessions…')).toBeDefined();
    expect(sessionsCalls()).toHaveLength(1);

    await act(async () => {
      pending.resolve(jsonResponse(200, sessionList([session])));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The snapshot arrives as the server told it - the dropped event was not
    // replayed on top of it.
    expect(screen.getByLabelText(`status counts for ${session.id}`).textContent).toContain(
      '1 working',
    );
    // AMENDED 2026-09-09 (LV-9). This used to end here, at one call, on the
    // reasoning that there was nothing to patch and no point aborting a fetch
    // already in flight. Both halves still hold - the frame is still dropped, the
    // in-flight fetch still runs to completion - but the response it produced was
    // read at a moment the board cannot place relative to the dropped transition,
    // and was then rendered as current anyway. So the snapshot is re-read once,
    // and exactly once: the board is `ready` from here on, so no later frame takes
    // the dropping path.
    expect(sessionsCalls()).toHaveLength(2);
  });

  it('does not refetch for a status event that arrives while the board is in the error state', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal server error.' }));
    renderView();
    await screen.findByText(/Could not load sessions: Internal server error\./);
    expect(sessionsCalls()).toHaveLength(1);

    act(() => {
      MockEventSource.latest().emit('agent-status-changed', {
        type: 'agent-status-changed',
        sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
        agentId: 'agent-main',
        status: 'completed',
        previousStatus: 'working',
        occurredAt: '2026-07-29T10:10:00.000Z',
      });
    });

    // LV-9 buys nothing here and is deliberately not spent. There is no fetch in
    // flight whose read could predate this transition: the next fetch, whenever
    // it is issued, is issued after this frame and so already contains it. The
    // error stands as the last thing the board actually knows.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionsCalls()).toHaveLength(1);
    expect(screen.getByText(/Could not load sessions: Internal server error\./)).toBeDefined();
  });

  it('drops a snapshot that lands after a newer refetch already replaced it', async () => {
    const stale = sessionSummary({ projectSlug: 'stale-project' });
    const fresh = sessionSummary({
      id: 'cccccccc-9999-9999-9999-999999999999',
      projectSlug: 'fresh-project',
    });
    const first = deferred<Response>();
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve(jsonResponse(200, sessionList([fresh])));
    });
    renderView();
    expect(screen.getByText('Loading sessions…')).toBeDefined();

    // An ingest lands while the very first snapshot is still in flight.
    act(() => {
      MockEventSource.latest().emit('session-ingested', {
        type: 'session-ingested',
        sessionId: fresh.id,
        occurredAt: '2026-07-29T10:10:00.000Z',
      });
    });
    await screen.findByText('fresh-project');

    await act(async () => {
      first.resolve(jsonResponse(200, sessionList([stale])));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The superseded response never replaces the newer persisted truth.
    expect(screen.getByText('fresh-project')).toBeDefined();
    expect(screen.queryByText('stale-project')).toBeNull();
  });

  it('refetches persisted truth once when the stream recovers from an interruption', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    // The stream opening for the first time is not a recovery: no refetch.
    act(() => {
      MockEventSource.latest().open();
    });
    expect(sessionsCalls()).toHaveLength(1);

    // Every transition that fired while disconnected is gone (SSE replays
    // nothing), so the reopened stream must refetch the snapshot - exactly once.
    act(() => {
      MockEventSource.latest().fail();
      MockEventSource.latest().open();
    });
    await waitFor(() => expect(sessionsCalls()).toHaveLength(2));
  });

  it('a mount on an already-open stream triggers no recovery refetch', async () => {
    act(() => {
      MockEventSource.latest().open();
    });
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    // onStateChange runs immediately with the CURRENT state: an already-open
    // stream was never interrupted, so nothing refetches.
    expect(sessionsCalls()).toHaveLength(1);
  });

  it('a deliberately closed stream marks the hole but fires no refetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    // `closed` is terminal for EventSource: the board keeps its last snapshot
    // and the shell's connection chip carries the bad news.
    act(() => {
      sse.close();
    });
    expect(sessionsCalls()).toHaveLength(1);
  });

  it('renders a null project slug and a missing timestamp honestly', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, sessionList([sessionSummary({ projectSlug: null, lastActivityAt: null })])),
    );
    renderView();
    await screen.findByText('project unknown');
    expect(screen.getByText('no timestamp')).toBeDefined();
  });

  it('unsubscribes from the stream and aborts the fetch on unmount', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    const view = renderView();
    await screen.findByRole('list', { name: 'sessions' });
    view.unmount();

    act(() => {
      MockEventSource.latest().emit('session-ingested', { type: 'session-ingested' });
    });
    expect(sessionsCalls()).toHaveLength(1);
  });

  describe('ingest-failed banners', () => {
    const FAILED_SESSION = 'ffffffff-0000-0000-0000-000000000001';

    function emitIngestFailure(overrides: Record<string, unknown> = {}): void {
      act(() => {
        MockEventSource.latest().emit('ingest-failed', {
          type: 'ingest-failed',
          payload: {
            sessionId: FAILED_SESSION,
            reason: 'refusing to price at $0: unknown model id',
            attempt: 1,
            willRetry: true,
            occurredAt: '2026-07-29T10:10:00.000Z',
            ...overrides,
          },
        });
      });
    }

    it('renders a dismissible banner naming the session and reason, without a refetch', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      emitIngestFailure();

      const banner = screen.getByRole('alert');
      expect(banner.textContent).toContain('Ingest failed for session');
      expect(banner.textContent).toContain('ffffffff…');
      expect(banner.textContent).toContain('refusing to price at $0: unknown model id');
      expect(banner.textContent).toContain('attempt 1');
      expect(banner.textContent).toContain('will retry');
      // A failed session never reached the read API: nothing new to fetch.
      expect(sessionsCalls()).toHaveLength(1);

      fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('marks a quarantined session as such when the watcher gives up', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      emitIngestFailure({ attempt: 3, willRetry: false });

      const banner = screen.getByRole('alert');
      expect(banner.textContent).toContain('attempt 3');
      expect(banner.textContent).toContain('quarantined until its transcript changes');
    });

    it('replaces the banner on a repeat failure instead of stacking one per attempt', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      emitIngestFailure({ attempt: 1 });
      emitIngestFailure({ attempt: 2 });

      const banners = screen.getAllByRole('alert');
      expect(banners).toHaveLength(1);
      expect(banners[0]?.textContent).toContain('attempt 2');
    });

    it('keeps one banner per failed session and dismisses them independently', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      emitIngestFailure();
      emitIngestFailure({ sessionId: 'eeeeeeee-0000-0000-0000-000000000002', reason: 'other' });
      const banners = screen.getAllByRole('alert');
      expect(banners).toHaveLength(2);

      fireEvent.click(within(banners[0] as HTMLElement).getByRole('button', { name: 'Dismiss' }));

      const remaining = screen.getAllByRole('alert');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.textContent).toContain('eeeeeeee…');
    });

    it("clears a session's banner when a later ingest for it succeeds", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      emitIngestFailure();
      emitIngestFailure({ sessionId: 'eeeeeeee-0000-0000-0000-000000000002' });
      expect(screen.getAllByRole('alert')).toHaveLength(2);

      act(() => {
        MockEventSource.latest().emit('session-ingested', {
          type: 'session-ingested',
          sessionId: FAILED_SESSION,
          occurredAt: '2026-07-29T10:11:00.000Z',
        });
      });

      // The resolved failure is gone, the unresolved one stays, and the
      // ingest still refetches the snapshot.
      const remaining = screen.getAllByRole('alert');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.textContent).toContain('eeeeeeee…');
      await waitFor(() => expect(sessionsCalls()).toHaveLength(2));
    });

    it('leaves banners alone when a session-ingested frame carries no readable id', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      emitIngestFailure();
      act(() => {
        MockEventSource.latest().emit('session-ingested', { type: 'session-ingested' });
      });

      expect(screen.getAllByRole('alert')).toHaveLength(1);
      await waitFor(() => expect(sessionsCalls()).toHaveLength(2));
    });

    it('counts unreadable ingest-failed frames instead of dropping them', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      act(() => {
        MockEventSource.latest().emit('ingest-failed', { type: 'ingest-failed' });
      });
      expect(screen.getByRole('alert').textContent).toContain(
        '1 ingest-failure frame arrived in a shape this build cannot read',
      );

      act(() => {
        MockEventSource.latest().emit('ingest-failed', {
          type: 'ingest-failed',
          payload: { sessionId: 42 },
        });
      });
      const banner = screen.getByRole('alert');
      expect(banner.textContent).toContain('2 ingest-failure frames arrived');

      fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows a failure banner that arrives while the snapshot is still loading', async () => {
      const pending = deferred<Response>();
      fetchMock.mockImplementation(() => pending.promise);
      renderView();
      expect(screen.getByText('Loading sessions…')).toBeDefined();

      emitIngestFailure();

      expect(screen.getByRole('alert').textContent).toContain('Ingest failed for session');
      expect(screen.getByText('Loading sessions…')).toBeDefined();

      await act(async () => {
        pending.resolve(jsonResponse(200, sessionList([sessionSummary()])));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The banner survives the snapshot's arrival - a quarantined session is
      // still absent from it.
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByRole('list', { name: 'sessions' })).toBeDefined();
    });
  });

  describe('recency clock', () => {
    it('keeps relative-time labels moving on a quiet stream without refetching', async () => {
      vi.useFakeTimers();
      const lastActivityAt = new Date(Date.now() - 60_000).toISOString();
      fetchMock.mockResolvedValue(
        jsonResponse(200, sessionList([sessionSummary({ lastActivityAt })])),
      );
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('just now')).toBeDefined();

      // Two ticks move the clock past the 90 s "just now" window; nothing
      // else happens - no SSE traffic, no refetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS * 2);
      });
      expect(screen.getByText('2m ago')).toBeDefined();
      expect(sessionsCalls()).toHaveLength(1);
    });

    // The board is the only subscriber here, so unmounting it drops the shared
    // clock's subscriber count to zero and the interval must go with it.
    it('stops the clock on unmount', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      const view = renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const before = vi.getTimerCount();
      expect(before).toBeGreaterThan(0);

      view.unmount();
      expect(vi.getTimerCount()).toBe(before - 1);
    });
  });

  describe('patched-card provenance (F-11)', () => {
    // AMENDED 2026-09-03 (LV-7): the agent is now a parameter. Every frame this
    // helper built was byte-identical, which is exactly what the board stopped
    // applying twice; the default keeps the single-frame callers as they were.
    function statusFrame(sessionId: string, agentId = 'agent-main') {
      return {
        type: 'agent-status-changed',
        sessionId,
        agentId,
        status: 'completed',
        previousStatus: 'working',
        occurredAt: '2026-07-29T10:10:00.000Z',
      };
    }

    it('says nothing on a card the stream has not rewritten', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      // An unpatched card is uniformly as old as the snapshot. A line on every
      // row would bury the rows where it is a warning.
      expect(screen.queryByTestId(`provenance-${sessionSummary().id}`)).toBeNull();
    });

    it('names which half of a patched card is live and how old the rest is', async () => {
      vi.useFakeTimers();
      const session = sessionSummary({ statusCounts: statusCounts({ working: 2 }) });
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([session])));
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Four ticks: two minutes since the figures on this card were read.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS * 4);
      });
      act(() => {
        MockEventSource.latest().emit('agent-status-changed', statusFrame(session.id));
      });

      // Read synchronously: the patch is a plain setState inside `act`, and
      // `findBy*` polls on a clock this test has already frozen.
      const line = screen.getByTestId(`provenance-${session.id}`);
      // The defect this answers: the patch drags `lastActivityAt` to now while
      // dollars, tokens, agent count and the session chip stay at fetch time -
      // so the card must age the stale half out loud, in the same words the
      // recency label uses.
      expect(line.textContent).toContain('2m ago');
      expect(line.textContent).toContain('1 status frame applied');
      expect(sessionsCalls()).toHaveLength(1);
    });

    it('counts the frames rather than merely flagging that some arrived', async () => {
      const session = sessionSummary({ statusCounts: statusCounts({ working: 3 }) });
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([session])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      act(() => {
        MockEventSource.latest().emit('agent-status-changed', statusFrame(session.id, 'agent-a'));
        MockEventSource.latest().emit('agent-status-changed', statusFrame(session.id, 'agent-b'));
      });

      // AMENDED 2026-09-03 (LV-7): two agents, not one agent twice. The count
      // still has to be a count rather than a flag - that is what this test is
      // for - but the identical repeat it used to send is now absorbed by the
      // board as the redelivery it looks like, so it would count once.
      const line = await screen.findByTestId(`provenance-${session.id}`);
      expect(line.textContent).toContain('2 status frames applied');
    });

    it('drops the line again once a refetch makes the whole card one age', async () => {
      const session = sessionSummary({ statusCounts: statusCounts({ working: 2 }) });
      fetchMock.mockResolvedValue(jsonResponse(200, sessionList([session])));
      renderView();
      await screen.findByRole('list', { name: 'sessions' });

      act(() => {
        MockEventSource.latest().emit('agent-status-changed', statusFrame(session.id));
      });
      await screen.findByTestId(`provenance-${session.id}`);

      // A fresh snapshot re-reads every figure, so there is no longer a stale
      // half to disclose - the caveat must not outlive what it qualifies.
      act(() => {
        MockEventSource.latest().emit('session-ingested', {
          type: 'session-ingested',
          sessionId: session.id,
          occurredAt: '2026-07-29T10:11:00.000Z',
        });
      });
      await waitFor(() => {
        expect(screen.queryByTestId(`provenance-${session.id}`)).toBeNull();
      });
    });
  });
});

describe('toIngestFailureNotice', () => {
  const payload = {
    sessionId: 's',
    reason: 'r',
    attempt: 2,
    willRetry: false,
    occurredAt: '2026-07-29T10:10:00.000Z',
  };

  it('narrows a well-formed frame to the fields the board renders', () => {
    expect(toIngestFailureNotice({ type: 'ingest-failed', payload })).toEqual({
      sessionId: 's',
      reason: 'r',
      attempt: 2,
      willRetry: false,
    });
  });

  it.each([
    ['a non-object frame', 42],
    ['a null frame', null],
    ['a missing payload', { type: 'ingest-failed' }],
    ['a null payload', { type: 'ingest-failed', payload: null }],
    ['a non-object payload', { type: 'ingest-failed', payload: 'boom' }],
    ['a non-string sessionId', { payload: { ...payload, sessionId: 7 } }],
    ['a non-string reason', { payload: { ...payload, reason: null } }],
    ['a non-number attempt', { payload: { ...payload, attempt: '1' } }],
    ['a non-boolean willRetry', { payload: { ...payload, willRetry: 'yes' } }],
  ])('returns null for %s', (_label, frame) => {
    expect(toIngestFailureNotice(frame)).toBeNull();
  });
});

describe('ingestedSessionId', () => {
  it('returns the id when the frame carries a string sessionId', () => {
    expect(ingestedSessionId({ sessionId: 'abc' })).toBe('abc');
  });

  it.each([
    ['a non-object frame', 'plain string'],
    ['a null frame', null],
    ['a missing sessionId', {}],
    ['a non-string sessionId', { sessionId: 9 }],
  ])('returns null for %s', (_label, frame) => {
    expect(ingestedSessionId(frame)).toBeNull();
  });
});

/**
 * AMENDED 2026-09-03 (LV-2): the board used to have no way to say "frames are
 * missing from this feed".
 *
 * The stream numbers every frame and replays nothing, so a reconnect - or any
 * server-side drop - leaves a hole that the board renders as continuity. The
 * refetch-on-recovery effect repairs the SNAPSHOT, which is why sessions and
 * buckets come back, but it cannot repair `ingest-failed`: a quarantined
 * session never reaches the read API, so a failure announced inside the gap is
 * unrecoverable and the reader has to be told it existed.
 */
describe('LiveView stream-gap notice (LV-2)', () => {
  it('names how many frames the gap proves this board never received', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      // Two frames the board can ignore, four ids apart: whatever ids 2-4
      // carried, this tab never saw it.
      MockEventSource.latest().emit('message', { n: 1 }, { id: '1' });
      MockEventSource.latest().emit('message', { n: 5 }, { id: '5' });
    });

    const notice = await screen.findByTestId('stream-gap');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('3 frames');
    expect(notice.textContent).toContain('ids 2-4');
    // The refetch below cannot bring a quarantine notice back, and the banner
    // is the only place that can say so.
    expect(notice.textContent).toContain('ingest failure');
  });

  it('names a single missed frame by the one id it was', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('message', { n: 1 }, { id: '1' });
      MockEventSource.latest().emit('message', { n: 3 }, { id: '3' });
    });

    const notice = await screen.findByTestId('stream-gap');
    expect(notice.textContent).toContain('1 frame ');
    expect(notice.textContent).toContain('id 2');
  });

  it('accumulates several gaps and names the most recent range', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('message', {}, { id: '1' });
      MockEventSource.latest().emit('message', {}, { id: '3' });
      MockEventSource.latest().emit('message', {}, { id: '9' });
    });

    const notice = await screen.findByTestId('stream-gap');
    // 1 + 5 missed. The ranges are not merged: ids 4-8 include frames that DID
    // arrive, so naming one wide range would overstate the loss.
    expect(notice.textContent).toContain('6 frames');
    expect(notice.textContent).toContain('ids 4-8');
  });

  it('refetches persisted truth when the sequence proves frames went missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('message', {}, { id: '1' });
      MockEventSource.latest().emit('message', {}, { id: '4' });
    });

    // Status frames in the gap would have been patched into the buckets; the
    // snapshot is the only way back to truth for everything except the
    // failure notices.
    await waitFor(() => expect(sessionsCalls()).toHaveLength(2));
  });

  it('keeps the notice until it is dismissed', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('message', {}, { id: '1' });
      MockEventSource.latest().emit('message', {}, { id: '4' });
    });

    const notice = await screen.findByTestId('stream-gap');
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('stream-gap')).toBeNull();
  });

  it('says nothing while the frame sequence is intact', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('message', {}, { id: '1' });
      MockEventSource.latest().emit('message', {}, { id: '2' });
      MockEventSource.latest().emit('message', {});
    });

    expect(screen.queryByTestId('stream-gap')).toBeNull();
    expect(sessionsCalls()).toHaveLength(1);
  });
});
