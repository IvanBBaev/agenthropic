/**
 * CostView (WP-U9): totals, sankey flow, per-model / per-day / top-session
 * tables. The suite pins the unpriced honesty: `unpricedTokens` appears as
 * its own KPI, as a `~ n` cell in every table and in node titles - never
 * hidden, never rendered as $0. fetch is mocked - no real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { CostView, COST_TOP_N, TOP_BURNERS_N, TOP_BURNERS_NODE_LIMIT } from '../src/views/CostView';
import { createSseClient, type SseClient } from '../src/sse';
import {
  agentNode,
  costAnalysis,
  costSummary,
  deferred,
  globalDag,
  jsonResponse,
} from './fixtures';
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
  // Some tests pin Date.now for the UTC-window KPIs; never leak that clock.
  vi.restoreAllMocks();
});

/**
 * The view now rides two endpoints (summary + global DAG for the burners
 * table), so the fetch mock routes by URL. Defaults keep the burners panel in
 * its honest empty state; tests override only the response they exercise.
 */
function routeFetch(
  responses: {
    summary?: Response;
    dag?: Response;
    analysis?: Response;
  } = {},
) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('cost-analysis')) {
      return Promise.resolve(responses.analysis ?? jsonResponse(200, costAnalysis()));
    }
    if (url.includes('/api/dag/global')) {
      return Promise.resolve(responses.dag ?? jsonResponse(200, globalDag()));
    }
    return Promise.resolve(responses.summary ?? jsonResponse(200, richSummary()));
  });
}

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
    routeFetch();
    renderView();

    expect(screen.getByText('Loading cost summary…')).toBeDefined();
    await screen.findByLabelText('totals');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/cost/summary?topN=${String(COST_TOP_N)}`);
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });

    expect(screen.getByText('$1.25')).toBeDefined();
    expect(screen.getByText('50.0k')).toBeDefined();
    // The all-time tiles say so, now that windowed KPIs sit next to them.
    expect(screen.getAllByText('all time')).toHaveLength(2);
    const unpriced = screen.getByTestId('kpi-unpriced');
    expect(unpriced.textContent).toContain('4,000');
    expect(unpriced.textContent).toContain('no price row matched - not counted in $');
    expect(unpriced.querySelector('.kpi-value')?.getAttribute('class')).toContain('unpriced');
  });

  it('draws the sankey from real dollar values only, with the model legend', async () => {
    routeFetch();
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
    routeFetch();
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
    routeFetch();
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
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          totals: { tokens: 9000, costUsd: 0, unpricedTokens: 9000 },
          perDay: [
            { day: '2026-07-28', tokens: 4000, costUsd: 0, unpricedTokens: 4000 },
            { day: '2026-07-29', tokens: 5000, costUsd: 0, unpricedTokens: 5000 },
          ],
        }),
      ),
    });
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
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          totals: { tokens: 5000, costUsd: 0, unpricedTokens: 5000 },
          perModel: [{ model: 'claude-mystery', tokens: 5000, costUsd: 0, unpricedTokens: 5000 }],
        }),
      ),
    });
    renderView();

    await screen.findByText(/Nothing priced yet - no dollar flow to draw\./);
    expect(screen.queryByRole('img', { name: 'cost flow from models to sessions' })).toBeNull();
    expect(screen.getByTestId('zero-cost-models').textContent).toContain('claude-mystery');
  });

  it('renders honest empty states for all three tables on a fresh database', async () => {
    routeFetch({ summary: jsonResponse(200, costSummary()) });
    renderView();
    await screen.findByLabelText('totals');

    expect(screen.getByText('No per-model usage recorded yet.')).toBeDefined();
    expect(screen.getByText('No daily usage recorded yet.')).toBeDefined();
    expect(screen.getByText('No sessions recorded yet.')).toBeDefined();
  });

  it('shows the error state on a failed fetch', async () => {
    routeFetch({ summary: jsonResponse(500, { error: 'Internal server error.' }) });
    renderView();
    await screen.findByText(/Could not load cost summary: Internal server error\./);
  });

  it('calls onAuthRejected on a summary 401', async () => {
    routeFetch({ summary: jsonResponse(401, { error: 'Unauthorized.' }) });
    renderView();
    await waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Could not load cost summary/)).toBeNull();
  });

  it('calls onAuthRejected on a DAG 401', async () => {
    routeFetch({ dag: jsonResponse(401, { error: 'Unauthorized.' }) });
    renderView();
    await waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Could not load agent burners/)).toBeNull();
  });

  /**
   * Per-session analysis reads transcripts off disk, so it is opt-in per
   * session rather than fetched for every row. These two tests pin that: no
   * analysis request may leave before a row is picked, and picking one must
   * request exactly that session.
   */
  it('fetches no per-session analysis until a session is picked', async () => {
    routeFetch();
    renderView();
    await screen.findByLabelText('totals');

    expect(screen.getByTestId('analysis-prompt').textContent).toContain('Pick a session above');
    // Exactly two requests may leave on mount: the summary and the DAG.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('cost-analysis'))).toBe(
      true,
    );
  });

  it('analyses the picked session and marks its row as selected', async () => {
    routeFetch();
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

  /**
   * M-8: the burners table. The ranking maths is pinned in top-burners.test.ts;
   * these tests pin the DAG request, the table itself, the honesty copy about
   * scope/truncation, and that a burners failure degrades one section only.
   */
  it('requests the global DAG with the burner cap and ranks agents without hover', async () => {
    routeFetch({
      dag: jsonResponse(
        200,
        globalDag({
          nodes: [
            agentNode({ id: 'agent-mid', totalTokens: 5000, costUsd: 0.5 }),
            agentNode({
              id: 'agent-big',
              type: 'subagent',
              subagentType: 'Explore',
              totalTokens: 9000,
              costUsd: 0,
              unpricedTokens: 9000,
            }),
            agentNode({ id: 'agent-idle', totalTokens: 0, costUsd: 0 }),
          ],
        }),
      ),
    });
    renderView();

    const table = await screen.findByRole('table', { name: 'top agents by token burn' });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/dag/global?limit=${String(TOP_BURNERS_NODE_LIMIT)}`,
      expect.anything(),
    );

    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    // Heaviest token burn first, even though its priced cost is $0.00 - the
    // unpriced tokens are real burn and the cell says so.
    expect(rows[0]?.textContent).toContain('agent-big');
    expect(rows[0]?.textContent).toContain('Explore');
    expect(rows[0]?.textContent).toContain('$0.00');
    expect(rows[0]?.textContent).toContain('~ 9,000');
    expect(rows[1]?.textContent).toContain('agent-mid');
    expect(table.textContent).not.toContain('agent-idle');

    const scope = screen.getByTestId('burners-scope').textContent;
    expect(scope).toContain('All 2 agents with recorded usage.');
    expect(scope).toContain('Not ranked: 1 agent with zero recorded tokens.');
    expect(scope).toContain('Usage unattributed to any persisted agent is outside this ranking.');
    expect(screen.queryByTestId('burners-truncation')).toBeNull();
  });

  it('uses singular copy when exactly one agent ranks', async () => {
    routeFetch({
      dag: jsonResponse(200, globalDag({ nodes: [agentNode({ totalTokens: 800 })] })),
    });
    renderView();
    await screen.findByRole('table', { name: 'top agents by token burn' });

    const scope = screen.getByTestId('burners-scope').textContent;
    expect(scope).toContain('All 1 agent with recorded usage.');
    expect(scope).not.toContain('Not ranked');
  });

  it('labels the ranking honestly when it truncates to the top N', async () => {
    const ranked = Array.from({ length: TOP_BURNERS_N + 1 }, (_, index) =>
      agentNode({ id: `agent-${String(index).padStart(2, '0')}`, totalTokens: 1000 + index }),
    );
    routeFetch({
      dag: jsonResponse(
        200,
        globalDag({
          nodes: [
            ...ranked,
            agentNode({ id: 'agent-zero-a', totalTokens: 0, costUsd: 0 }),
            agentNode({ id: 'agent-zero-b', totalTokens: 0, costUsd: 0 }),
          ],
        }),
      ),
    });
    renderView();

    const table = await screen.findByRole('table', { name: 'top agents by token burn' });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(TOP_BURNERS_N);
    const scope = screen.getByTestId('burners-scope').textContent;
    expect(scope).toContain(
      `Top ${String(TOP_BURNERS_N)} of ${String(TOP_BURNERS_N + 1)} agents with recorded usage.`,
    );
    expect(scope).toContain('Not ranked: 2 agents with zero recorded tokens.');
  });

  it('discloses the recency slice when the server truncated the DAG', async () => {
    routeFetch({
      dag: jsonResponse(
        200,
        globalDag({
          nodes: [agentNode({ totalTokens: 800 })],
          counts: { totalAgents: 1500, returnedAgents: 1000, truncated: true },
        }),
      ),
    });
    renderView();

    const banner = await screen.findByTestId('burners-truncation');
    expect(banner.textContent).toContain('1000 most recently active of 1500 agents');
    expect(banner.textContent).toContain('an older agent may have burned more');
  });

  it('shows an honest empty state when no agent has recorded usage', async () => {
    routeFetch();
    renderView();
    await screen.findByText('No agent has recorded token usage yet.');
    expect(screen.queryByRole('table', { name: 'top agents by token burn' })).toBeNull();
  });

  it('degrades only the burners section when the DAG fetch fails', async () => {
    routeFetch({ dag: jsonResponse(500, { error: 'Internal server error.' }) });
    renderView();
    await screen.findByText(/Could not load agent burners: Internal server error\./);
    // The rest of the cost view stays up: a burners failure is one section.
    expect(screen.getByRole('table', { name: 'top sessions by cost' })).toBeDefined();
  });

  it('shows the burners loading state while the DAG request is in flight', async () => {
    const dag = deferred<Response>();
    fetchMock.mockImplementation((url: string) =>
      url.includes('/api/dag/global')
        ? dag.promise
        : Promise.resolve(jsonResponse(200, richSummary())),
    );
    renderView();
    await screen.findByLabelText('totals');
    expect(screen.getByText('Loading agent burners…')).toBeDefined();

    dag.resolve(jsonResponse(200, globalDag({ nodes: [agentNode({ totalTokens: 800 })] })));
    await screen.findByRole('table', { name: 'top agents by token burn' });
  });

  it('drops fetch results that land after unmount', async () => {
    const summary = deferred<Response>();
    const dag = deferred<Response>();
    fetchMock.mockImplementation((url: string) =>
      url.includes('/api/dag/global') ? dag.promise : summary.promise,
    );
    const { unmount } = renderView();
    unmount();

    // Resolving as 401 makes the guard observable: without the aborted check
    // both callbacks would fire onAuthRejected after unmount.
    summary.resolve(jsonResponse(401, { error: 'Unauthorized.' }));
    dag.resolve(jsonResponse(401, { error: 'Unauthorized.' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAuthRejected).not.toHaveBeenCalled();
  });

  /**
   * M-9: the UTC-window KPIs. The window maths is pinned in
   * cost-windows.test.ts; these tests pin the labels - the day basis is named
   * (UTC), never silently assumed local - and the disclosures.
   */
  it('renders today and last-7-days KPIs with explicit UTC boundaries', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 15, 12, 0, 0));
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          totals: { tokens: 12000, costUsd: 0.7, unpricedTokens: 5600 },
          perDay: [
            { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 100 },
            { day: '2026-08-09', tokens: 2000, costUsd: 0.2, unpricedTokens: 500 },
            { day: '2026-08-08', tokens: 4000, costUsd: 0.4, unpricedTokens: 0 },
            { day: 'unknown', tokens: 5000, costUsd: 0, unpricedTokens: 5000 },
          ],
        }),
      ),
    });
    renderView();
    await screen.findByLabelText('recent windows');

    const today = screen.getByTestId('kpi-today');
    expect(today.textContent).toContain('Today (UTC)');
    expect(today.textContent).toContain('$0.10');
    expect(today.textContent).toContain('2026-08-15 · 1,000 tokens');
    expect(today.textContent).toContain('~ 100 unpriced');

    const week = screen.getByTestId('kpi-week');
    expect(week.textContent).toContain('Last 7 days (UTC)');
    expect(week.textContent).toContain('$0.30');
    expect(week.textContent).toContain('2026-08-09 → 2026-08-15 · 3,000 tokens');
    expect(week.textContent).toContain('~ 600 unpriced');

    const basis = screen.getByTestId('windows-basis').textContent;
    expect(basis).toContain('UTC calendar days');
    expect(basis).toContain('5,000 tokens carry no timestamp');
  });

  it('shows measured zeros for the windows when all usage is older than 7 days', async () => {
    // richSummary's perDay rows are fixed July dates, long past under the real
    // clock, so both windows are genuinely empty - and say so as $0.00.
    routeFetch();
    renderView();
    await screen.findByLabelText('recent windows');

    expect(screen.getByTestId('kpi-today').textContent).toContain('$0.00');
    expect(screen.getByTestId('kpi-today').textContent).not.toContain('unpriced');
    expect(screen.getByTestId('kpi-week').textContent).toContain('$0.00');
    // richSummary has an 'unknown' perDay row - the basis note must name it.
    expect(screen.getByTestId('windows-basis').textContent).toContain(
      '5,000 tokens carry no timestamp',
    );
  });
});
