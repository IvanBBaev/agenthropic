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
import {
  costSummary,
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
function routeFetch(sessions = sessionList()): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/health')) return Promise.resolve(healthOk());
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
