/**
 * D11(a) (2026-09-30): the "changed since" list on the Sessions view, the
 * dashboard's reader of `GET /api/changes` (Q5). Each case is written so it
 * fails if the behaviour it names is removed: the request never made, or made
 * on mount; `total` ignored so a page reads as the whole window; an error
 * swallowed into an empty list; a residue or blind-spot count dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  ABSENT_CHANGE_REASON,
  CHANGES_LIMIT,
  ChangesPanel,
  changeKindText,
  previousUtcDay,
} from '../src/views/ChangesPanel';
import { SessionsView } from '../src/views/SessionsView';
import { createSseClient } from '../src/sse';
import {
  changedSession,
  changes,
  deferred,
  jsonResponse,
  sessionList,
  sessionSummary,
} from './fixtures';
import { MockEventSource } from './mock-event-source';

const fetchMock = vi.fn();
const onAuthRejected = vi.fn();
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

beforeEach(() => {
  fetchMock.mockReset();
  onAuthRejected.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel() {
  return render(<ChangesPanel token="secret-token" nowMs={NOW} onAuthRejected={onAuthRejected} />);
}

function changesCalls(): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/api/changes'));
}

function sinceInput(): HTMLInputElement {
  return screen.getByLabelText('Changed since (UTC day)');
}

/** Type a day into the field and submit it. */
function ask(day: string): void {
  fireEvent.change(sinceInput(), { target: { value: day } });
  fireEvent.click(screen.getByRole('button', { name: 'Show changes' }));
}

async function askAndWait(day: string): Promise<void> {
  ask(day);
  await screen.findByTestId('changes-result');
}

describe('changeKindText', () => {
  it('prints the three known kinds verbatim - `unknown` is not folded into `updated`', () => {
    expect(changeKindText('new')).toBe('new');
    expect(changeKindText('updated')).toBe('updated');
    expect(changeKindText('unknown')).toBe('unknown');
  });

  it('quotes an unrecognised word back and names an absent one', () => {
    expect(changeKindText('renamed')).toBe('unrecognised ("renamed")');
    expect(changeKindText('')).toBe('unrecognised ("")');
    expect(changeKindText(undefined)).toBe(`unrecognised (${ABSENT_CHANGE_REASON})`);
  });
});

describe('previousUtcDay', () => {
  it('is the UTC calendar day before now, even just after UTC midnight', () => {
    expect(previousUtcDay(NOW)).toBe('2026-09-29');
    expect(previousUtcDay(Date.UTC(2026, 9, 1, 0, 0, 1))).toBe('2026-09-30');
  });
});

describe('ChangesPanel', () => {
  it('asks nothing until the reader submits, and pre-fills yesterday (UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      renderPanel();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sinceInput().value).toBe('2026-09-29');
      expect(screen.getByTestId('changes-prompt').textContent).toContain(
        'Nothing is read until you do.',
      );
      expect(screen.getByRole('form', { name: 'changed since' })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables the submit while the field is empty', () => {
    renderPanel();
    fireEvent.change(sinceInput(), { target: { value: '' } });
    expect(
      (screen.getByRole('button', { name: 'Show changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('fetches the submitted day with the Bearer header and lists the changed sessions', async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValue(answer.promise);
    renderPanel();
    ask('2026-09-28');

    expect(screen.getByText('Loading changes…')).toBeDefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/changes?since=2026-09-28&limit=${String(CHANGES_LIMIT)}`);
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });

    answer.resolve(
      jsonResponse(
        200,
        changes({
          sessions: [
            changedSession(),
            changedSession({
              id: 'dddddddd-1111-2222-3333-444444444444',
              projectSlug: null,
              change: 'unknown',
              changedAt: '2026-09-29T07:00:00.000Z',
              agentsAppeared: 1,
              tokensAdded: 500,
              costAddedUsd: 0.01,
              unpricedTokensAdded: 300,
            }),
          ],
        }),
      ),
    );
    const list = await screen.findByRole('list', { name: 'changed sessions' });
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe(
      'cccccccc… agenthropic - new at 2026-09-29T09:30:00.000Z · 2 agents appeared · 12.0k tokens · $0.42 added',
    );
    expect(items[1]?.textContent).toContain(
      'project unknown - unknown at 2026-09-29T07:00:00.000Z',
    );
    expect(items[1]?.textContent).toContain('1 agent appeared');
    expect(items[1]?.textContent).toContain('~ 300 unpriced');
    expect(screen.queryByText('Loading changes…')).toBeNull();
    expect(screen.queryByTestId('changes-prompt')).toBeNull();
  });

  it('states the window exactly as served: interval, both bounds and the event-time basis', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        changes({ since: '2026-09-27T22:00:00.000Z', until: '2026-09-30T01:02:03.000Z' }),
      ),
    );
    renderPanel();
    await askAndWait('2026-09-28');
    const window = screen.getByTestId('changes-window').textContent;
    expect(window).toContain(
      'Window (since, until] = (2026-09-27T22:00:00.000Z, 2026-09-30T01:02:03.000Z] over event-time',
    );
    expect(window).toContain('ingested afterwards is not in it');
    expect(window).toMatch(/^Changes read /);
  });

  it('reports the window totals, not a sum of the page', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        changes({
          total: 7,
          totals: {
            sessionsNew: 3,
            sessionsUpdated: 2,
            sessionsUnknownStart: 2,
            agentsAppeared: 1,
            tokensAdded: 90_000,
            costAddedUsd: 3.5,
            unpricedTokensAdded: 1_200,
            tokensAddedOutsideChangedSessions: 0,
          },
        }),
      ),
    );
    renderPanel();
    await askAndWait('2026-09-28');
    const totals = screen.getByTestId('changes-totals').textContent;
    expect(totals).toContain('7 sessions changed in the whole window: 3 new, 2 updated, 2 unknown');
    expect(totals).toContain('1 agent appeared; 90.0k tokens · $3.50 added · ~ 1,200 unpriced.');
  });

  it('discloses the slice when the window holds more sessions than the page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, changes({ total: 120 })));
    renderPanel();
    await askAndWait('2026-09-28');
    expect(screen.getByTestId('changes-truncation').textContent).toContain(
      'Showing 1 of 120 changed sessions - most recent change first',
    );
  });

  it('claims no slice when the page is the whole window', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, changes()));
    renderPanel();
    await askAndWait('2026-09-28');
    expect(screen.queryByTestId('changes-truncation')).toBeNull();
    expect(screen.queryByTestId('changes-count-disagreement')).toBeNull();
    expect(screen.queryByTestId('changes-truncation-unknown')).toBeNull();
  });

  it('names a count smaller than the rows served as a disagreement', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, changes({ total: 0 })));
    renderPanel();
    await askAndWait('2026-09-28');
    expect(screen.getByTestId('changes-count-disagreement').textContent).toContain(
      'These 1 rows outnumber the 0 changed sessions',
    );
  });

  it('says completeness is unknown when the count is not a finite number', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, changes({ total: Number.NaN })));
    renderPanel();
    await askAndWait('2026-09-28');
    expect(screen.getByTestId('changes-truncation-unknown')).toBeDefined();
    expect(screen.queryByTestId('changes-truncation')).toBeNull();
  });

  it('shows an empty window as empty, still dated and scoped', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, changes({ sessions: [], total: 0 })));
    renderPanel();
    await askAndWait('2026-09-28');
    expect(screen.getByTestId('changes-empty').textContent).toBe(
      'No session this database can date changed in this window.',
    );
    expect(screen.queryByRole('list', { name: 'changed sessions' })).toBeNull();
    expect(screen.getByTestId('changes-window')).toBeDefined();
  });

  it('does not call a page with no rows empty when the window says otherwise', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, changes({ sessions: [], total: 4 })));
    renderPanel();
    await askAndWait('2026-09-28');
    expect(screen.getByTestId('changes-truncation').textContent).toContain('Showing 0 of 4');
  });

  it('discloses tokens used outside every changed session, and only when there are some', async () => {
    const answer = changes();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...answer,
        totals: { ...answer.totals, tokensAddedOutsideChangedSessions: 4_000 },
      }),
    );
    renderPanel();
    await askAndWait('2026-09-28');
    expect(screen.getByTestId('changes-residue').textContent).toContain(
      '4,000 of those tokens were used in sessions whose own last activity falls outside this window',
    );
    expect(screen.queryByTestId('changes-coverage')).toBeNull();
  });

  it.each([
    [
      { undatedSessions: 1, undatedAgents: 0, undatedUsageRows: 0 },
      '1 session, 0 agents and 0 usage rows',
    ],
    [
      { undatedSessions: 0, undatedAgents: 1, undatedUsageRows: 0 },
      '0 sessions, 1 agent and 0 usage rows',
    ],
    [
      { undatedSessions: 0, undatedAgents: 0, undatedUsageRows: 1 },
      '0 sessions, 0 agents and 1 usage row',
    ],
  ])('counts what no window can see (%o)', async (coverage, expected) => {
    fetchMock.mockResolvedValue(jsonResponse(200, changes({ coverage })));
    renderPanel();
    await askAndWait('2026-09-28');
    const notice = screen.getByTestId('changes-coverage').textContent;
    expect(notice).toContain(`Outside every window: ${expected} carry no usable timestamp`);
    expect(screen.queryByTestId('changes-residue')).toBeNull();
  });

  it('surfaces a failure instead of an empty list, and retries the same day', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: 'since must be an ISO-8601 instant.' }))
      .mockResolvedValueOnce(jsonResponse(200, changes()));
    renderPanel();
    ask('2026-09-28');

    await screen.findByText(/Could not load changes: since must be an ISO-8601 instant\./);
    expect(screen.queryByTestId('changes-empty')).toBeNull();
    expect(screen.queryByRole('list', { name: 'changed sessions' })).toBeNull();

    // The field is edited after the failure; the retry re-asks what failed.
    fireEvent.change(sinceInput(), { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry changes' }));
    await screen.findByRole('list', { name: 'changed sessions' });
    expect(changesCalls()).toEqual([
      `/api/changes?since=2026-09-28&limit=${String(CHANGES_LIMIT)}`,
      `/api/changes?since=2026-09-28&limit=${String(CHANGES_LIMIT)}`,
    ]);
  });

  it('hands a 401 to the shell rather than rendering it as a local error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized.' }));
    renderPanel();
    ask('2026-09-28');
    await waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Could not load changes/)).toBeNull();
  });

  it('re-reads when the same day is submitted again', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, changes()));
    renderPanel();
    await askAndWait('2026-09-28');
    ask('2026-09-28');
    await waitFor(() => expect(changesCalls()).toHaveLength(2));
  });

  it('never lets a superseded answer overwrite the newer question', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderPanel();
    ask('2026-09-01');
    ask('2026-09-28');

    await act(async () => {
      second.resolve(jsonResponse(200, changes({ since: '2026-09-28T00:00:00.000Z' })));
      await second.promise;
    });
    await screen.findByTestId('changes-result');
    await act(async () => {
      first.resolve(jsonResponse(200, changes({ since: '2026-09-01T00:00:00.000Z' })));
      await first.promise;
    });
    expect(screen.getByTestId('changes-window').textContent).toContain(
      '(2026-09-28T00:00:00.000Z,',
    );
  });
});

describe('the Sessions view carries the changed-since list', () => {
  it('renders it under its own heading and requests nothing from /api/changes on mount', async () => {
    MockEventSource.reset();
    vi.stubGlobal('EventSource', MockEventSource);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith('/api/changes')
          ? jsonResponse(200, changes())
          : jsonResponse(200, sessionList([sessionSummary()])),
      ),
    );
    render(
      <SessionsView
        token="secret-token"
        sse={createSseClient('secret-token')}
        onAuthRejected={onAuthRejected}
      />,
    );
    await screen.findByRole('list', { name: 'session list' });
    expect(screen.getByRole('heading', { name: 'Changed since' })).toBeDefined();
    expect(changesCalls()).toHaveLength(0);

    await askAndWait('2026-09-28');
    expect(changesCalls()).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'changed sessions' })).toBeDefined();
  });
});
