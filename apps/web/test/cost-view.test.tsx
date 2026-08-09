/**
 * CostView (WP-U9): totals, sankey flow, per-model / per-day / top-session
 * tables. The suite pins the unpriced honesty: `unpricedTokens` appears as
 * its own KPI, as a `~ n` cell in every table and in node titles - never
 * hidden, never rendered as $0. fetch is mocked - no real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { CostView, COST_TOP_N } from '../src/views/CostView';
import { createSseClient, type SseClient } from '../src/sse';
import { costAnalysis, costSummary, jsonResponse } from './fixtures';
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
  return render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
}

/** A summary with priced flow, a zero-cost model, and unpriced gaps. */
function richSummary() {
  return costSummary({
    totals: { tokens: 50000, costUsd: 1.25, unpricedTokens: 4000 },
    perModel: [
      { model: 'claude-opus-4', tokens: 30000, costUsd: 1.0, unpricedTokens: 0 },
      { model: 'claude-haiku-3', tokens: 15000, costUsd: 0.25, unpricedTokens: 0 },
      { model: 'claude-mystery', tokens: 5000, costUsd: 0, unpricedTokens: 4000 },
    ],
    perDay: [
      { day: '2026-07-28', tokens: 20000, costUsd: 0.5, unpricedTokens: 0 },
      { day: '2026-07-29', tokens: 25000, costUsd: 0.75, unpricedTokens: 0 },
      { day: 'unknown', tokens: 5000, costUsd: 0, unpricedTokens: 4000 },
    ],
    topSessions: [
      {
        sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
        projectSlug: 'agenthropic',
        tokens: 40000,
        costUsd: 1.0,
        unpricedTokens: 0,
      },
      {
        sessionId: 'bbbbbbbb-5555-6666-7777-888888888888',
        projectSlug: null,
        tokens: 5000,
        costUsd: 0.05,
        unpricedTokens: 4000,
      },
    ],
  });
}

describe('CostView', () => {
  it('requests the summary with topN and the Bearer header, then renders the KPIs', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richSummary()));
    renderView();

    expect(screen.getByText('Loading cost summary…')).toBeDefined();
    await screen.findByLabelText('totals');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/cost/summary?topN=${String(COST_TOP_N)}`);
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });

    expect(screen.getByText('$1.25')).toBeDefined();
    expect(screen.getByText('50.0k')).toBeDefined();
    const unpriced = screen.getByTestId('kpi-unpriced');
    expect(unpriced.textContent).toContain('4,000');
    expect(unpriced.textContent).toContain('no price row matched - not counted in $');
    expect(unpriced.querySelector('.kpi-value')?.getAttribute('class')).toContain('unpriced');
  });

  it('draws the sankey from real dollar values only, with the model legend', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richSummary()));
    const { container } = renderView();
    await screen.findByRole('img', { name: 'cost flow from models to sessions' });

    // model->hub x2, hub->session x2, hub->other-sessions remainder.
    expect(container.querySelectorAll('path.flow-link')).toHaveLength(5);
    const titles = [...container.querySelectorAll('path.flow-link title')].map(
      (title) => title.textContent,
    );
    expect(titles).toContain('model:claude-opus-4 -> hub: $1.00');
    expect(titles).toContain('hub -> other-sessions: $0.20');

    const legend = screen.getByLabelText('model legend');
    expect(legend.textContent).toContain('claude-opus-4');
    expect(legend.textContent).toContain('claude-haiku-3');
    // The zero-cost model is never drawn as a $0 flow - it is reported aside.
    expect(legend.textContent).not.toContain('claude-mystery');
    expect(screen.getByTestId('zero-cost-models').textContent).toBe(
      'Not in the flow (usage but $0 priced): claude-mystery.',
    );
  });

  it('renders unpriced cells as ~ markers and zeros as plain zeros in every table', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richSummary()));
    renderView();
    await screen.findByLabelText('totals');

    const modelTable = screen.getByRole('table', { name: 'cost per model' });
    const mysteryRow = [...modelTable.querySelectorAll('tbody tr')].find((row) =>
      row.textContent?.includes('claude-mystery'),
    );
    expect(mysteryRow?.textContent).toContain('~ 4,000');
    expect(mysteryRow?.textContent).toContain('$0.00');
    const opusRow = [...modelTable.querySelectorAll('tbody tr')].find((row) =>
      row.textContent?.includes('claude-opus-4'),
    );
    expect(opusRow?.querySelector('td.num.muted')?.textContent).toBe('0');

    const sessionsTable = screen.getByRole('table', { name: 'top sessions by cost' });
    expect(sessionsTable.textContent).toContain('aaaaaaaa…');
    expect(sessionsTable.textContent).toContain('project unknown');
    expect(sessionsTable.textContent).toContain('~ 4,000');
  });

  it('renders the per-day table with the unknown day muted and honest bar widths', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richSummary()));
    const { container } = renderView();
    await screen.findByLabelText('totals');

    const dayTable = screen.getByRole('table', { name: 'cost per day' });
    const unknownCell = [...dayTable.querySelectorAll('td')].find(
      (cell) => cell.textContent === 'unknown',
    );
    expect(unknownCell?.getAttribute('class')).toBe('muted');

    const bars = [...container.querySelectorAll('.bar-fill')] as HTMLElement[];
    expect(bars).toHaveLength(3);
    expect(bars[1]?.style.width).toBe('100%');
    expect(bars[2]?.style.width).toBe('0%');
  });

  it('draws no daily bar when every day costs $0, and still shows the unpriced tokens', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 9000, costUsd: 0, unpricedTokens: 9000 },
          perDay: [
            { day: '2026-07-28', tokens: 4000, costUsd: 0, unpricedTokens: 4000 },
            { day: '2026-07-29', tokens: 5000, costUsd: 0, unpricedTokens: 5000 },
          ],
        }),
      ),
    );
    const { container } = renderView();
    await screen.findByLabelText('totals');

    // No priced day exists, so no bar may claim a share of a zero maximum.
    const bars = [...container.querySelectorAll('.bar-fill')] as HTMLElement[];
    expect(bars.map((bar) => bar.style.width)).toEqual(['0%', '0%']);

    // The $0 is never the whole story: the unpriced tokens stay on the row.
    const dayTable = screen.getByRole('table', { name: 'cost per day' });
    expect(dayTable.textContent).toContain('~ 4,000');
    expect(dayTable.textContent).toContain('~ 5,000');
    expect(dayTable.querySelectorAll('td.unpriced')).toHaveLength(2);
  });

  it('says honestly when nothing is priced instead of drawing an empty sankey', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 5000, costUsd: 0, unpricedTokens: 5000 },
          perModel: [{ model: 'claude-mystery', tokens: 5000, costUsd: 0, unpricedTokens: 5000 }],
        }),
      ),
    );
    renderView();

    await screen.findByText(/Nothing priced yet - no dollar flow to draw\./);
    expect(screen.queryByRole('img', { name: 'cost flow from models to sessions' })).toBeNull();
    expect(screen.getByTestId('zero-cost-models').textContent).toContain('claude-mystery');
  });

  it('renders honest empty states for all three tables on a fresh database', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, costSummary()));
    renderView();
    await screen.findByLabelText('totals');

    expect(screen.getByText('No per-model usage recorded yet.')).toBeDefined();
    expect(screen.getByText('No daily usage recorded yet.')).toBeDefined();
    expect(screen.getByText('No sessions recorded yet.')).toBeDefined();
  });

  it('shows the error state on a failed fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal server error.' }));
    renderView();
    await screen.findByText(/Could not load cost summary: Internal server error\./);
  });

  it('calls onAuthRejected on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized.' }));
    renderView();
    await waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Could not load cost summary/)).toBeNull();
  });

  /**
   * Per-session analysis reads transcripts off disk, so it is opt-in per
   * session rather than fetched for every row. These two tests pin that: no
   * analysis request may leave before a row is picked, and picking one must
   * request exactly that session.
   */
  it('fetches no per-session analysis until a session is picked', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richSummary()));
    renderView();
    await screen.findByLabelText('totals');

    expect(screen.getByTestId('analysis-prompt').textContent).toContain('Pick a session above');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('cost-analysis'))).toBe(
      true,
    );
  });

  it('analyses the picked session and marks its row as selected', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('cost-analysis')
          ? jsonResponse(200, costAnalysis())
          : jsonResponse(200, richSummary()),
      ),
    );
    renderView();
    await screen.findByLabelText('totals');

    const sessionsTable = screen.getByRole('table', { name: 'top sessions by cost' });
    const [firstRow, secondRow] = [...sessionsTable.querySelectorAll('tbody tr')];
    secondRow?.querySelector('button')?.click();

    await screen.findByTestId('session-analysis');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/bbbbbbbb-5555-6666-7777-888888888888/cost-analysis',
      expect.anything(),
    );
    expect(screen.queryByTestId('analysis-prompt')).toBeNull();
    expect(secondRow?.getAttribute('aria-selected')).toBe('true');
    expect(secondRow?.getAttribute('class')).toBe('row-selected');
    expect(firstRow?.getAttribute('aria-selected')).toBe('false');
    expect(firstRow?.getAttribute('class')).toBeNull();
  });
});
