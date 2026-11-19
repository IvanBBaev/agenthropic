/**
 * UX-12: the session list's search box, status filter and "Load older".
 * fetch is mocked; each response is built from the requested URL so the
 * assertions pin what the view ASKED for as well as what it drew.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  filterText,
  sessionListLimit,
  SessionsView,
  SESSION_LIST_LIMIT,
  SESSION_LIST_MAX,
} from '../src/views/SessionsView';
import { createSseClient, type SseClient } from '../src/sse';
import { jsonResponse, sessionList, sessionSummary } from './fixtures';
import { MockEventSource } from './mock-event-source';

const fetchMock = vi.fn();
let sse: SseClient;

beforeEach(() => {
  MockEventSource.reset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', MockEventSource);
  sse = createSseClient('secret-token');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

function renderView() {
  return render(<SessionsView token="secret-token" sse={sse} onAuthRejected={vi.fn()} />);
}

/** `count` distinct summaries, newest first. */
function summaries(count: number) {
  return Array.from({ length: count }, (_, index) =>
    sessionSummary({ id: `session-${String(index).padStart(4, '0')}` }),
  );
}

/** Serve `limit` rows of a corpus of `total`, whatever the URL asked for. */
function serveCorpus(total: number): void {
  fetchMock.mockImplementation((url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    const limit = Number(params.get('limit'));
    const rows = summaries(Math.min(limit, total));
    return Promise.resolve(jsonResponse(200, sessionList(rows, { total, limit })));
  });
}

/*
 * The paging tests hold 50-200 rows. A `*ByRole` query computes the accessible
 * name of every button in the document on each call, which costs seconds per
 * call in jsdom at that size, and `waitFor` repeats the call until it matches.
 * On a loaded machine that pushed these tests past the 30 s timeout. So the
 * row-heavy queries below use selectors and text, which cost milliseconds.
 * The role and the accessible name of the row controls are pinned once, in
 * 'gives every row one pressable button'.
 */

/** One selectable button per listed session (UX-11: the row is the only control). */
function sessionRows(): HTMLElement[] {
  return Array.from(
    screen
      .getByRole('list', { name: 'session list' })
      .querySelectorAll<HTMLElement>(':scope > li.session-item > button'),
  );
}

/** A button found by its exact visible text, or null. */
function queryButton(text: string): HTMLElement | null {
  return screen.queryByText(text, { selector: 'button' });
}

function getButton(text: string): HTMLElement {
  return screen.getByText(text, { selector: 'button' });
}

function listUrls(): string[] {
  return (fetchMock.mock.calls as Array<[string]>).map(([url]) => url);
}

describe('session list filter and paging (UX-12)', () => {
  it('grows one read up to the server cap, never past it', () => {
    expect(sessionListLimit(1)).toBe(SESSION_LIST_LIMIT);
    expect(sessionListLimit(2)).toBe(2 * SESSION_LIST_LIMIT);
    expect(sessionListLimit(99)).toBe(SESSION_LIST_MAX);
  });

  it('names the applied filter in the reader’s terms', () => {
    expect(filterText({ search: 'abc', status: '' })).toBe('matching “abc”');
    expect(filterText({ search: '', status: 'error' })).toBe('with status error');
    expect(filterText({ search: 'abc', status: 'error' })).toBe('matching “abc” with status error');
  });

  it('sends the trimmed search and the status, says the count is of matches, and clears', async () => {
    fetchMock.mockImplementation((url: string) => {
      const filtered = url.includes('q=');
      const rows = filtered ? [sessionSummary({ status: 'error' })] : [sessionSummary()];
      return Promise.resolve(
        jsonResponse(200, sessionList(rows, { total: filtered ? 3 : 1, limit: 1 })),
      );
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: /search sessions/ }), {
      target: { value: '  proj  ' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: /filter sessions by status/ }), {
      target: { value: 'error' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));

    await waitFor(() => expect(listUrls()).toHaveLength(2));
    expect(listUrls()[1]).toBe(
      `/api/sessions?limit=${String(SESSION_LIST_LIMIT)}&status=error&q=proj`,
    );
    const truncation = await screen.findByTestId('list-truncation');
    expect(truncation.textContent).toContain(
      'Showing 1 of 3 sessions matching “proj” with status error',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(listUrls()).toHaveLength(3));
    expect(listUrls()[2]).toBe(`/api/sessions?limit=${String(SESSION_LIST_LIMIT)}`);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull());
    expect(
      (screen.getByRole('searchbox', { name: /search sessions/ }) as HTMLInputElement).value,
    ).toBe('');
  });

  it('says an empty filtered read matched nothing, not that nothing is ingested', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse(200, url.includes('q=') ? sessionList([]) : sessionList([sessionSummary()])),
      ),
    );
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.change(screen.getByRole('searchbox', { name: /search sessions/ }), {
      target: { value: 'zzz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));

    const noMatch = await screen.findByTestId('list-no-match');
    expect(noMatch.textContent).toBe('No sessions matching “zzz” as of this read.');
    expect(screen.queryByText(/No sessions ingested yet/)).toBeNull();
    // The form survives the empty read, still holding the applied search.
    expect(
      (screen.getByRole('searchbox', { name: /search sessions/ }) as HTMLInputElement).value,
    ).toBe('zzz');
    expect(screen.getByRole('button', { name: 'Clear filter' })).toBeDefined();
  });

  it('keeps the plain empty state for an unfiltered empty corpus', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([])));
    renderView();
    expect(await screen.findByText(/No sessions ingested yet/)).toBeDefined();
    expect(screen.queryByRole('form', { name: 'filter sessions' })).toBeNull();
  });

  it('gives every row one pressable button', async () => {
    serveCorpus(3);
    renderView();
    const list = await screen.findByRole('list', { name: 'session list' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toEqual(sessionRows());
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.hasAttribute('aria-pressed'))).toBe(true);
  });

  it('loads older sessions as one longer read until the cap, then points at the filter', async () => {
    serveCorpus(500);
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    expect(sessionRows()).toHaveLength(SESSION_LIST_LIMIT);
    expect(screen.getByRole('button', { name: 'Load older sessions' })).toBe(
      getButton('Load older sessions'),
    );

    for (const expected of [100, 150, 200]) {
      fireEvent.click(getButton('Load older sessions'));
      await waitFor(() => expect(sessionRows()).toHaveLength(expected));
      expect(listUrls().at(-1)).toBe(`/api/sessions?limit=${String(expected)}`);
    }
    expect(queryButton('Load older sessions')).toBeNull();
    expect(screen.getByTestId('list-cap').textContent).toContain(
      `${String(SESSION_LIST_MAX)} rows is the most one read serves`,
    );
  });

  it('offers no "Load older" when the read already holds every session', async () => {
    serveCorpus(3);
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    expect(queryButton('Load older sessions')).toBeNull();
    expect(screen.queryByTestId('list-cap')).toBeNull();
  });

  it('starts a new filter from the first page', async () => {
    serveCorpus(500);
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(getButton('Load older sessions'));
    await waitFor(() => expect(listUrls().at(-1)).toBe('/api/sessions?limit=100'));

    fireEvent.change(screen.getByRole('combobox', { name: /filter sessions by status/ }), {
      target: { value: 'waiting' },
    });
    fireEvent.click(getButton('Filter'));
    await waitFor(() =>
      expect(listUrls().at(-1)).toBe(
        `/api/sessions?limit=${String(SESSION_LIST_LIMIT)}&status=waiting`,
      ),
    );
  });
});
