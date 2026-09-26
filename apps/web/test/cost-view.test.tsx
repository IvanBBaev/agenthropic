/**
 * CostView (WP-U9): totals, sankey flow, per-model / per-day / top-session
 * tables. The suite pins the unpriced honesty: `unpricedTokens` appears as
 * its own KPI, as a `~ n` cell in every table and in node titles - never
 * hidden, never rendered as $0. fetch is mocked - no real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
// L-O1: the row marker reuses the shared gap vocabulary rather than a new glyph.
import { NO_FIGURE_META } from '../src/views/status';

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

/**
 * A summary with priced flow, a zero-cost model, and unpriced gaps.
 *
 * AMENDED 2026-09-09 (CV-5). `sessionCount` is now stated rather than left to
 * the fixture's default. The default would have made it 2 - the length of the
 * slice - and 2 sessions holding $1.05 of a $1.25 total is a payload no server
 * can produce, since `totals` and the per-session buckets are accumulated in
 * one loop. That inconsistency used to be invisible; with the scope paragraph
 * reading `hasMore` it would have turned the DEFAULT fixture of this suite
 * into a server-contradicts-itself case and put a discrepancy notice under
 * fifty unrelated tests. Seven sessions with five unlisted is what the dollars
 * here have always described.
 */
function richSummary() {
  return costSummary({
    sessionCount: 7,
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
    // AMENDED 2026-09-02 (F-6). The pinned copy was "No agent has recorded
    // token usage yet." - a flat global claim. It was persuasive because in
    // the untruncated case it is simply true, which is the case every test
    // and every small corpus exercises. It is false the moment the server
    // returns a recency slice, and the old markup dropped the truncation
    // banner in exactly that branch. The untruncated wording is kept (it is
    // the one this test covers) and now names its own scope; the truncated
    // branch has its own test below.
    routeFetch();
    renderView();
    await screen.findByText(/No agent has a recorded token count yet\./);
    expect(screen.getByTestId('burners-empty').textContent).toContain(
      'Usage unattributed to any persisted agent is outside this ranking',
    );
    expect(screen.queryByTestId('burners-truncation')).toBeNull();
    expect(screen.queryByRole('table', { name: 'top agents by token burn' })).toBeNull();
  });

  it('keeps saying it only saw a slice when nothing in that slice burned tokens', async () => {
    routeFetch({
      dag: jsonResponse(
        200,
        globalDag({
          nodes: [agentNode({ totalTokens: 0, costUsd: 0 })],
          counts: { totalAgents: 1500, returnedAgents: 1000, truncated: true },
        }),
      ),
    });
    renderView();

    // The banner is the whole point: without it the page would print a
    // confident statement about 1500 agents having read at most 1000.
    const banner = await screen.findByTestId('burners-truncation');
    expect(banner.textContent).toContain('1000 most recently active of 1500 agents');
    const empty = screen.getByTestId('burners-empty').textContent;
    expect(empty).toContain('No agent in the returned slice has a recorded token count.');
    expect(empty).toContain('not about the agents outside it');
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
    // F-1 (2026-09-01). Both figures above are real - the fixture's row for
    // 2026-08-16 was served before the boundary moved. What neither can be is
    // COMPLETE: the snapshot was read on 2026-08-15, so nothing recorded since
    // is in them. Asserted here because this test constructs the exact case the
    // rest of the F-1 work does not cover - a non-empty bucket under a stale
    // read - and an undisclosed lower bound is still a number overstating
    // itself, just by less than the structural zero next door.
    expect(screen.getByTestId('kpi-today-partial').textContent).toContain('read on 2026-08-15');
    expect(screen.getByTestId('kpi-week-partial').textContent).toContain('a lower bound');
    expect(screen.queryByTestId('kpi-today-unread')).toBeNull();
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

  describe('figures the page refuses to draw as if they were ordinary', () => {
    it('names a model cost no ribbon can carry instead of dropping it from the page', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 3000, costUsd: 0.7, unpricedTokens: 0 },
            perModel: [
              { model: 'claude-a', tokens: 2000, costUsd: 1, unpricedTokens: 0 },
              { model: 'claude-refund', tokens: 1000, costUsd: -0.3, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      renderView();

      const notice = await screen.findByTestId('flow-undrawable');
      expect(notice.textContent).toContain('model claude-refund $-0.30');
      expect(notice.textContent).toContain('exactly as it arrived');
      // Not smuggled into the "usage but $0 priced" list either - that list
      // means something different and would understate this one.
      expect(screen.queryByTestId('zero-cost-models')).toBeNull();
    });

    it('stays silent about undrawable costs when every served figure is drawable', async () => {
      routeFetch();
      renderView();
      await screen.findByRole('img', { name: 'cost flow from models to sessions' });

      expect(screen.queryByTestId('flow-undrawable')).toBeNull();
      expect(screen.queryByTestId('flow-balance')).toBeNull();
    });

    it('warns that the diagram does not account for itself when the two served sides disagree', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 9000, costUsd: 40, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 9000, costUsd: 12, unpricedTokens: 0 }],
          }),
        ),
      });
      renderView();

      const banner = await screen.findByTestId('flow-balance');
      expect(banner.textContent).toContain('does not account for itself');
      expect(banner.textContent).toContain('per-model rows sum to $12.00');
      expect(banner.textContent).toContain('served total is $40.00');
      expect(banner.textContent).toContain('differ by $-28.00');
    });

    it('says the drawn sessions overshoot the total rather than hiding a negative remainder', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 3000, costUsd: 1, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1, unpricedTokens: 0 }],
            topSessions: [
              { sessionId: 's1', projectSlug: 'p', tokens: 2000, costUsd: 3, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      renderView();

      const banner = await screen.findByTestId('flow-balance');
      expect(banner.textContent).toContain('top sessions alone sum to $3.00');
      expect(banner.textContent).toContain('$2.00 excess cannot be drawn as a remainder');
      expect(banner.textContent).toContain('not a subset of that total');
    });

    it('refuses to reconcile against a total that is not a readable amount', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 3000, costUsd: Number.NaN, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1, unpricedTokens: 0 }],
          }),
        ),
      });
      renderView();

      const banner = await screen.findByTestId('flow-balance');
      expect(banner.textContent).toContain('not a readable amount');
      expect(banner.textContent).not.toContain('per-model rows sum to');
      expect(banner.textContent).not.toContain('top sessions alone');
    });

    it('marks a day whose cost no bar can express instead of drawing it as quiet', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 3000, costUsd: 0.5, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 0.5, unpricedTokens: 0 }],
            perDay: [
              { day: '2026-07-28', tokens: 2000, costUsd: 1, unpricedTokens: 0 },
              { day: '2026-07-27', tokens: 500, costUsd: -0.5, unpricedTokens: 0 },
              { day: '2026-07-26', tokens: 500, costUsd: Number.NaN, unpricedTokens: 0 },
              { day: '2026-07-25', tokens: 0, costUsd: 0, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      const { container } = renderView();

      const notice = await screen.findByTestId('perday-undrawable');
      expect(notice.textContent).toContain('2026-07-27 ($-0.50)');
      expect(notice.textContent).toContain('2026-07-26 (cost unreadable)');
      // A genuine $0.00 day is NOT a fault and must not be named here.
      expect(notice.textContent).not.toContain('2026-07-25');

      const table = screen.getByRole('table', { name: 'cost per day' });
      const cells = [...table.querySelectorAll('tbody .bar-cell')];
      expect(cells[0]?.querySelector('.bar-fill')).not.toBeNull();
      // The two faults carry a marker; the quiet day keeps its zero-width bar,
      // so "no bar" can no longer mean two different things in one column.
      expect(cells[1]?.querySelector('.status-error')).not.toBeNull();
      expect(cells[2]?.querySelector('.status-error')).not.toBeNull();
      expect((cells[3]?.querySelector('.bar-fill') as HTMLElement | null)?.style.width).toBe('0%');
      expect(container.querySelectorAll('.bar-fill')).toHaveLength(2);
    });

    it('keeps every other bar readable when one day carries an unreadable cost', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 3000, costUsd: 1, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1, unpricedTokens: 0 }],
            perDay: [
              { day: '2026-07-28', tokens: 2000, costUsd: 1, unpricedTokens: 0 },
              { day: '2026-07-27', tokens: 500, costUsd: Number.NaN, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByRole('table', { name: 'cost per day' });

      // One unreadable row used to poison Math.max and flatten the whole
      // column to 0% - erasing the information in every OTHER day's bar.
      const bar = document.querySelector('tbody .bar-cell .bar-fill') as HTMLElement | null;
      expect(bar?.style.width).toBe('100%');
    });

    it('draws every bar at zero width when no day carries a positive cost', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 500, costUsd: 0, unpricedTokens: 500 },
            perDay: [{ day: '2026-07-28', tokens: 500, costUsd: 0, unpricedTokens: 500 }],
          }),
        ),
      });
      renderView();
      await screen.findByRole('table', { name: 'cost per day' });

      const bar = document.querySelector('tbody .bar-cell .bar-fill') as HTMLElement | null;
      expect(bar?.style.width).toBe('0%');
      expect(screen.queryByTestId('perday-undrawable')).toBeNull();
    });

    it('names a skip reason this build does not recognise rather than leaving the cell blank', async () => {
      routeFetch({
        savings: jsonResponse(
          200,
          aggregateSavings({
            skippedSessionCount: 1,
            skippedSessions: [
              {
                sessionId: 'cccccccc-9999-0000-1111-222222222222',
                // A word a newer server can send to an older bundle: the
                // compile-time exhaustiveness check cannot reach it.
                reason: 'transcript-missing' as 'unpriceable',
                detail: 'no transcript on disk',
              },
            ],
          }),
        ),
      });
      renderView();

      const table = await screen.findByRole('table', {
        name: 'sessions excluded from the delegation estimate',
      });
      const reasonCell = table.querySelectorAll('tbody td')[1];
      // AMENDED 2026-09-23 (lane-P). RE-AIMED: the cell still names the raw
      // reason rather than leaving itself blank - the point of this test - and
      // the word is now quoted so that a reason of `''` cannot render as a
      // sentence stopped at its colon.
      expect(reasonCell?.textContent).toBe('unrecognised reason: "transcript-missing"');
      expect(reasonCell?.textContent).toContain('transcript-missing');
    });

    it('still prints the wording for a reason this build does know', async () => {
      routeFetch({
        savings: jsonResponse(
          200,
          aggregateSavings({
            skippedSessionCount: 1,
            skippedSessions: [
              {
                sessionId: 'dddddddd-9999-0000-1111-222222222222',
                reason: 'undated-usage',
                detail: 'usage row without a day',
              },
            ],
          }),
        ),
      });
      renderView();

      const table = await screen.findByRole('table', {
        name: 'sessions excluded from the delegation estimate',
      });
      const reasonCell = table.querySelectorAll('tbody td')[1];
      expect(reasonCell?.textContent).toBe('Usage row carries no date');
    });
  });

  /**
   * F-18. The two honesty notices above the sankey are ordinary prose, so a
   * reader travelling down the page meets them before the picture. A reader
   * who reaches the picture AS a picture - jumped to by image, or handed
   * `role="img"` plus its description and none of its subtree - met only the
   * confident flow summary. The description list is what closes that gap.
   */
  describe('what the sankey tells a reader who only gets its description (F-18)', () => {
    /** The ids named by the diagram, in the order it names them. */
    async function describedByOfFlow(): Promise<string[]> {
      const svg = await screen.findByRole('img', { name: 'cost flow from models to sessions' });
      return (svg.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    }

    it('names only the summary when there is no caveat to carry', async () => {
      routeFetch();

      renderView();

      expect(await describedByOfFlow()).toEqual(['cost-flow-summary']);
    });

    it('names the reconciliation warning ahead of the summary when the sides disagree', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 9000, costUsd: 40, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 9000, costUsd: 12, unpricedTokens: 0 }],
          }),
        ),
      });

      renderView();

      // Ahead of it, because a description that opens with a confident flow
      // and only later admits it does not add up is read in that order too.
      expect(await describedByOfFlow()).toEqual(['cost-flow-balance', 'cost-flow-summary']);
      expect(screen.getByTestId('flow-balance').id).toBe('cost-flow-balance');
    });

    it('names the undrawable-cost notice when a served cost is missing from the picture', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 3000, costUsd: 0.7, unpricedTokens: 0 },
            perModel: [
              { model: 'claude-a', tokens: 2000, costUsd: 1, unpricedTokens: 0 },
              { model: 'claude-refund', tokens: 1000, costUsd: -0.3, unpricedTokens: 0 },
            ],
          }),
        ),
      });

      renderView();

      expect(await describedByOfFlow()).toEqual(['cost-flow-undrawable', 'cost-flow-summary']);
      expect(screen.getByTestId('flow-undrawable').id).toBe('cost-flow-undrawable');
    });

    it('names both caveats when both apply, and every id resolves to real text', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 9000, costUsd: 40, unpricedTokens: 0 },
            perModel: [
              { model: 'claude-a', tokens: 8000, costUsd: 12, unpricedTokens: 0 },
              { model: 'claude-refund', tokens: 1000, costUsd: -0.3, unpricedTokens: 0 },
            ],
          }),
        ),
      });

      renderView();

      const ids = await describedByOfFlow();
      expect(ids).toEqual(['cost-flow-balance', 'cost-flow-undrawable', 'cost-flow-summary']);
      // A dangling id is worse than no id: assistive tech drops it silently,
      // which is exactly the failure mode this fix exists to remove.
      for (const id of ids) {
        expect(document.getElementById(id)?.textContent ?? '').not.toBe('');
      }
    });
  });

  /**
   * CA-5 / CA-6 (2026-09-03), from the cost-analysis red-team pass. Both
   * modules learned to SEPARATE a fact they had been folding away; these tests
   * pin the half that matters to a reader, which is that the separated fact
   * reaches the page. A disclosure computed and never rendered is the same
   * silence it was written to break.
   */
  describe('facts the windows and the ranking used to fold away', () => {
    it('says so when spend is dated after the clock reading this page (CA-5)', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 15, 12, 0, 0));
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 3500, costUsd: 0.35, unpricedTokens: 0 },
            perDay: [
              { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
              // Later than the clock this browser is reading the page with.
              // Excluding it from both windows is right; saying nothing is not.
              { day: '2026-08-16', tokens: 2500, costUsd: 0.25, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByLabelText('recent windows');

      const basis = screen.getByTestId('windows-basis').textContent;
      expect(basis).toContain('$0.25 across 2,500 tokens is dated after 2026-08-15');
      expect(basis).toContain('disagree about what day it is');
      // And the excluded spend stayed excluded - the notice is a disclosure,
      // not a repair. Today is the single 2026-08-15 row and nothing else.
      expect(screen.getByTestId('kpi-today').textContent).toContain('$0.10');
      expect(screen.getByTestId('kpi-week').textContent).toContain('$0.10');
    });

    it('counts an unreadable token figure apart from a measured zero (CA-6)', async () => {
      routeFetch({
        dag: jsonResponse(
          200,
          globalDag({
            nodes: [
              agentNode({ id: 'agent-real', totalTokens: 900 }),
              agentNode({ id: 'agent-idle', totalTokens: 0, costUsd: 0 }),
              agentNode({ id: 'agent-unreadable', totalTokens: Number.NaN }),
            ],
          }),
        ),
      });
      renderView();
      await screen.findByRole('table', { name: 'top agents by token burn' });

      const scope = screen.getByTestId('burners-scope').textContent;
      expect(scope).toContain('Not ranked: 1 agent with zero recorded tokens.');
      // Two sentences, not one sum. An agent whose burn we cannot read has not
      // been shown to be idle, and the reader must be able to tell which is which.
      expect(scope).toContain('Not ranked: 1 agent whose recorded token count could not be read');
      expect(scope).toContain('a gap in our figure, not a measured zero');
    });

    it('pluralises the unreadable count on its own, not off the zero count (CA-6)', async () => {
      routeFetch({
        dag: jsonResponse(
          200,
          globalDag({
            nodes: [
              agentNode({ id: 'agent-real', totalTokens: 900 }),
              agentNode({ id: 'agent-nan', totalTokens: Number.NaN }),
              // Negative is unreadable for the same reason NaN is: a token
              // count below zero is not a smaller burn, it is a broken figure.
              agentNode({ id: 'agent-negative', totalTokens: -5 }),
            ],
          }),
        ),
      });
      renderView();
      await screen.findByRole('table', { name: 'top agents by token burn' });

      const scope = screen.getByTestId('burners-scope').textContent;
      expect(scope).toContain('Not ranked: 2 agents whose recorded token count could not be read');
      expect(scope).not.toContain('with zero recorded tokens');
    });
  });

  /**
   * CV-2 .. CV-5 (2026-09-08), from the cost-view red-team pass. Every test
   * here is the same shape: the view HELD the qualification that makes a
   * printed figure true and published the figure without it. They fail
   * against the previous CostView - the hub hovered a bare number chosen by
   * d3-sankey, the node hover dropped an unreadable unpriced count, the Total
   * cost tile presented itself as complete, and the top-sessions table did
   * not say it was a slice.
   */
  describe('qualifications the page used to keep to itself', () => {
    /** Hover text of the sankey's NODES - link titles live on <path>. */
    async function nodeTitles(container: HTMLElement): Promise<string[]> {
      await screen.findByRole('img', { name: 'cost flow from models to sessions' });
      return [...container.querySelectorAll('g title')].map((title) => title.textContent ?? '');
    }

    /** A summary whose hub takes $12.00 in and pays $40.00 out. */
    function lopsidedHub() {
      return costSummary({
        totals: { tokens: 9000, costUsd: 40, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 9000, costUsd: 12, unpricedTokens: 0 }],
      });
    }

    /** A summary whose unpriced-token count arrives unreadable. */
    function unreadableUnpriced() {
      return costSummary({
        totals: { tokens: 4000, costUsd: 1, unpricedTokens: Number.NaN },
        perModel: [{ model: 'claude-a', tokens: 4000, costUsd: 1, unpricedTokens: 0 }],
      });
    }

    function sessionRow(index: number, costUsd: number) {
      return {
        sessionId: `s${String(index)}`,
        projectSlug: 'agenthropic',
        tokens: 1000,
        costUsd,
        unpricedTokens: 0,
      };
    }

    it("states both of the hub's drawn sides instead of hovering the larger one alone (CV-2)", async () => {
      routeFetch({ summary: jsonResponse(200, lopsidedHub()) });
      const { container } = renderView();

      // AMENDED 2026-09-09 (CF-2). The label was `drawn cost`; a hub whose two
      // sides disagree is now called `larger drawn side`, because that is what
      // the printed figure is. CV-2's claim is untouched - the number still
      // arrives with both sides and the gap, since a label can name a figure
      // but cannot quantify the disagreement behind it.
      const hub = (await nodeTitles(container)).find((title) =>
        title.includes('larger drawn side'),
      );
      // The figure itself is unchanged - it is what the picture is drawn from.
      expect(hub).toContain('larger drawn side: $40.00');
      // What it now arrives with: the two sides it was chosen between.
      expect(hub).toContain('ribbons carrying $12.00 enter it');
      expect(hub).toContain('ribbons carrying $40.00 leave');
      expect(hub).toContain('a gap of $28.00');
      expect(hub).toContain('the larger of those two sides');
    });

    it('will not let a hub hover a figure the totals contradict (CV-2, CF-2)', async () => {
      // AMENDED 2026-09-09 (CF-2). The title said 'a hub labelled "all cost"',
      // and that was this fixture's whole point: the layout called it whole
      // because the ENTERING side ($1.00) matched the served total while the
      // leaving side ($3.00) - the side d3-sankey prints - was never part of
      // the test. That is the defect CF-2 closed at the source, so the premise
      // no longer exists to be tested: the label is now `larger drawn side`.
      // The test is kept and re-aimed rather than deleted, because the
      // GUARANTEE it pins is the durable one and is what a reader of this file
      // needs pinned - a hover figure the Total cost tile contradicts never
      // stands unqualified, whatever the label above it says.
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 3000, costUsd: 1, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 1, unpricedTokens: 0 }],
            topSessions: [
              { sessionId: 's1', projectSlug: 'p', tokens: 2000, costUsd: 3, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      const { container } = renderView();

      const titles = await nodeTitles(container);
      // The label no longer claims a whole, and no node on the page does.
      expect(titles.find((title) => title.includes('all cost'))).toBeUndefined();
      const hub = titles.find((title) => title.includes('larger drawn side'));
      expect(hub).toContain('larger drawn side: $3.00');
      expect(hub).toContain('ribbons carrying $1.00 enter it');
      expect(hub).toContain('ribbons carrying $3.00 leave');
      // The tile a reader takes the bottom line from still says $1.00. The
      // hover no longer offers $3.00 as if it were the same quantity.
      expect(screen.getByLabelText('totals').textContent).toContain('$1.00');
    });

    it('publishes the hub gap as prose, not only as hover text (CV-2)', async () => {
      routeFetch({ summary: jsonResponse(200, lopsidedHub()) });
      renderView();
      await screen.findByRole('img', { name: 'cost flow from models to sessions' });

      // role="img" hides <title> from assistive tech, so the caveat has to be
      // in the description the diagram already names (F-18), not only in the
      // subtree a pointer can reach.
      const prose = document.getElementById('cost-flow-summary')?.textContent ?? '';
      expect(prose).toContain("The hub's two sides do not match");
      expect(prose).toContain('ribbons carrying $12.00 enter it');
      expect(prose).toContain('a gap of $28.00');
    });

    it('says nothing about the hub when its two drawn sides agree (CV-2)', async () => {
      routeFetch();
      const { container } = renderView();

      const hub = (await nodeTitles(container)).find((title) => title.includes('all cost'));
      // Exactly the old string: a balanced hub gains no new words at all.
      expect(hub).toBe('all cost: $1.25 (+ ~4,000 unpriced tokens)');
      expect(document.getElementById('cost-flow-summary')?.textContent ?? '').not.toContain(
        'two sides do not match',
      );
    });

    it('marks an unreadable unpriced count on a node instead of hovering as if priced (CV-3)', async () => {
      routeFetch({ summary: jsonResponse(200, unreadableUnpriced()) });
      const { container } = renderView();

      const titles = await nodeTitles(container);
      expect(titles.find((title) => title.includes('all cost'))).toBe(
        'all cost: $1.00 (+ unpriced: tokens unreadable)',
      );
      // A node whose zero WAS measured still says nothing extra - the marker
      // means "unknown", and spending it on a known zero would blunt it.
      expect(titles).toContain('claude-a: $1.00');
    });

    it('names a negative node count on hover instead of hovering as if priced (KK6)', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 4000, costUsd: 1, unpricedTokens: -50 },
            perModel: [{ model: 'claude-a', tokens: 4000, costUsd: 1, unpricedTokens: -50 }],
          }),
        ),
      });
      const { container } = renderView();

      const titles = await nodeTitles(container);
      expect(titles).toContain('claude-a: $1.00 (+ unpriced: -50, a count that cannot be right)');
      expect(titles).toContain('all cost: $1.00 (+ unpriced: -50, a count that cannot be right)');
    });

    it('hovers +100 and -100 on their own nodes rather than letting them cancel (KK6)', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 4000, costUsd: 1, unpricedTokens: 0 },
            perModel: [
              { model: 'claude-a', tokens: 2000, costUsd: 0.5, unpricedTokens: 100 },
              { model: 'claude-b', tokens: 2000, costUsd: 0.5, unpricedTokens: -100 },
              { model: 'claude-c', tokens: 2000, costUsd: 0.25, unpricedTokens: Infinity },
            ],
          }),
        ),
      });
      const { container } = renderView();

      const titles = await nodeTitles(container);
      expect(titles).toContain('claude-a: $0.50 (+ ~100 unpriced tokens)');
      expect(titles).toContain('claude-b: $0.50 (+ unpriced: -100, a count that cannot be right)');
      expect(titles).toContain('claude-c: $0.25 (+ unpriced: tokens unreadable)');
    });

    it('refuses to present the total as complete when the unpriced count is unreadable (CV-4)', async () => {
      routeFetch({ summary: jsonResponse(200, unreadableUnpriced()) });
      renderView();
      await screen.findByLabelText('totals');

      expect(screen.getByTestId('kpi-total-unpriced-unknown').textContent).toContain(
        'what this leaves out is unknown',
      );
      // Not the confident copy: "priced tokens only" is a claim about a gap
      // this payload did not let us read.
      expect(screen.queryByText('priced tokens only')).toBeNull();
      // The measured total is still printed - it is a real sum of real rows.
      expect(screen.getByLabelText('totals').textContent).toContain('$1.00');
    });

    it('keeps the plain "priced tokens only" note when the gap is readable (CV-4)', async () => {
      routeFetch();
      renderView();
      await screen.findByLabelText('totals');

      expect(screen.getByText('priced tokens only')).toBeDefined();
      expect(screen.queryByTestId('kpi-total-unpriced-unknown')).toBeNull();
    });

    it('names the top-sessions table as a slice and prices what it leaves out (CV-5)', async () => {
      // AMENDED 2026-09-09 (CV-5). The premise this test was written on - that
      // the payload could not say how many sessions the corpus holds - is gone:
      // `sessionCount` carries the population and `hasMore` says the table is
      // cut from it. The durable guarantee is unchanged and is what the
      // assertions now pin: a truncated table names its own scope and prices
      // what it leaves out. The hedge it used to accept ("a slice unless the
      // corpus holds exactly that many") is now a wrong answer, and the
      // remainder is attributed to a COUNTED set of unlisted sessions.
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 20000, costUsd: 10, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 20000, costUsd: 10, unpricedTokens: 0 }],
            sessionCount: 51,
            topSessions: [
              sessionRow(1, 2),
              sessionRow(2, 1.5),
              sessionRow(3, 1),
              sessionRow(4, 0.75),
              sessionRow(5, 0.75),
            ],
          }),
        ),
      });
      renderView();

      const scope = (await screen.findByTestId('top-sessions-scope')).textContent ?? '';
      expect(scope).toContain('The 5 costliest of 51 sessions with recorded usage.');
      expect(scope).toContain('The rows account for $6.00 of the $10.00 all-time total.');
      expect(scope).toContain(
        'The other $4.00 was spent in the 46 sessions this table does not list.',
      );
      // The hedge is gone, not softened.
      expect(scope).not.toContain('unless the corpus holds exactly that many');
      expect(scope).not.toContain('nothing in this payload says which');
    });

    it('claims no unlisted spend when the shown rows account for the whole total (CV-5)', async () => {
      // AMENDED 2026-09-09 (CV-5). Same case, now with the population stated:
      // five rows of fifty-one sessions that happen to hold every priced
      // dollar. The scope is asserted rather than hedged; the remainder
      // sentence still stays away, because no remainder exists to describe.
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 20000, costUsd: 10, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 20000, costUsd: 10, unpricedTokens: 0 }],
            sessionCount: 51,
            topSessions: [
              sessionRow(1, 2),
              sessionRow(2, 2),
              sessionRow(3, 2),
              sessionRow(4, 2),
              sessionRow(5, 2),
            ],
          }),
        ),
      });
      renderView();

      const scope = (await screen.findByTestId('top-sessions-scope')).textContent ?? '';
      expect(scope).toContain('The 5 costliest of 51 sessions with recorded usage.');
      expect(scope).toContain('The rows account for $10.00 of the $10.00 all-time total.');
      expect(scope).not.toContain('does not list');
      expect(scope).not.toContain('unaccounted for');
    });

    it('stays silent about the slice when the server returned fewer than it asked for (CV-5)', async () => {
      // AMENDED 2026-09-09 (CV-5). The name records what this test used to
      // demand, and the demand was wrong once the payload could tell a short
      // table from a complete one. Silence was the honest option only while
      // "two rows" and "two sessions" were indistinguishable; with
      // `sessionCount` the view knows which, so a two-row table out of seven
      // sessions states its scope exactly like a five-row one does. The
      // durable guarantee - never claim a scope the payload does not support -
      // is what the assertions still pin.
      routeFetch();
      renderView();
      await screen.findByRole('table', { name: 'top sessions by cost' });

      const scope = screen.getByTestId('top-sessions-scope').textContent ?? '';
      expect(scope).toContain('The 2 costliest of 7 sessions with recorded usage.');
      expect(scope).toContain('The rows account for $1.05 of the $1.25 all-time total.');
      expect(scope).toContain(
        'The other $0.20 was spent in the 5 sessions this table does not list.',
      );
    });

    it('states that the table is whole when the payload says nothing is missing (CV-5)', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 12000, costUsd: 6, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 12000, costUsd: 6, unpricedTokens: 0 }],
            // Three rows, three sessions: `hasMore` is false, so this table is
            // the corpus and the view may say so outright.
            topSessions: [sessionRow(1, 3), sessionRow(2, 2), sessionRow(3, 1)],
          }),
        ),
      });
      renderView();

      const scope = (await screen.findByTestId('top-sessions-scope')).textContent ?? '';
      expect(scope).toBe(
        'Every session with recorded usage is listed here - all 3 sessions. The rows account for $6.00 of the $6.00 all-time total.',
      );
    });

    it('reports a discrepancy rather than inventing unlisted sessions to hold it (CV-5)', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 12000, costUsd: 1.5, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 12000, costUsd: 1.5, unpricedTokens: 0 }],
            // Two rows, two sessions ($1.00), a $1.50 total: the payload says
            // every session is listed AND that half a dollar was spent
            // somewhere else. A server accumulating both in one row loop cannot
            // send this, so the page must not narrate it as ordinary.
            topSessions: [sessionRow(1, 0.6), sessionRow(2, 0.4)],
          }),
        ),
      });
      renderView();

      const scope = (await screen.findByTestId('top-sessions-scope')).textContent ?? '';
      expect(scope).toContain('Every session with recorded usage is listed here - all 2 sessions.');
      expect(scope).toContain('The rows account for $1.00 of the $1.50 all-time total.');
      expect(scope).toContain(
        'The remaining $0.50 is unaccounted for: this payload lists every session with recorded usage, so there is no unlisted session to attribute it to - the served total and the served rows disagree.',
      );
      // The money is NOT handed to sessions the payload denies exist.
      expect(scope).not.toContain('does not list');
    });

    it('keeps "No sessions recorded yet." for a corpus that really is empty (CV-5)', async () => {
      routeFetch({ summary: jsonResponse(200, costSummary()) });
      renderView();
      await screen.findByLabelText('totals');

      expect(screen.getByTestId('top-sessions-empty').textContent).toBe(
        'No sessions recorded yet.',
      );
      // Nothing to scope: a population of zero has no slice to describe.
      expect(screen.queryByTestId('top-sessions-scope')).toBeNull();
    });

    it('does not call a corpus empty when the rows are the missing part (CV-5)', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 8000, costUsd: 2, unpricedTokens: 0 },
            perModel: [{ model: 'claude-a', tokens: 8000, costUsd: 2, unpricedTokens: 0 }],
            // Four sessions counted, none served: the table is empty for a
            // reason that has nothing to do with an empty database.
            sessionCount: 4,
            topSessions: [],
          }),
        ),
      });
      renderView();

      expect((await screen.findByTestId('top-sessions-empty')).textContent).toBe(
        'No session rows were served for this table.',
      );
      expect(screen.queryByText('No sessions recorded yet.')).toBeNull();
      const scope = screen.getByTestId('top-sessions-scope').textContent ?? '';
      expect(scope).toContain('None of the 4 sessions with recorded usage reached this table.');
      expect(scope).toContain('The rows account for $0.00 of the $2.00 all-time total.');
      expect(scope).toContain(
        'The other $2.00 was spent in the 4 sessions this table does not list.',
      );
    });

    /*
      The three cases below are all payloads a consistent server cannot send:
      `sessionCount` is the count of sessions carrying any priced or unpriced
      usage, so nought sessions and non-zero totals cannot both be true. The
      client cannot know the server is consistent, and until this pass it
      answered the contradiction by printing one half of it - "No sessions
      recorded yet." underneath KPIs that were rendering the other half. Three
      separate tests because three separate fields can carry the usage, and a
      guard that only asks about dollars would keep silent for a corpus whose
      whole cost is unpriced - the case this project cares most about getting
      right.
    */
    it('refuses to call the corpus empty while the totals report tokens (CV-5)', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({ totals: { tokens: 8000, costUsd: 2, unpricedTokens: 0 } }),
        ),
      });
      renderView();

      expect((await screen.findByTestId('top-sessions-empty')).textContent).toBe(
        'No session carries recorded usage, yet the totals above report 8,000 tokens and $2.00: the served totals and the served session count disagree.',
      );
      expect(screen.queryByText('No sessions recorded yet.')).toBeNull();
      // Still nothing to scope: the disagreement is about the totals, and a
      // population of nought has no slice to describe either way.
      expect(screen.queryByTestId('top-sessions-scope')).toBeNull();
    });

    it('refuses to call the corpus empty when the usage is entirely unpriced (CV-5)', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({ totals: { tokens: 0, costUsd: 0, unpricedTokens: 4000 } }),
        ),
      });
      renderView();

      // Both figures are quoted even though both read as nothing: the sentence
      // says what was SERVED, and a reader who cannot see the unpriced count
      // here can see it in the KPIs above.
      expect((await screen.findByTestId('top-sessions-empty')).textContent).toBe(
        'No session carries recorded usage, yet the totals above report 0 tokens and $0.00: the served totals and the served session count disagree.',
      );
    });

    it('refuses to call the corpus empty while the totals report spend (CV-5)', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({ totals: { tokens: 0, costUsd: 0.5, unpricedTokens: 0 } }),
        ),
      });
      renderView();

      expect((await screen.findByTestId('top-sessions-empty')).textContent).toBe(
        'No session carries recorded usage, yet the totals above report 0 tokens and $0.50: the served totals and the served session count disagree.',
      );
    });
  });

  /**
   * A1 (2026-09-23), from the Lane A behavioural audit. The window tiles and
   * the basis paragraph each carried a disclosure behind a `> 0` test, and
   * `computeCostWindows` sums `perDay` with plain `+` - so ONE row whose
   * count arrived non-finite (shape is all `dto-guards.ts` promises) makes the
   * bucket NaN, the test silently false, and the sentence vanish. Every test
   * below renders a figure whose gap the page used to keep to itself, and
   * asserts the page now says it out loud.
   *
   * AMENDED 2026-09-23 (lane-M). The defeating inputs below are unchanged and
   * still defeating; what they produce is not. A1 caught the disclosures going
   * quiet and rebuilt each one around the NaN that silenced it - which pinned
   * the SYMPTOM, a poisoned total, as if it were the guarantee. M1 removed the
   * poisoning instead: the sums skip the figures they cannot read and count the
   * rows they came from, so a single bad row no longer erases a whole window
   * and no total can arrive non-finite. The old assertions therefore pinned
   * copy that can never be reached again, and an unreachable branch is a
   * coverage failure as well as a lie about what the page does.
   *
   * So each test keeps its input and is re-aimed at the durable guarantee: a
   * window that could not read every row it was handed says so, on the tile,
   * beside the figure. That is strictly more than A1 asked for - the note now
   * qualifies the dollar value and the token count too, not only the unpriced
   * line - and it is the same doctrine underneath: the number and the statement
   * of what it omits travel together.
   */
  describe('window disclosures that a NaN row used to switch off (A1)', () => {
    it('says the unpriced count is unreadable instead of dropping the note', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 15, 12, 0, 0));
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
            perDay: [
              // Inside both windows, and its unpriced count is not a number.
              { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: Number.NaN },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByLabelText('recent windows');

      const today = screen.getByTestId('kpi-today');
      // The dollar figure stays - it is real. What changes is that it no
      // longer stands alone, which on this board reads as "fully priced".
      expect(today.textContent).toContain('$0.10');
      expect(screen.getByTestId('kpi-today-coverage').textContent).toContain(
        '1 day of 1 in this window could not be read',
      );
      expect(screen.getByTestId('kpi-week-coverage').textContent).toContain(
        'every figure on this tile is a lower bound',
      );
      // And no `~ n unpriced` marker anywhere: the count was never read, so
      // quoting one would be inventing it.
      expect(today.textContent).not.toContain('~');
      expect(screen.getByTestId('kpi-week').textContent).not.toContain('~');
    });

    it('keeps the unpriced gap visible on a window that is also stale (F-1)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 7, 15, 23, 59, 50));
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 7000, costUsd: 0.7, unpricedTokens: 0 },
            perDay: [
              // Dated a day ahead of the read, so after the rollover it is the
              // whole of "today" - a non-empty bucket under a stale snapshot,
              // which is the one arm the note did not reach.
              { day: '2026-08-16', tokens: 7000, costUsd: 0.7, unpricedTokens: Number.NaN },
            ],
          }),
        ),
      });
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
      });

      // Two different gaps, and the reader is owed both: the staleness note is
      // about time, the unpriced note is about coverage.
      expect(screen.getByTestId('kpi-today-partial').textContent).toContain('read on 2026-08-15');
      expect(screen.getByTestId('kpi-today-partial-coverage').textContent).toContain(
        '1 day of 1 in this window could not be read',
      );
    });

    it('says so when the undated bucket itself cannot be read', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 15, 12, 0, 0));
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
            perDay: [
              { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
              { day: 'unknown', tokens: Number.NaN, costUsd: 0, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByLabelText('recent windows');

      const basis = screen.getByTestId('windows-basis').textContent;
      // The sentence appears at all - which is the A1 guarantee - and the zero
      // in it is qualified rather than quoted as a measurement, which is the
      // M1 one. Silence here would assert that every recorded token fell
      // inside a window, and a bare "0 tokens" would assert that nothing was
      // lost; the row count says the rows exist and could not be added.
      expect(basis).toContain('tokens carry no timestamp and sit outside every window');
      expect(basis).toContain('1 row of those could not be read, so that count is a lower bound.');
    });

    it('says so when the future-dated bucket itself cannot be read (CA-5)', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 15, 12, 0, 0));
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 1000, costUsd: 0.35, unpricedTokens: 0 },
            perDay: [
              { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
              { day: '2026-08-16', tokens: Number.NaN, costUsd: 0.25, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByLabelText('recent windows');

      const basis = screen.getByTestId('windows-basis').textContent;
      // The readable half of the row survives the unreadable half: $0.25 is
      // still quoted, where the old sum turned the pair into NaN and the copy
      // could only say that everything about the bucket was unknown.
      expect(basis).toContain('$0.25 across 0 tokens is dated after 2026-08-15');
      expect(basis).toContain('disagree about what day it is');
      expect(basis).toContain('1 row of those could not be read, so that figure is a lower bound.');
    });
  });

  /**
   * M1 (2026-09-23, lane-M) at the page. `computeCostWindows` now files a row
   * whose `day` is not a UTC date into a bucket of its own instead of letting
   * string ordering scatter it; these two tests are the reason that matters -
   * they are what the reader sees. Both inputs are rows the page previously
   * held and did not mention.
   */
  describe('rows the windows could not read (M1)', () => {
    it('names the spend whose day it cannot read instead of dropping it', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 15, 12, 0, 0));
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 1500, costUsd: 0.15, unpricedTokens: 40 },
            perDay: [
              { day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
              // The defeating row: sorts below every boundary, so it used to
              // land in no bucket and no sentence - 500 tokens and $0.05 gone
              // from a page still showing four totals that look complete.
              { day: '', tokens: 500, costUsd: 0.05, unpricedTokens: 40 },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByLabelText('recent windows');

      const basis = screen.getByTestId('windows-basis').textContent;
      expect(basis).toContain('1 row carries a date this page cannot read');
      expect(basis).toContain('$0.05 across 500 tokens sits in no window at all');
      // And it is NOT reported as clock skew: that sentence is about dates
      // later than this machine's, and an unreadable string is not a date.
      expect(basis).not.toContain('disagree about what day it is');
    });

    it('refuses to read an unpadded past date as a disagreement about the calendar', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 15, 12, 0, 0));
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 900, costUsd: 0.1, unpricedTokens: 0 },
            // '2026-8-5' > '2026-08-15' as a string, which is how a date ten
            // days in the PAST had the page announcing clock skew. The second
            // row is there for the plural arm of the sentence: a caveat with a
            // count and the wrong verb reads as a template nobody checked.
            perDay: [
              { day: '2026-8-5', tokens: 700, costUsd: 0.07, unpricedTokens: 0 },
              { day: 'day one', tokens: 200, costUsd: 0.03, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByLabelText('recent windows');

      const basis = screen.getByTestId('windows-basis').textContent;
      expect(basis).not.toContain('disagree about what day it is');
      expect(basis).toContain('2 rows carry a date this page cannot read');
      expect(basis).toContain('$0.10 across 900 tokens sits in no window at all');
    });

    it('will not call today empty over a row it is holding but could not read', async () => {
      // The stale-snapshot arm, where the page's strongest window claim lives:
      // "no usage was dated today". Every figure on this row is unreadable, so
      // the today bucket sums to zero exactly as an idle day does - and the
      // page must not mistake the one for the other. It was measured; it could
      // not be read; those are different sentences.
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 7, 15, 23, 59, 50));
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 0, costUsd: 0, unpricedTokens: 0 },
            perDay: [
              {
                day: '2026-08-16',
                tokens: Number.NaN,
                costUsd: Number.NaN,
                unpricedTokens: Number.NaN,
              },
            ],
          }),
        ),
      });
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
      });

      expect(screen.queryByTestId('kpi-today-unread')).toBeNull();
      expect(screen.getByTestId('kpi-today-partial-coverage').textContent).toContain(
        '1 day of 1 in this window could not be read',
      );
    });
  });
  /**
   * L-O1 (2026-09-23, lane-O). Lane M gave the PAGE a sentence for rows whose
   * `day` is neither 'unknown' nor a UTC calendar date; this block is about the
   * ROWS. The aggregate paragraph says how many such rows exist, and a reader
   * scanning the table still could not tell WHICH ones they were: a `day` of
   * `''` printed an empty cell beside real tokens and real dollars, and
   * `'2026-8-5'` printed exactly like a date the page could place in a window.
   * A qualification that lives somewhere other than with the claim it
   * qualifies has not been published to the reader who meets the claim.
   */
  describe('a per-day row whose day the page cannot read (L-O1)', () => {
    /** The first cell of every body row - the day column. */
    function dayCells() {
      const table = screen.getByRole('table', { name: 'cost per day' });
      return [...table.querySelectorAll('tbody tr')].map((row) => row.querySelector('td'));
    }

    it('marks an empty day instead of printing a blank cell beside real money', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 1500, costUsd: 0.15, unpricedTokens: 40 },
            perDay: [
              { day: '2026-07-28', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
              // The wire type is `Type.String()` and the client guards check
              // strings for being strings, so this row is contract-valid and
              // reaches the table as it is.
              { day: '', tokens: 500, costUsd: 0.05, unpricedTokens: 40 },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByRole('table', { name: 'cost per day' });

      const [readable, unreadable] = dayCells();
      // A day the page CAN read is printed exactly as served - the marking
      // must cost the ordinary row nothing. Exactly one row is marked, so the
      // reader can match the paragraph's count to the rows it is counting.
      expect(readable?.textContent).toBe('2026-07-28');
      expect(screen.getAllByTestId('perday-unreadable-day')).toHaveLength(1);
      // BEFORE: '' - an empty cell next to 500 tokens and $0.05, telling the
      // reader nothing at all about why the day is missing.
      expect(unreadable?.textContent).toContain('unreadable day ("")');

      const glyph = unreadable?.querySelector(`.${NO_FIGURE_META.className}`);
      expect(glyph?.textContent).toBe(NO_FIGURE_META.symbol);
      // The glyph is decoration and says so; the MEANING is in the words, so
      // the disclosure survives being read aloud with the glyph removed.
      expect(glyph?.getAttribute('aria-hidden')).toBe('true');
      glyph?.remove();
      expect(unreadable?.textContent?.trim()).toBe('unreadable day ("")');
    });

    it('marks an unpadded date rather than letting it pass as a placeable day', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 900, costUsd: 0.1, unpricedTokens: 0 },
            perDay: [
              // Sorts ABOVE '2026-08-15' as a string, which is why lane M
              // stopped ordering it against the window boundaries. The table
              // printed it as '2026-8-5' regardless - a row the windows cannot
              // place, wearing the costume of one they can.
              { day: '2026-8-5', tokens: 700, costUsd: 0.07, unpricedTokens: 0 },
              { day: '2026-02-30', tokens: 200, costUsd: 0.03, unpricedTokens: 0 },
            ],
          }),
        ),
      });
      renderView();
      await screen.findByRole('table', { name: 'cost per day' });

      const [unpadded, overflowed] = dayCells();
      // BEFORE: '2026-8-5' - indistinguishable from a day in a window.
      expect(unpadded?.textContent).toContain('unreadable day ("2026-8-5")');
      // And the raw value is reproduced, never paraphrased away: a reader who
      // has to go and ask the server needs to quote what it actually sent.
      expect(unpadded?.textContent).toContain('2026-8-5');
      // `Date.parse` is lenient enough to turn this into March 2nd, which is
      // precisely why the round-trip - not the parse - is the test.
      expect(overflowed?.textContent).toContain('unreadable day ("2026-02-30")');
    });

    it('leaves the server\'s own "unknown" unmarked - a value it chose, not one this page failed to read', async () => {
      routeFetch();
      renderView();
      await screen.findByRole('table', { name: 'cost per day' });

      const unknownCell = dayCells().find((cell) => cell?.textContent === 'unknown');
      // Same muted cell it has always been: 'unknown' means "these rows carry
      // no timestamp", which the server determined. An unreadable day means
      // the column is not what the contract says it is. Two facts, two
      // presentations - so the gap marker must NOT appear here.
      expect(unknownCell?.getAttribute('class')).toBe('muted');
      expect(unknownCell?.querySelector(`.${NO_FIGURE_META.className}`)).toBeNull();
      expect(screen.queryByTestId('perday-unreadable-day')).toBeNull();
      expect(screen.getByRole('table', { name: 'cost per day' }).textContent).not.toContain(
        'unreadable day',
      );
    });

    it('names an unreadable day in the undrawable-bar notice instead of a blank', async () => {
      routeFetch({
        summary: jsonResponse(
          200,
          costSummary({
            totals: { tokens: 500, costUsd: 0, unpricedTokens: 0 },
            perDay: [{ day: '', tokens: 500, costUsd: Number.NaN, unpricedTokens: 0 }],
          }),
        ),
      });
      renderView();

      // BEFORE: 'Not drawable as a bar:  (cost unreadable).' - the notice
      // whose whole job is to NAME what it could not draw, naming nothing.
      const notice = await screen.findByTestId('perday-undrawable');
      expect(notice.textContent).toContain('unreadable day ("") (cost unreadable)');
    });
  });
});

/**
 * The vanished subject (2026-09-23, lane-P). The sibling of L-O1 on the model
 * axis. `perModel[].model` is `Type.String()` on the wire and the client
 * guards check strings only for being strings, so a blank name is
 * contract-valid - and every surface that names a model (the table cell, the
 * legend entry beside a colour swatch, the zero-cost notice, the undrawable
 * notice) then shows real tokens and real dollars attached to nothing.
 */
describe('CostView - a model the server did not name (lane-P)', () => {
  /** The first cell of every body row of the per-model table. */
  function modelCells() {
    const table = screen.getByRole('table', { name: 'cost per model' });
    return [...table.querySelectorAll('tbody tr')].map((row) => row.querySelector('td'));
  }

  it('marks a blank model name instead of a blank cell beside real money', async () => {
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          totals: { tokens: 1500, costUsd: 0.15, unpricedTokens: 0 },
          perModel: [
            { model: 'claude-opus-4', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
            { model: '', tokens: 500, costUsd: 0.05, unpricedTokens: 0 },
          ],
        }),
      ),
    });
    renderView();
    await screen.findByRole('table', { name: 'cost per model' });

    const [named, blank] = modelCells();
    // A model the server DID name is printed exactly as served - the marking
    // must cost the ordinary row nothing.
    expect(named?.textContent).toBe('claude-opus-4');
    // BEFORE: '' - an empty cell next to 500 tokens and $0.05.
    expect(blank?.textContent).toContain('blank model name ("")');
    const glyph = blank?.querySelector(`.${NO_FIGURE_META.className}`);
    // Same shared gap vocabulary as the per-day cell, not a second glyph: the
    // shell legend is generated from status.ts and explains this one already.
    expect(glyph?.textContent).toBe(NO_FIGURE_META.symbol);
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    glyph?.remove();
    expect(blank?.textContent?.trim()).toBe('blank model name ("")');
  });

  it('names a blank model in the legend beside its colour swatch', async () => {
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          sessionCount: 1,
          totals: { tokens: 1000, costUsd: 1, unpricedTokens: 0 },
          perModel: [{ model: '', tokens: 1000, costUsd: 1, unpricedTokens: 0 }],
          topSessions: [
            {
              sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
              projectSlug: 'agenthropic',
              tokens: 1000,
              costUsd: 1,
              unpricedTokens: 0,
            },
          ],
        }),
      ),
    });
    renderView();

    const legend = await screen.findByRole('list', { name: 'model legend' });
    // BEFORE: a coloured square with nothing beside it - a key entry keying
    // nothing, in the one element whose entire job is to say what a colour is.
    expect(legend.textContent).toContain('blank model name ("")');
  });

  it('names a blank model in the zero-cost notice', async () => {
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          totals: { tokens: 500, costUsd: 0, unpricedTokens: 500 },
          perModel: [{ model: '', tokens: 500, costUsd: 0, unpricedTokens: 500 }],
        }),
      ),
    });
    renderView();

    // BEFORE: 'Not in the flow (usage but $0 priced): .' - a list of one
    // nothing, which reads as a page fault rather than a fact about the data.
    const notice = await screen.findByTestId('zero-cost-models');
    expect(notice.textContent).toContain('blank model name ("")');
  });

  it('names a blank model in the undrawable notice', async () => {
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          totals: { tokens: 500, costUsd: 0, unpricedTokens: 0 },
          perModel: [{ model: '', tokens: 500, costUsd: -1, unpricedTokens: 0 }],
        }),
      ),
    });
    renderView();

    // BEFORE: 'model  -$1.00' - the notice that exists to NAME what it could
    // not draw, naming nothing.
    const notice = await screen.findByTestId('flow-undrawable');
    expect(notice.textContent).toContain('blank model name ("")');
  });
});

/**
 * The vanished subject (2026-09-23, lane-P), excluded-sessions half. The
 * "Reason" column's whole job is to say why a session was left out of the
 * estimate; a reason word that is present but blank produced a cell reading
 * `unrecognised reason: ` - a sentence with its subject removed.
 */
describe('CostView - an excluded session whose reason word is blank (lane-P)', () => {
  it('quotes a blank reason instead of trailing off after the colon', async () => {
    routeFetch({
      savings: jsonResponse(
        200,
        aggregateSavings({
          skippedSessionCount: 1,
          skippedSessions: [
            {
              sessionId: 'cccccccc-9999-0000-1111-222222222222',
              reason: '' as 'unpriceable',
              detail: 'no transcript on disk',
            },
          ],
        }),
      ),
    });
    renderView();

    const table = await screen.findByRole('table', {
      name: 'sessions excluded from the delegation estimate',
    });
    const reasonCell = table.querySelectorAll('tbody td')[1];
    expect(reasonCell?.textContent).toBe('unrecognised reason: ""');
  });
});

/**
 * KK2 (2026-09-25). The burners panel qualified its ranking only when the
 * server SAID it truncated. The DAG view already refuses the other shape of
 * the same gap (A4): fewer nodes drawn than the same read counts, with the flag
 * left false. The ranking is built from those nodes, so "All N agents" is the
 * same overclaim there.
 */
describe('CostView burners - counts disagree without a truncation flag (KK2)', () => {
  const disagreeing = (nodes: ReturnType<typeof agentNode>[]) =>
    jsonResponse(
      200,
      globalDag({
        nodes,
        counts: { totalAgents: 1200, returnedAgents: nodes.length, truncated: false },
      }),
    );

  it('does not claim "All N agents" over a slice the payload admits is partial', async () => {
    const nodes = Array.from({ length: 5 }, (_, index) =>
      agentNode({ id: `agent-${String(index)}`, totalTokens: 100 + index }),
    );
    routeFetch({ dag: disagreeing(nodes) });
    renderView();

    const notice = await screen.findByTestId('burners-count-disagreement');
    expect(notice.textContent).toContain('5 of the 1200 agents this same read counts');
    expect(notice.textContent).toContain('was not marked truncated');
    expect(notice.textContent).toContain('slice of unknown size');
    expect(screen.queryByTestId('burners-truncation')).toBeNull();
    const scope = screen.getByTestId('burners-scope').textContent;
    expect(scope).not.toContain('All 5 agents with recorded usage.');
    expect(scope).toContain('5 agents with recorded usage in the returned slice.');
  });

  it('scopes the empty state to the slice when nothing in it carries tokens', async () => {
    routeFetch({ dag: disagreeing([agentNode({ totalTokens: 0, costUsd: 0 })]) });
    renderView();

    await screen.findByTestId('burners-count-disagreement');
    const empty = screen.getByTestId('burners-empty').textContent;
    expect(empty).toContain('No agent in the returned slice has a recorded token count.');
    expect(empty).not.toContain('yet');
  });

  it('scopes a top-N cut to the slice too', async () => {
    const nodes = Array.from({ length: TOP_BURNERS_N + 1 }, (_, index) =>
      agentNode({ id: `agent-${String(index).padStart(2, '0')}`, totalTokens: 1000 + index }),
    );
    routeFetch({ dag: disagreeing(nodes) });
    renderView();

    await screen.findByTestId('burners-count-disagreement');
    expect(screen.getByTestId('burners-scope').textContent).toContain(
      `Top ${String(TOP_BURNERS_N)} of ${String(TOP_BURNERS_N + 1)} agents with recorded usage in the returned slice.`,
    );
  });

  it('stays quiet when the nodes and the count agree', async () => {
    routeFetch({ dag: jsonResponse(200, globalDag({ nodes: [agentNode({ totalTokens: 9 })] })) });
    renderView();
    await screen.findByTestId('burners-scope');
    expect(screen.queryByTestId('burners-count-disagreement')).toBeNull();
  });
});

/**
 * KK3 (2026-09-25). The page reads three endpoints once and then keeps
 * painting, so every figure on it is a snapshot with an age - the same
 * disclosure the DAG and sessions views carry (snapshot.ts), and the same
 * explicit control to re-read. No SSE-driven refresh: that is an owner call.
 */
describe('CostView provenance, refresh and retry (KK3)', () => {
  const AGED_MS = 2 * 60 * 1000;

  it('ages the read on screen and escalates the caveat once it is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 15, 12, 0, 0));
    routeFetch();
    renderView();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const fresh = screen.getByTestId('cost-provenance');
    expect(fresh.textContent).toContain('Read just now.');
    expect(fresh.getAttribute('class')).toBe('muted card-provenance');
    const callsAfterMount = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGED_MS);
    });

    const aged = screen.getByTestId('cost-provenance');
    expect(aged.textContent).toContain('Read 2m ago');
    expect(aged.textContent).toContain('usage recorded since is in none of them');
    expect(aged.getAttribute('class')).toBe('truncation-banner');
    // Ageing is arithmetic on a stamp, not a reason to hit the API.
    expect(fetchMock.mock.calls).toHaveLength(callsAfterMount);
  });

  it('re-reads all three endpoints and re-stamps when Refresh is used', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 15, 12, 0, 0));
    routeFetch();
    renderView();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGED_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh costs' }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const urls = fetchMock.mock.calls.slice(3).map((call) => String(call[0]));
    expect(urls.some((url) => url.startsWith('/api/cost/summary'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/dag/global'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/cost/delegation-savings'))).toBe(true);
    const refreshed = screen.getByTestId('cost-provenance');
    expect(refreshed.textContent).toContain('Read just now.');
    expect(refreshed.getAttribute('class')).toBe('muted card-provenance');
  });

  it('aborts the superseded reads when Refresh is used mid-flight', async () => {
    routeFetch();
    renderView();
    await screen.findByTestId('cost-provenance');
    const pending = deferred<Response>();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return pending.promise;
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh costs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh costs' }));

    // The first refresh's three reads are cancelled by the second.
    expect(signals).toHaveLength(6);
    expect(signals.slice(0, 3).every((signal) => signal.aborted)).toBe(true);
    expect(signals.slice(3).some((signal) => signal.aborted)).toBe(false);
  });

  it('points the "not measured" tile at the Refresh control, not a page reload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 15, 23, 59, 50));
    routeFetch({
      summary: jsonResponse(
        200,
        costSummary({
          totals: { tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
          perDay: [{ day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 }],
        }),
      ),
    });
    renderView();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
    });

    const today = screen.getByTestId('kpi-today').textContent;
    expect(screen.getByTestId('kpi-today-unread').textContent).toBe('not measured');
    expect(today).toContain('use Refresh costs to measure it');
    expect(today).not.toContain('reload');
  });

  it('offers a retry that actually re-reads after a failed summary fetch', async () => {
    let summaryCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/dag/global')) return Promise.resolve(jsonResponse(200, globalDag()));
      if (url.includes('/api/cost/delegation-savings')) {
        return Promise.resolve(jsonResponse(200, aggregateSavings()));
      }
      summaryCalls += 1;
      return Promise.resolve(
        summaryCalls === 1
          ? jsonResponse(500, { error: 'Internal server error.' })
          : jsonResponse(200, richSummary()),
      );
    });
    renderView();

    await screen.findByText(/Could not load cost summary: Internal server error\./);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByLabelText('totals');
    expect(summaryCalls).toBe(2);
  });
});

/**
 * KK4 (2026-09-25). The shared clock ticks every CLOCK_INTERVAL_MS, so a fetch
 * that lands just after UTC midnight can be cut against a tick from just
 * before it. The rows are the new day's; the page must not call them future.
 */
describe('CostView across a fetch that lands just after UTC midnight (KK4)', () => {
  it('files the new day as today, not as a clock disagreement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 15, 23, 59, 50));
    const summary = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/dag/global')) return Promise.resolve(jsonResponse(200, globalDag()));
      if (url.includes('/api/cost/delegation-savings')) {
        return Promise.resolve(jsonResponse(200, aggregateSavings()));
      }
      return summary.promise;
    });
    renderView();

    // The response lands twenty seconds later, before the next clock tick.
    vi.setSystemTime(Date.UTC(2026, 7, 16, 0, 0, 10));
    await act(async () => {
      summary.resolve(
        jsonResponse(
          200,
          costSummary({
            totals: { tokens: 700, costUsd: 0.07, unpricedTokens: 0 },
            perDay: [{ day: '2026-08-16', tokens: 700, costUsd: 0.07, unpricedTokens: 0 }],
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    const today = screen.getByTestId('kpi-today').textContent;
    expect(today).toContain('2026-08-16 · 700 tokens');
    expect(today).toContain('$0.07');
    expect(screen.getByTestId('windows-basis').textContent).not.toContain('disagree');
  });
});
