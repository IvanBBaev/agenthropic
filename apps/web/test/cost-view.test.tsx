/**
 * CostView (WP-U9): totals, sankey flow, per-model / per-day / top-session
 * tables. The suite pins the unpriced honesty: `unpricedTokens` appears as
 * its own KPI, as a `~ n` cell in every table and in node titles - never
 * hidden, never rendered as $0. fetch is mocked - no real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { CostView, COST_TOP_N, TOP_BURNERS_N, TOP_BURNERS_NODE_LIMIT } from '../src/views/CostView';
// M-10: the windows ride the app's shared clock, so the rollover test advances it.
import { CLOCK_INTERVAL_MS } from '../src/clock';
import { createSseClient, type SseClient } from '../src/sse';
import type { CostSummaryDto } from '../src/dto';
import {
  agentNode,
  aggregateSavings,
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
  vi.useRealTimers();
});

/**
 * The view now rides three endpoints (summary, global DAG for the burners
 * table, and the aggregate delegation savings), so the fetch mock routes by
 * URL. Defaults keep the burners and savings panels in their honest empty
 * state; tests override only the response they exercise.
 *
 * The summary is the FALLBACK arm, so every route added to the view must be
 * matched explicitly above it - an unmatched new endpoint would silently be
 * served a CostSummaryDto and fail somewhere far from its cause.
 */
function routeFetch(
  responses: {
    summary?: Response;
    dag?: Response;
    analysis?: Response;
    savings?: Response;
  } = {},
) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('cost-analysis')) {
      return Promise.resolve(responses.analysis ?? jsonResponse(200, costAnalysis()));
    }
    if (url.includes('/api/dag/global')) {
      return Promise.resolve(responses.dag ?? jsonResponse(200, globalDag()));
    }
    if (url.includes('/api/cost/delegation-savings')) {
      return Promise.resolve(responses.savings ?? jsonResponse(200, aggregateSavings()));
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
    // Exactly three requests may leave on mount: the summary, the DAG and the
    // aggregate savings. The count is asserted, not just the absence of a
    // cost-analysis URL, so a fourth always-on endpoint has to be justified here.
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/dag/global')) return dag.promise;
      if (url.includes('/api/cost/delegation-savings')) {
        return Promise.resolve(jsonResponse(200, aggregateSavings()));
      }
      return Promise.resolve(jsonResponse(200, richSummary()));
    });
    renderView();
    await screen.findByLabelText('totals');
    expect(screen.getByText('Loading agent burners…')).toBeDefined();

    dag.resolve(jsonResponse(200, globalDag({ nodes: [agentNode({ totalTokens: 800 })] })));
    await screen.findByRole('table', { name: 'top agents by token burn' });
  });

  it('drops fetch results that land after unmount', async () => {
    const summary = deferred<Response>();
    const dag = deferred<Response>();
    const savings = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/dag/global')) return dag.promise;
      if (url.includes('/api/cost/delegation-savings')) return savings.promise;
      return summary.promise;
    });
    const { unmount } = renderView();
    unmount();

    // Resolving as 401 makes the guard observable: without the aborted check
    // all three callbacks would fire onAuthRejected after unmount.
    summary.resolve(jsonResponse(401, { error: 'Unauthorized.' }));
    dag.resolve(jsonResponse(401, { error: 'Unauthorized.' }));
    savings.resolve(jsonResponse(401, { error: 'Unauthorized.' }));
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

  /**
   * M-10: the windows are cut against the shared clock, so a tab left open
   * across UTC midnight rolls over on its own. The test crosses the boundary
   * with fake timers and asserts what the reader sees change - not that a
   * timer was registered.
   */
  it('rolls the UTC windows over at midnight without a refetch or a reload', async () => {
    vi.useFakeTimers();
    // Ten seconds before the boundary, so one clock tick crosses it.
    vi.setSystemTime(Date.UTC(2026, 7, 15, 23, 59, 50));
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          totals: { tokens: 10000, costUsd: 1.0, unpricedTokens: 0 },
          perDay: [
            // Dated ahead of "now" at mount: outside both windows until the
            // boundary moves, then it becomes the whole of today.
            { day: '2026-08-16', tokens: 7000, costUsd: 0.7, unpricedTokens: 0 },
            { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
            // The oldest day in the week window - it falls out at rollover.
            { day: '2026-08-09', tokens: 2000, costUsd: 0.2, unpricedTokens: 0 },
          ],
        }),
      ),
    });
    renderView();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId('kpi-today').textContent).toContain('2026-08-15 · 1,000 tokens');
    expect(screen.getByTestId('kpi-today').textContent).toContain('$0.10');
    expect(screen.getByTestId('kpi-week').textContent).toContain(
      '2026-08-09 → 2026-08-15 · 3,000 tokens',
    );
    const callsBeforeMidnight = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
    });

    // A new UTC day: the label and the figures move together, because both
    // are cut from the same tick.
    expect(screen.getByTestId('kpi-today').textContent).toContain('2026-08-16 · 7,000 tokens');
    expect(screen.getByTestId('kpi-today').textContent).toContain('$0.70');
    // The window slid: 2026-08-09 dropped out, 2026-08-16 came in.
    expect(screen.getByTestId('kpi-week').textContent).toContain(
      '2026-08-10 → 2026-08-16 · 8,000 tokens',
    );
    expect(screen.getByTestId('kpi-week').textContent).toContain('$0.80');
    // Re-cutting the served rows is arithmetic, not a reason to hit the API.
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeMidnight);
  });

  /**
   * M-9 (aggregate half). These tests exist for one reason: the three dollar
   * figures must never appear on screen without the scope that produced them.
   * Every assertion below is about a DISCLOSURE - the denominator, the
   * exclusions, the estimate marker - not about the arithmetic, which is pinned
   * server-side.
   */
  it('states the aggregate scope and marks the figures as an estimate', async () => {
    routeFetch({
      savings: jsonResponse(
        200,
        aggregateSavings({
          actualUsd: 1.25,
          hypotheticalUsd: 4.5,
          savingsUsd: 3.25,
          sessionsTotal: 52,
          sessionsWithSubagents: 40,
          sessionsPriced: 36,
          subagentsPriced: 900,
          hypotheticalModels: ['claude-opus-4'],
        }),
      ),
    });
    renderView();

    await screen.findByLabelText('aggregate delegation savings');
    // The estimate marker is structural, not decorative: a counterfactual run
    // never happened, so the figure may never render bare.
    expect(screen.getByTestId('aggregate-estimate-badge').textContent).toBe('estimate');
    expect(screen.getByTestId('kpi-aggregate-savings').textContent).toContain('~ $3.25');
    // The measured half carries no `~`, and says whose dollars they are.
    const actual = screen.getByTestId('kpi-aggregate-actual').textContent ?? '';
    expect(actual).toContain('Subagent spend, actual');
    expect(actual).toContain('$1.25');
    expect(actual).not.toContain('~');
    // The counterfactual half is scoped in its own label and note - it is a
    // subagents-only figure standing next to "Subagent spend", and an unscoped
    // "Without delegation" there would read as a corpus-wide total.
    const hypothetical = screen.getByTestId('kpi-aggregate-hypothetical').textContent ?? '';
    expect(hypothetical).toContain('Same work, no delegation');
    expect(hypothetical).toContain('estimated, subagents only, on claude-opus-4');
    expect(hypothetical).not.toContain('Without delegation');
    // The denominator, spelled out: 36 of 40 of 52.
    const scope = screen.getByTestId('aggregate-savings-scope').textContent ?? '';
    expect(scope).toContain('36 sessions priced of 40 sessions that recorded a subagent');
    expect(scope).toContain('52 sessions in the database');
    expect(scope).toContain('measured zero, not a gap');
    // Nothing was skipped, so no exclusion copy is invented.
    expect(screen.queryByTestId('aggregate-savings-skipped')).toBeNull();
  });

  it('names every excluded session rather than counting it as $0', async () => {
    routeFetch({
      savings: jsonResponse(
        200,
        aggregateSavings({
          sessionsTotal: 3,
          sessionsWithSubagents: 3,
          sessionsPriced: 1,
          skippedSessionCount: 2,
          skippedSessions: [
            {
              sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
              reason: 'unpriceable',
              detail: 'no price row for claude-opus-5 on 2026-08-20',
            },
            {
              sessionId: 'bbbbbbbb-5555-6666-7777-888888888888',
              reason: 'undated-usage',
              detail: 'usage row 41 carries no timestamp',
            },
          ],
          subagentsPriced: 4,
          subagentsSkipped: 2,
          untypedAgents: 3,
        }),
      ),
    });
    renderView();

    const table = await screen.findByRole('table', {
      name: 'sessions excluded from the delegation estimate',
    });
    expect(screen.getByTestId('aggregate-savings-skipped').textContent).toContain(
      '2 sessions could not be priced and are excluded',
    );
    // Both reasons render as prose; a raw enum on screen would be a leak.
    expect(table.textContent).toContain('No dated price');
    expect(table.textContent).toContain('Usage row carries no date');
    expect(table.textContent).toContain('no price row for claude-opus-5 on 2026-08-20');
    // The list is complete here, so no sample caveat is claimed.
    expect(screen.queryByTestId('aggregate-savings-sample-note')).toBeNull();
    const scope = screen.getByTestId('aggregate-savings-scope').textContent ?? '';
    expect(scope).toContain('2 subagents of 6');
    expect(scope).toContain('are left out - never guessed at');
    expect(scope).toContain('3 agent rows in the database carry no recorded type');
  });

  it('keeps the excluded COUNT authoritative when the server caps the list', async () => {
    routeFetch({
      savings: jsonResponse(
        200,
        aggregateSavings({
          sessionsTotal: 100,
          sessionsWithSubagents: 90,
          sessionsPriced: 69,
          skippedSessionCount: 21,
          skippedSessions: [
            {
              sessionId: 'cccccccc-9999-0000-1111-222222222222',
              reason: 'unpriceable',
              detail: 'no price row',
            },
          ],
          subagentsPriced: 10,
          subagentsSkipped: 1,
          untypedAgents: 1,
        }),
      ),
    });
    renderView();

    await screen.findByTestId('aggregate-savings-sample-note');
    // The sample is 1 row; the truth is 21. Saying only "1" would understate
    // the gap by twenty sessions, which is exactly the lie this note prevents.
    expect(screen.getByTestId('aggregate-savings-sample-note').textContent).toContain(
      'Showing 1 of 21 excluded sessions',
    );
    expect(screen.getByTestId('aggregate-savings-skipped').textContent).toContain(
      '21 sessions could not be priced and are excluded',
    );
    // Singular agreement on the one-of-each counters.
    const scope = screen.getByTestId('aggregate-savings-scope').textContent ?? '';
    expect(scope).toContain('1 subagent of 11');
    expect(scope).toContain('is left out');
    expect(scope).toContain('1 agent row in the database');
  });

  it('says "is" for a single excluded session', async () => {
    routeFetch({
      savings: jsonResponse(
        200,
        aggregateSavings({
          sessionsTotal: 1,
          sessionsWithSubagents: 1,
          sessionsPriced: 0,
          skippedSessionCount: 1,
          skippedSessions: [
            {
              sessionId: 'dddddddd-3333-4444-5555-666666666666',
              reason: 'unpriceable',
              detail: 'no price row',
            },
          ],
        }),
      ),
    });
    renderView();

    await screen.findByTestId('aggregate-savings-skipped');
    expect(screen.getByTestId('aggregate-savings-skipped').textContent).toContain(
      '1 session could not be priced and is excluded',
    );
    expect(screen.getByTestId('aggregate-savings-scope').textContent).toContain(
      '0 sessions priced of 1 session that recorded a subagent, out of 1 session',
    );
  });

  it('shows the savings loading state while the request is in flight', async () => {
    const savings = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/dag/global')) return Promise.resolve(jsonResponse(200, globalDag()));
      if (url.includes('/api/cost/delegation-savings')) return savings.promise;
      return Promise.resolve(jsonResponse(200, richSummary()));
    });
    renderView();
    await screen.findByLabelText('totals');
    expect(screen.getByText('Loading delegation savings…')).toBeDefined();

    savings.resolve(jsonResponse(200, aggregateSavings()));
    await screen.findByLabelText('aggregate delegation savings');
  });

  it('degrades only the savings section when its endpoint fails', async () => {
    routeFetch({ savings: jsonResponse(500, { error: 'Internal server error.' }) });
    renderView();

    await screen.findByText(/Could not load delegation savings: Internal server error\./);
    // One failed section, not one failed page.
    expect(screen.getByRole('table', { name: 'top sessions by cost' })).toBeDefined();
    expect(screen.getByLabelText('totals')).toBeDefined();
  });

  it('reports an expired token from the savings endpoint like every other', async () => {
    routeFetch({ savings: jsonResponse(401, { error: 'Unauthorized.' }) });
    renderView();

    await waitFor(() => {
      expect(onAuthRejected).toHaveBeenCalled();
    });
  });

  /**
   * The gap `unpricedTokens` structurally cannot express: unpriced tokens are
   * rows the database HAS, these are sessions it does not have at all. Their
   * spend is in no figure on the page, and the omission is one-directional -
   * totals missing sessions are always too small - so a silent page is a page
   * that under-reports spend while looking complete.
   */
  describe('ingest-coverage banner', () => {
    async function renderWithCoverage(coverage: CostSummaryDto['coverage']) {
      routeFetch({ summary: jsonResponse(200, { ...richSummary(), coverage }) });
      renderView();
      await screen.findByLabelText('totals');
    }

    it('names the excluded sessions and calls the totals a lower bound', async () => {
      await renderWithCoverage({ sessionsExcluded: 16, sessionsQuarantined: 16 });

      const banner = screen.getByTestId('coverage-banner');
      expect(banner.textContent).toContain('16 sessions could not be ingested');
      expect(banner.textContent).toContain('lower bound');
      expect(banner.textContent).toContain('16 of those will not be retried');
    });

    it('separates the still-retrying from the abandoned', async () => {
      // Excluded but not quarantined is a transient state the watcher intends
      // to fix by itself; telling the user it needs a pricing row would send
      // them chasing a problem that resolves on the next poll.
      await renderWithCoverage({ sessionsExcluded: 3, sessionsQuarantined: 0 });

      const banner = screen.getByTestId('coverage-banner');
      expect(banner.textContent).toContain('3 sessions could not be ingested');
      expect(banner.textContent).not.toContain('will not be retried');
    });

    it('reads correctly for a single session', async () => {
      await renderWithCoverage({ sessionsExcluded: 1, sessionsQuarantined: 1 });

      const banner = screen.getByTestId('coverage-banner');
      expect(banner.textContent).toContain(
        '1 session could not be ingested on the latest pass, so its spend',
      );
    });

    it('claims only what `sessionsExcluded` supports - a latest-pass failure', async () => {
      // The count is the watcher's retry-budget size: sessions whose LATEST
      // pass failed. One that ingested cleanly before and only failed on a
      // later append still has its earlier rows in these totals, so "their
      // spend is missing from every figure" would overstate the gap. The
      // lower-bound conclusion holds either way; that is what is asserted.
      await renderWithCoverage({ sessionsExcluded: 2, sessionsQuarantined: 0 });

      const banner = screen.getByTestId('coverage-banner');
      expect(banner.textContent).toContain('on the latest pass');
      expect(banner.textContent).toContain('incomplete or absent');
      expect(banner.textContent).not.toContain('missing from every figure');
    });

    it('stays silent on a measured zero', async () => {
      await renderWithCoverage({ sessionsExcluded: 0, sessionsQuarantined: 0 });

      expect(screen.queryByTestId('coverage-banner')).toBeNull();
    });

    it('stays silent when the server published no coverage claim', async () => {
      // Absent means "no ingest seam wired", not "nothing excluded". Rendering
      // a reassurance here would invent a completeness nobody measured.
      await renderWithCoverage(undefined);

      expect(screen.queryByTestId('coverage-banner')).toBeNull();
    });
  });
});
