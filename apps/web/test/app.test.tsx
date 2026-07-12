/**
 * Smoke tests for the WP-U5 shell: token gate, health fetch with Bearer
 * header, SSE connection state, and 401 handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../src/App';

const TOKEN_KEY = 'agenthropic.token';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string): void {
    const event = new MessageEvent(type, { data: '{}' });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (type === 'message') this.onmessage?.(event);
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  MockEventSource.instances = [];
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

describe('token gate', () => {
  it('renders the token form when no token is stored', () => {
    render(<App />);
    const input = screen.getByLabelText('Dashboard token');
    expect(input).toBeDefined();
    expect(input.getAttribute('type')).toBe('password');
  });

  it('does not call fetch or open an EventSource without a token', () => {
    render(<App />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('keeps the token out of localStorage after submit', async () => {
    fetchMock.mockResolvedValue(
      healthResponse(200, { status: 'ok', version: '0.1.0', uptimeSeconds: 1 }),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText('Dashboard token'), {
      target: { value: 'secret-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('secret-token');
    expect(localStorage.length).toBe(0);
  });
});

describe('dashboard', () => {
  it('shows health after token submit and sends the Bearer header', async () => {
    fetchMock.mockResolvedValue(
      healthResponse(200, { status: 'ok', version: '0.1.0', uptimeSeconds: 1 }),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText('Dashboard token'), {
      target: { value: 'secret-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByText('ok');
    expect(screen.getByText('0.1.0')).toBeDefined();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-token' },
      }),
    );
  });

  it('opens an EventSource with the token and counts heartbeats', async () => {
    fetchMock.mockResolvedValue(
      healthResponse(200, { status: 'ok', version: '0.1.0', uptimeSeconds: 1 }),
    );
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    render(<App />);

    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe('/api/stream?token=secret-token');

    source.onopen?.();
    await screen.findByText('open');

    source.emit('heartbeat');
    source.emit('heartbeat');
    await waitFor(() => expect(screen.getByTestId('heartbeat-count').textContent).toBe('2'));
  });

  it('clears the token and returns to the form on 401', async () => {
    fetchMock.mockResolvedValue(healthResponse(401, { error: 'unauthorized' }));
    sessionStorage.setItem(TOKEN_KEY, 'bad-token');
    render(<App />);

    await screen.findByLabelText('Dashboard token');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('closes the EventSource on unmount', async () => {
    fetchMock.mockResolvedValue(
      healthResponse(200, { status: 'ok', version: '0.1.0', uptimeSeconds: 1 }),
    );
    sessionStorage.setItem(TOKEN_KEY, 'secret-token');
    const { unmount } = render(<App />);
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    unmount();
    expect(MockEventSource.instances.every((source) => source.closed)).toBe(true);
  });
});
