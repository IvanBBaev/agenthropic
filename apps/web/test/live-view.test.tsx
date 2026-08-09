/**
 * LiveView (WP-U6): initial snapshot from GET /api/sessions, SSE patching of
 * status buckets, honest refetch on anything the snapshot cannot absorb, and
 * the always-visible five-bucket rendering (including `unknown` and zeros).
 * fetch and EventSource are mocked - no real server, no real ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LiveView, SESSION_LIMIT } from '../src/views/LiveView';
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
    expect(sessionsCalls()).toHaveLength(1);
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
});
