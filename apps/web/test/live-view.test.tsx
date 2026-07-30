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
import { jsonResponse, sessionList, sessionSummary, statusCounts } from './fixtures';
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

  it('ignores a malformed agent-status-changed payload', async () => {
    const session = sessionSummary();
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([session])));
    renderView();
    await screen.findByRole('list', { name: 'sessions' });

    act(() => {
      MockEventSource.latest().emit('agent-status-changed', { type: 'agent-status-changed' });
      MockEventSource.latest().emit('agent-status-changed', 'not json at all {');
    });

    expect(sessionsCalls()).toHaveLength(1);
    expect(screen.getByLabelText(`status counts for ${session.id}`).textContent).toContain(
      '1 working',
    );
  });

  it('renders a null project slug and a missing timestamp honestly', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, sessionList([sessionSummary({ projectSlug: null, lastActivityAt: null })])),
    );
    renderView();
    await screen.findByText('no project');
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
