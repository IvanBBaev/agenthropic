/**
 * SessionsView (WP-U7): session list -> persisted agent tree. The suite pins
 * the honesty contract: the tree renders ONLY the served edges (observed
 * solid, inferred dashed, legend always visible) and the unattributed bucket
 * is shown even at zero. fetch is mocked - no real server, no ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionsView, SESSION_LIST_LIMIT } from '../src/views/SessionsView';
import { CLOCK_INTERVAL_MS } from '../src/clock';
import { createSseClient, type SseClient } from '../src/sse';
import type { AgentNodeDto, OrchestrationEdgeSource } from '../src/dto';
import {
  agentNode,
  costAnalysis,
  deferred,
  jsonResponse,
  orchestrationEdge,
  outcomeCauseAgents,
  sessionList,
  sessionSummary,
  sessionTree,
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
});

function renderView() {
  return render(<SessionsView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
}

/**
 * Route list vs tree vs cost-analysis fetches; the more specific paths must
 * match before the /api/sessions list fallback swallows them.
 */
function routeFetch(options: { list?: Response; tree?: Response; analysis?: Response } = {}): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/tree')) {
      return Promise.resolve(options.tree ?? jsonResponse(200, sessionTree()));
    }
    if (url.includes('cost-analysis')) {
      return Promise.resolve(options.analysis ?? jsonResponse(200, costAnalysis()));
    }
    return Promise.resolve(options.list ?? jsonResponse(200, sessionList([sessionSummary()])));
  });
}

describe('SessionsView', () => {
  it('fetches the list with the Bearer header and renders selectable sessions', async () => {
    routeFetch();
    renderView();

    expect(screen.getByText('Loading sessions…')).toBeDefined();
    await screen.findByRole('list', { name: 'session list' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/sessions?limit=${String(SESSION_LIST_LIMIT)}`);
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });
    expect(screen.getByText('Select a session to see its persisted agent tree.')).toBeDefined();
  });

  it('loads and draws the persisted tree on selection: solid observed, dashed inferred, legend', async () => {
    const tree = sessionTree({
      agents: [
        agentNode(),
        agentNode({
          id: 'agent-child',
          type: 'subagent',
          subagentType: 'Explore',
          status: 'completed',
        }),
        agentNode({ id: 'agent-inferred', type: 'subagent', subagentType: null, status: null }),
      ],
      edges: [
        orchestrationEdge(),
        orchestrationEdge({
          id: 2,
          childAgentId: 'agent-inferred',
          source: 'task_notification',
        }),
      ],
    });
    routeFetch({ tree: jsonResponse(200, tree) });
    const { container } = renderView();
    await screen.findByRole('list', { name: 'session list' });

    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    await screen.findByRole('img', { name: `agent tree for session ${tree.sessionId}` });

    const treeCall = fetchMock.mock.calls.find((call) => (call[0] as string).includes('/tree'));
    expect(treeCall?.[0]).toBe('/api/sessions/aaaaaaaa-1111-2222-3333-444444444444/tree');

    expect(screen.getByText('3 agents, 2 edges (persisted).')).toBeDefined();
    expect(container.querySelectorAll('line.edge-observed')).toHaveLength(1);
    expect(container.querySelectorAll('line.edge-inferred')).toHaveLength(1);
    expect(container.querySelector('line.edge-inferred title')?.textContent).toBe(
      'inferred (task_notification)',
    );
    // The legend enumerates every inferred kind the parser can emit; a new
    // kind that is not listed here would make the legend lie by omission.
    const legend = screen.getByLabelText('edge provenance legend').textContent;
    expect(legend).toContain('observed (tool_use)');
    for (const kind of ['directory', 'task_notification', 'queue_operation', 'legacy_explore']) {
      expect(legend).toContain(kind);
    }

    // Node identity: subagentType, else type, else 'agent'; null status is 'unrecorded'.
    expect(
      screen.getByTestId('tree-node-agent-main').querySelector('title')?.textContent,
    ).toContain('main');
    const inferredNode = screen.getByTestId('tree-node-agent-inferred');
    expect(inferredNode.getAttribute('class')).toBe('status-null');
    expect(inferredNode.querySelector('title')?.textContent).toContain('unrecorded');
    expect(screen.getByRole('button', { name: /agenthropic/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows the unattributed bucket even when it is zero', async () => {
    routeFetch();
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const unattributed = await screen.findByTestId('unattributed');
    expect(unattributed.textContent).toContain('Unattributed to any agent: 0 tokens · $0.00');
  });

  it('marks unpriced unattributed usage with the ~ marker, never $0', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({ unattributed: { totalTokens: 900, costUsd: 0.12, unpricedTokens: 300 } }),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const unattributed = await screen.findByTestId('unattributed');
    expect(unattributed.textContent).toContain('900 tokens · $0.12');
    expect(unattributed.textContent).toContain('~ 300 unpriced');
  });

  it('notes edges referencing agents outside the payload instead of inventing nodes', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          edges: [orchestrationEdge(), orchestrationEdge({ id: 9, childAgentId: 'agent-ghost' })],
        }),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    await screen.findByText(/1 edge reference agents outside this payload and are not drawn\./);
  });

  it('labels a typeless agent as unrecorded and never prices its tokens away as $0', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          agents: [
            agentNode({
              id: 'agent-x',
              type: null,
              subagentType: null,
              status: 'unknown',
              totalTokens: 640,
              costUsd: 0,
              unpricedTokens: 640,
            }),
          ],
          edges: [],
        }),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    await screen.findByText('1 agent, 0 edges (persisted).');
    const node = screen.getByTestId('tree-node-agent-x');
    // No subagentType and no type: the identity says the type was never
    // recorded, and the $0 is immediately qualified by the unpriced tokens.
    expect(node.querySelector('title')?.textContent).toBe(
      'type unrecorded agent-x - unknown - 640 tokens, $0.00, ~640 unpriced',
    );
    expect(node.querySelector('.node-label')?.textContent).toBe('type unrecorded');
    expect(node.getAttribute('class')).toBe('status-unknown');
  });

  it('pluralises the dropped-edge notice and invents no node for the missing ends', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          edges: [
            orchestrationEdge({ childAgentId: 'agent-ghost-1' }),
            orchestrationEdge({ id: 2, childAgentId: 'agent-ghost-2' }),
          ],
        }),
      ),
    });
    const { container } = renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    await screen.findByText('2 edges reference agents outside this payload and are not drawn.');
    expect(container.querySelectorAll('line.edge')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid^="tree-node-"]')).toHaveLength(2);
  });

  it('parks a self-referencing agent on a fallback layer and says so', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          agents: [agentNode()],
          edges: [orchestrationEdge({ childAgentId: 'agent-main' })],
        }),
      ),
    });
    const { container } = renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    await screen.findByText('1 agent sit in a cycle and are placed on a fallback layer.');
    // The cycle is disclosed, not dropped: node and edge are still drawn.
    expect(screen.getByTestId('tree-node-agent-main')).toBeDefined();
    expect(container.querySelectorAll('line.edge')).toHaveLength(1);
  });

  it('counts both members of a two-agent cycle in the fallback notice', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          agents: [
            agentNode(),
            agentNode({ id: 'agent-child', type: 'subagent', subagentType: 'Explore' }),
          ],
          edges: [
            orchestrationEdge(),
            orchestrationEdge({
              id: 2,
              parentAgentId: 'agent-child',
              childAgentId: 'agent-main',
            }),
          ],
        }),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    await screen.findByText('2 agents sit in a cycle and are placed on a fallback layer.');
    expect(screen.getByTestId('tree-node-agent-main')).toBeDefined();
    expect(screen.getByTestId('tree-node-agent-child')).toBeDefined();
  });

  it('writes a one-agent session row in the singular', async () => {
    routeFetch({ list: jsonResponse(200, sessionList([sessionSummary({ agentCount: 1 })])) });
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    expect(screen.getByRole('button', { name: /agenthropic/ }).textContent).toContain(
      '1 agent · $0.42',
    );
  });

  it('drops a tree response that lands after the user selected another session', async () => {
    const sessionA = sessionSummary();
    const sessionB = sessionSummary({
      id: 'bbbbbbbb-5555-6666-7777-888888888888',
      projectSlug: 'kiko',
    });
    const pendingA = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(`${sessionA.id}/tree`)) return pendingA.promise;
      if (url.includes(`${sessionB.id}/tree`)) {
        return Promise.resolve(jsonResponse(200, sessionTree({ sessionId: sessionB.id })));
      }
      return Promise.resolve(jsonResponse(200, sessionList([sessionA, sessionB])));
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    expect(screen.getByText('Loading tree…')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /kiko/ }));
    await screen.findByRole('img', { name: `agent tree for session ${sessionB.id}` });

    // The first request is now stale; answering late must not swap the tree
    // out from under the selection the user is looking at.
    await act(async () => {
      pendingA.resolve(jsonResponse(200, sessionTree({ sessionId: sessionA.id })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      screen.getByRole('img', { name: `agent tree for session ${sessionB.id}` }),
    ).toBeDefined();
    expect(screen.queryByRole('img', { name: `agent tree for session ${sessionA.id}` })).toBeNull();
  });

  it('surfaces a tree fetch failure without dropping the list', async () => {
    routeFetch({ tree: jsonResponse(404, { error: 'Session not found.' }) });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    await screen.findByText(/Could not load tree: Session not found\./);
    expect(screen.getByRole('list', { name: 'session list' })).toBeDefined();
  });

  it('renders the honest empty state when nothing is persisted', async () => {
    routeFetch({ list: jsonResponse(200, sessionList()) });
    renderView();
    await screen.findByText('No sessions ingested yet - nothing to drill into.');
  });

  it('shows the list error state', async () => {
    routeFetch({ list: jsonResponse(500, { error: 'Internal server error.' }) });
    renderView();
    await screen.findByText(/Could not load sessions: Internal server error\./);
  });

  // The reader-visible half of the same guarantee: the banner is the only place
  // a failed read is explained, so it may never end at its own colon.
  it('still explains the failure when the server sends an empty {error}', async () => {
    routeFetch({ list: jsonResponse(500, { error: '' }) });
    renderView();
    await screen.findByText(/Could not load sessions: request failed \(HTTP 500\)/);
  });

  it('says "Showing N of M" when the list is truncated by the page size', async () => {
    routeFetch({ list: jsonResponse(200, sessionList([sessionSummary()], { total: 80 })) });
    renderView();
    // AMENDED 2026-09-07 (SV-1). This pinned the exact line "Showing 1 of 80
    // sessions." That was the wrong text to hold the view to, because it was
    // the wrong text to print: /api/sessions pages by most recent activity, so
    // the 79 rows not shown are the least recently active, not an arbitrary
    // remainder, and the denominator was published with nothing said about
    // what had filtered it. The assertion now matches the disclosed line; the
    // SV-1 case at the foot of this file pins the disclosure itself.
    await screen.findByText(/Showing 1 of 80 sessions - the server pages by most recent activity/);
  });

  it('calls onAuthRejected when the list fetch answers 401', async () => {
    routeFetch({ list: jsonResponse(401, { error: 'Unauthorized.' }) });
    renderView();
    await waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
  });

  it('calls onAuthRejected when the tree fetch answers 401', async () => {
    routeFetch({ tree: jsonResponse(401, { error: 'Unauthorized.' }) });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    await waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
  });

  it('renders a null project slug honestly in the session row', async () => {
    routeFetch({
      list: jsonResponse(200, sessionList([sessionSummary({ projectSlug: null })])),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    expect(screen.getByText('project unknown')).toBeDefined();
  });

  /**
   * M-9: cost analysability must not be limited to the sessions that rank in
   * the cost view's top-5. Like there, the analysis reprices transcripts off
   * disk, so it stays opt-in per row - no request may leave before the user
   * picks "analyse".
   */
  it('fetches no cost analysis until the user picks analyse on a row', async () => {
    routeFetch();
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    expect(screen.getByTestId('analysis-prompt').textContent).toContain('Pick “analyse”');
    // Exactly one request may leave on mount: the session list.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('cost-analysis'))).toBe(
      true,
    );
  });

  it('opens the per-session cost analysis for any listed row via its analyse action', async () => {
    routeFetch();
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    const analyseButton = screen.getByRole('button', { name: /analyse cost of session aaaaaaaa/ });
    expect(analyseButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(analyseButton);

    await screen.findByTestId('session-analysis');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/aaaaaaaa-1111-2222-3333-444444444444/cost-analysis',
      expect.anything(),
    );
    expect(screen.queryByTestId('analysis-prompt')).toBeNull();
    expect(analyseButton.getAttribute('aria-pressed')).toBe('true');
    // Analysing a session is independent of tree drill-down: no tree fetch
    // leaves and the tree pane keeps inviting a selection.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/tree'))).toBe(true);
    expect(screen.getByText('Select a session to see its persisted agent tree.')).toBeDefined();
  });
});

/**
 * F-3 (2026-09-02). Both panes read once - the list on mount, the tree on
 * selection - and then keep painting. These tests pin what the reader is TOLD
 * about those reads: their age, that the statuses and dollars below belong to
 * them rather than to now, and that a new read is one keyboard-reachable
 * control away.
 *
 * A separate describe so nothing above is disturbed; the file-level
 * beforeEach/afterEach still apply.
 */
describe('SessionsView - snapshot provenance (F-3)', () => {
  // Four clock ticks: two minutes, past the 90 s window inside which
  // `formatRelativeMs` still says "just now" (see src/views/snapshot.ts).
  const AGED_MS = CLOCK_INTERVAL_MS * 4;

  async function selectTheSession(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('ages both reads independently and qualifies their figures once stale, without refetching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 2, 12, 0, 0));
    try {
      routeFetch();
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const freshList = screen.getByTestId('list-provenance');
      expect(freshList.textContent).toContain('Session list read just now.');
      // A caveat that applies to every load equally is stated quietly.
      expect(freshList.getAttribute('class')).toBe('muted card-provenance');

      // The list is already two minutes old when the tree is read, so the two
      // panes are dated separately rather than sharing one line that would be
      // wrong for one of them.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGED_MS);
      });
      await selectTheSession();

      const agedList = screen.getByTestId('list-provenance');
      expect(agedList.textContent).toContain('Session list read 2m ago');
      expect(agedList.textContent).toContain('remembered, not observed');
      expect(agedList.getAttribute('class')).toBe('truncation-banner');

      const freshTree = screen.getByTestId('tree-provenance');
      expect(freshTree.textContent).toContain('Tree read just now.');
      expect(freshTree.getAttribute('class')).toBe('muted card-provenance');
      expect(
        screen.getByTestId('tree-node-agent-main').querySelector('title')?.textContent,
      ).not.toContain('as recorded');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGED_MS);
      });

      const agedTree = screen.getByTestId('tree-provenance');
      expect(agedTree.textContent).toContain('Tree read 2m ago');
      expect(agedTree.textContent).toContain('may have finished or failed since');
      expect(agedTree.getAttribute('class')).toBe('truncation-banner');
      // The hover text a reader lands on carries the same date.
      expect(
        screen.getByTestId('tree-node-agent-main').querySelector('title')?.textContent,
      ).toContain('- as recorded 2m ago');
      // The list is now four minutes old and says so: the panes age apart.
      expect(screen.getByTestId('list-provenance').textContent).toContain(
        'Session list read 4m ago',
      );
      // The served status is dated, never rewritten into a guess.
      expect(screen.getByTestId('tree-node-agent-main').getAttribute('class')).toBe(
        'status-working',
      );
      // Two fetches in total - the list and the one tree. Ageing costs nothing.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads and re-stamps the session list from its own refresh control', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 2, 12, 0, 0));
    try {
      routeFetch();
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGED_MS);
      });
      expect(screen.getByTestId('list-provenance').textContent).toContain(
        'Session list read 2m ago',
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const refreshed = screen.getByTestId('list-provenance');
      expect(refreshed.textContent).toContain('Session list read just now.');
      expect(refreshed.getAttribute('class')).toBe('muted card-provenance');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads and re-stamps the tree from its own refresh control', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 2, 12, 0, 0));
    try {
      routeFetch();
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await selectTheSession();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGED_MS);
      });
      expect(screen.getByTestId('tree-provenance').textContent).toContain('Tree read 2m ago');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Refresh tree' }));
        await vi.advanceTimersByTimeAsync(0);
      });

      const treeCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/tree'));
      expect(treeCalls).toHaveLength(2);
      const refreshed = screen.getByTestId('tree-provenance');
      expect(refreshed.textContent).toContain('Tree read just now.');
      // Refreshing the tree does not re-read the list, whose own age is
      // reported separately and is untouched by this click.
      expect(screen.getByTestId('list-provenance').textContent).toContain(
        'Session list read 2m ago',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('dates the empty list too - "no sessions yet" is itself a claim with an age', async () => {
    routeFetch({ list: jsonResponse(200, sessionList()) });
    renderView();

    await screen.findByText('No sessions ingested yet - nothing to drill into.');
    const provenance = screen.getByTestId('list-provenance');
    expect(provenance.textContent).toContain('Session list read just now.');
    // The refresh control is offered here above all: an empty list is the
    // reading most likely to have been overtaken by the first ingest.
    expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeDefined();
  });

  it('offers a retry that actually re-reads after a failed list fetch', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: 'Internal server error.' }))
      .mockResolvedValueOnce(jsonResponse(200, sessionList([sessionSummary()])));
    renderView();

    await screen.findByText(/Could not load sessions: Internal server error\./);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByRole('list', { name: 'session list' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('offers a retry that actually re-reads after a failed tree fetch', async () => {
    let treeCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/tree')) {
        treeCalls += 1;
        return Promise.resolve(
          treeCalls === 1
            ? jsonResponse(404, { error: 'Session not found.' })
            : jsonResponse(200, sessionTree()),
        );
      }
      return Promise.resolve(jsonResponse(200, sessionList([sessionSummary()])));
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    await screen.findByText(/Could not load tree: Session not found\./);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByTestId('tree-provenance');
    expect(treeCalls).toBe(2);
  });
});

/**
 * Red-team honesty wave (2026-09-07). Each case below started from one
 * question asked of a rendered claim: if a reader took this literally, what
 * would they now believe about their own data that is not true?
 *
 * A separate describe so nothing above is disturbed; the file-level
 * beforeEach/afterEach still apply.
 */
describe('SessionsView - red-team honesty wave (2026-09-07)', () => {
  const AGED_MS = CLOCK_INTERVAL_MS * 4;

  async function selectTheSession(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('SV-1: says WHICH sessions the truncated page holds, not only how many', async () => {
    routeFetch({ list: jsonResponse(200, sessionList([sessionSummary()], { total: 80 })) });
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    const line = screen.getByTestId('list-truncation');
    expect(line.textContent).toContain('Showing 1 of 80 sessions');
    // /api/sessions pages BY RECENT ACTIVITY (SESSION_PAGE_ORDER on the
    // server), so the 79 rows not shown are not an arbitrary remainder: they
    // are the least recently active, and a session started since this read
    // counts in neither the 1 nor the 80. LiveView already discloses the
    // ordering for the same endpoint - this pane printed the denominator bare.
    expect(line.textContent).toContain('most recent activity first');
    expect(line.textContent).toContain('newest slice as of that read');
  });

  it('SV-2: carries the snapshot age into the chart TEXT ALTERNATIVE, not only the hover title', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 2, 12, 0, 0));
    try {
      routeFetch();
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await selectTheSession();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGED_MS);
      });

      const svg = screen.getByRole('img', { name: /agent tree for session/ });
      const summary = document.getElementById(svg.getAttribute('aria-describedby') ?? '');
      // role="img" hides every <title> in the subtree, so this prose is the
      // ONLY channel a screen reader has for the status mix - and the hover
      // text it stands in for already says the reading is two minutes old.
      expect(summary?.textContent).toContain('As recorded 2m ago, not as of now.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('SV-3: never prints a missing status as the word "undefined"', async () => {
    // The api-layer guards deliberately check containers and load-bearing
    // numbers, never strings, so a server that omits `status` reaches the
    // renderer intact.
    routeFetch({ list: jsonResponse(200, sessionList([sessionSummary({ status: undefined })])) });
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    const row = screen.getByRole('button', { name: /agenthropic/ });
    expect(row.textContent).not.toContain('undefined');
    expect(row.textContent).toContain('no status word');
  });
});

/**
 * DG-3 (2026-09-08). The same question asked of the tree: which of this
 * panel's disclosures reach a reader who is handed the chart as one
 * `role="img"` object, and which are only on the page for someone who can see
 * it.
 *
 * A separate describe so nothing above is disturbed; the file-level
 * beforeEach/afterEach still apply.
 */
describe('SessionsView - the accessible description of the tree (2026-09-08)', () => {
  /** The ids `aria-describedby` names, and the prose they actually resolve to. */
  function describedBy(svg: Element): { readonly ids: string[]; readonly text: string } {
    const ids = (svg.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
    return { ids, text: ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ') };
  }

  it('DG-3: tells the description that some agents are parked on a fallback layer', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          agents: [agentNode()],
          edges: [orchestrationEdge({ childAgentId: 'agent-main' })],
        }),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const svg = await screen.findByRole('img', { name: /agent tree for session/ });
    // Visible to a sighted reader before this change, and only to them.
    expect(
      screen.getByText('1 agent sit in a cycle and are placed on a fallback layer.'),
    ).toBeDefined();
    const described = describedBy(svg);
    // This view promises the hierarchy "exactly as PERSISTED"; a node placed
    // on a fallback layer is not where the hierarchy would put it, and the
    // description is the only channel that can say so to this reader.
    expect(described.text).toContain('sit in a cycle and are placed on a fallback layer');
    expect(described.text).toContain('Agents by status:');
    for (const id of described.ids) expect(document.getElementById(id)).not.toBeNull();
  });

  it('KK1: counts only true cycle members and names the agents below the cycle apart', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          agents: [
            agentNode(),
            agentNode({ id: 'agent-child', type: 'subagent' }),
            agentNode({ id: 'agent-c', type: 'subagent' }),
            agentNode({ id: 'agent-d', type: 'subagent' }),
          ],
          edges: [
            orchestrationEdge(),
            orchestrationEdge({ id: 2, parentAgentId: 'agent-child', childAgentId: 'agent-main' }),
            orchestrationEdge({ id: 3, parentAgentId: 'agent-child', childAgentId: 'agent-c' }),
            orchestrationEdge({ id: 4, parentAgentId: 'agent-c', childAgentId: 'agent-d' }),
          ],
        }),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const svg = await screen.findByRole('img', { name: /agent tree for session/ });
    expect(
      screen.getByText(
        '2 agents sit in a cycle and are placed on a fallback layer; 2 more agents below the cycle are not in it but share that layer.',
      ),
    ).toBeDefined();
    expect(screen.queryByText(/4 agents sit in a cycle/)).toBeNull();
    expect(describedBy(svg).text).toContain(
      '2 agents sit in a cycle and are placed on a fallback layer; 2 more agents below the cycle are not in it but share that layer.',
    );
  });

  it('DG-3: names no id that is absent from the page when there is no cycle', async () => {
    routeFetch();
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const svg = await screen.findByRole('img', { name: /agent tree for session/ });
    const described = describedBy(svg);
    expect(described.ids.length).toBeGreaterThan(0);
    for (const id of described.ids) expect(document.getElementById(id)).not.toBeNull();
    expect(described.text).not.toContain('cycle');
  });
});

/**
 * L5 (2026-09-09), WP-U13 / decision D4: "the cause as text on error rows in
 * the Live view and the session tree, no new view, no colour".
 *
 * `outcomeCause` has been persisted (migration 17) and served on every agent
 * node since WP-U10, and until now no view rendered it: the database knew why
 * a run ended and the reader was never told. These tests pin what the six
 * causes say, what a NULL one says (nothing - never "ok"), and that the
 * surface is not narrowed to `status === 'error'`, which would show one cause
 * in six.
 *
 * A separate describe so nothing above is disturbed; the file-level
 * beforeEach/afterEach still apply.
 */
describe('SessionsView - the observed outcome cause (2026-09-09, L5)', () => {
  /** A cause string, as it arrives from a server this build may not match. */
  type OutcomeCause = NonNullable<AgentNodeDto['outcomeCause']>;

  /** The ids `aria-describedby` names, and the prose they actually resolve to. */
  function describedBy(svg: Element): { readonly ids: string[]; readonly text: string } {
    const ids = (svg.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
    return { ids, text: ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ') };
  }

  /** Render the tree for `agents` and return one string per outcome row. */
  async function outcomeRows(agents: readonly AgentNodeDto[]): Promise<string[]> {
    routeFetch({ tree: jsonResponse(200, sessionTree({ agents: [...agents], edges: [] })) });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    const list = await screen.findByRole('list', { name: 'observed agent outcomes' });
    return Array.from(list.querySelectorAll('li')).map((row) => row.textContent ?? '');
  }

  it('L5: renders each of the six persisted causes verbatim, one row per agent', async () => {
    // Verbatim is the point: every paraphrase would have to decide whether a
    // refused spawn is a failure, and the recorded token decides nothing.
    expect(await outcomeRows(outcomeCauseAgents())).toEqual([
      'Explore fa11ed01 - terminated_early',
      'general-purpose de1e7ed2 - user_interrupt',
      'Plan c0ffee01 - concurrency_limit',
      'statusline-setup c0ffee02 - permission_failed',
      'code-reviewer c0ffee03 - dispatch_unavailable',
      'doc-writer c0ffee04 - unclassified',
    ]);
  });

  it('L5: does NOT narrow the surface to agents whose status is error', async () => {
    const agents = outcomeCauseAgents();
    // The tension this test exists for: `ERROR_CAUSES` in the normalizer is
    // the one-element set { terminated_early } on purpose, so exactly one of
    // these agents is an 'error'. Rendering only that one would drop five
    // sixths of what the database observed.
    expect(agents.filter((agent) => agent.status === 'error')).toHaveLength(1);
    const rows = await outcomeRows(agents);
    expect(rows).toHaveLength(6);
    // The commonest cause in the corpus (19 of 33), on an agent that is not an
    // error and never was - the spawn was refused, so it never ran.
    expect(rows).toContain('Plan c0ffee01 - concurrency_limit');
  });

  it('L5: an agent with no observed outcome gets no row, and never reads as "ok"', async () => {
    const rows = await outcomeRows(outcomeCauseAgents());
    const rowText = rows.join(' ');
    // NULL means no outcome was observed. It is NOT a claim that the agent
    // succeeded, so it renders as nothing at all - not "ok", not "succeeded",
    // and not a dash a reader could take for a zero.
    expect(rowText).not.toContain('c0ffee05');
    expect(rowText).not.toMatch(/\bok\b/i);
    expect(rowText).not.toMatch(/succe/i);
    expect(rowText).not.toMatch(/\bnone\b/i);
    const title = screen.getByTestId('tree-node-c0ffee05').querySelector('title');
    expect(title?.textContent).toContain('Explore c0ffee05');
    expect(title?.textContent).not.toContain('outcome');
  });

  it('L5: the whole block is absent when no agent carries an outcome', async () => {
    routeFetch();
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    const svg = await screen.findByRole('img', { name: /agent tree for session/ });

    expect(screen.queryByTestId('tree-outcomes')).toBeNull();
    // Same rule as DG-3: an idref that resolves to nothing describes nothing,
    // and reads to an auditor as though the fact had been given.
    const described = describedBy(svg);
    expect(described.ids.some((id) => id.startsWith('tree-outcomes-'))).toBe(false);
    for (const id of described.ids) expect(document.getElementById(id)).not.toBeNull();
  });

  it('L5: shows a cause word this build does not know, with its raw value', async () => {
    // A server one version ahead. The word is never folded into a known cause
    // and never dropped; `unrecognised` is the word status.ts already owns for
    // exactly this condition, so the UI has one vocabulary and not two.
    // AMENDED 2026-09-23 (lane-P). RE-AIMED: the raw cause still reaches the
    // reader unparaphrased, now delimited, so that a cause of `''` is legible
    // as the empty string the server sent rather than as a hole in the page.
    const rows = await outcomeRows([
      agentNode({ id: 'agent-main', outcomeCause: 'quota_exhausted' as OutcomeCause }),
    ]);
    expect(rows).toEqual(['main agent-main - unrecognised ("quota_exhausted")']);
    expect(rows[0]).toContain('quota_exhausted');
  });

  it('L5: says the cause field did not arrive rather than printing "undefined"', async () => {
    // `dto-guards.ts` checks containers and load-bearing numbers, never
    // strings, so a server that stops sending the field reaches the renderer
    // intact - and "no cause word sent" is a different fact from "no outcome
    // was observed", which is why it is not spelled as nothing.
    const rows = await outcomeRows([agentNode({ id: 'agent-main', outcomeCause: undefined })]);
    expect(rows).toEqual(['main agent-main - unrecognised (no cause word sent)']);
    expect(rows.join(' ')).not.toContain('undefined');
  });

  it('L5: puts the outcomes in the chart description and on the hover title', async () => {
    await outcomeRows(outcomeCauseAgents());
    const svg = screen.getByRole('img', { name: /agent tree for session/ });
    const described = describedBy(svg);
    // role="img" hides the SVG subtree, <title> elements included, so a cause
    // that lived only on hover would be a fact the picture knows and this
    // reader is never told.
    expect(described.text).toContain('terminated_early');
    expect(described.text).toContain('concurrency_limit');
    for (const id of described.ids) expect(document.getElementById(id)).not.toBeNull();
    // The framing says what a cause is and is not, so a reader meeting
    // `concurrency_limit` is not left to read it as a failure.
    expect(described.text).toContain('the spawn was refused');
    expect(described.text).toContain('not a claim that it succeeded');
    // Hover parity for the sighted reader who points at a node.
    const title = screen.getByTestId('tree-node-fa11ed01').querySelector('title');
    expect(title?.textContent).toContain('- outcome terminated_early');
  });

  it('L5 (agent-outcome-errors shape): two causes do not collapse into one bucket', async () => {
    // The property the ingest-side fixture exists to prove, asked of the UI:
    // `terminated_early` resolves to status 'error' and `user_interrupt`
    // deliberately does not, and both keep their own words on screen.
    const rows = await outcomeRows(outcomeCauseAgents().slice(0, 2));
    expect(rows).toEqual([
      'Explore fa11ed01 - terminated_early',
      'general-purpose de1e7ed2 - user_interrupt',
    ]);
    expect(screen.getByTestId('tree-node-fa11ed01').getAttribute('class')).toBe('status-error');
    expect(screen.getByTestId('tree-node-de1e7ed2').getAttribute('class')).toBe('status-completed');
  });
});

/**
 * A2 / A3 (2026-09-23), from the Lane A behavioural audit. The list scope and
 * the two unpriced clauses on this pane were each gated on a test that a
 * non-finite served number fails in the same silent way a benign value does.
 * The failure is never a visible error - it is the disappearance of the
 * sentence that qualifies what is on screen, which leaves the confident
 * reading in sole possession of the page.
 */
describe('SessionsView scope and coverage the pane used to overstate (A2, A3)', () => {
  it('admits an unreadable session count instead of implying the rows are the corpus', async () => {
    routeFetch({
      list: jsonResponse(200, sessionList([sessionSummary()], { total: Number.NaN })),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    expect(screen.getByTestId('list-truncation-unknown').textContent).toContain(
      'came back unreadable',
    );
    // The SV-1 line is about a KNOWN remainder and must not be borrowed here.
    expect(screen.queryByTestId('list-truncation')).toBeNull();
  });

  it('says the served rows and the served count disagree when rows outnumber the total', async () => {
    routeFetch({
      list: jsonResponse(
        200,
        sessionList(
          [sessionSummary(), sessionSummary({ id: 'bbbbbbbb-1111-2222-3333-444444444444' })],
          {
            total: 1,
          },
        ),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    const line = screen.getByTestId('list-count-disagreement');
    expect(line.textContent).toContain(
      'These 2 rows outnumber the 1 sessions the same read counts',
    );
    expect(line.textContent).toContain('neither figure describes this list on its own');
  });

  it('keeps the unattributed unpriced clause when the count is unreadable (A3)', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          unattributed: { totalTokens: 900, costUsd: 0.12, unpricedTokens: Number.NaN },
        }),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const unattributed = await screen.findByTestId('unattributed');
    expect(unattributed.textContent).toContain('900 tokens · $0.12');
    // The dollar figure is real; what it may not do is stand alone, because a
    // bucket with no unpriced clause beside it reads as fully priced.
    expect(unattributed.textContent).toContain('unpriced: tokens unreadable');
  });

  it('keeps the unpriced clause on a session row whose count is unreadable (A3)', async () => {
    routeFetch({
      list: jsonResponse(200, sessionList([sessionSummary({ unpricedTokens: Number.NaN })])),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });

    const row = screen.getByRole('button', { name: /agenthropic/ });
    expect(row.textContent).toContain('unpriced: tokens unreadable');
  });

  it('keeps the unpriced clause in a tree node hover title (A3)', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({ agents: [agentNode({ unpricedTokens: Number.NaN })], edges: [] }),
      ),
    });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const title = (await screen.findByTestId('tree-node-agent-main')).querySelector('title');
    expect(title?.textContent).toContain(', unpriced: tokens unreadable');
  });
});

/**
 * The vanished subject (2026-09-23, lane-P). The outcome row exists to name
 * the cause the parent observed. `dto-guards.ts` checks containers and
 * load-bearing numbers and deliberately NOT strings, so the cause can arrive
 * as the empty string - and then the row renders a sentence whose only
 * informative part is missing.
 */
describe('SessionsView - an outcome cause with nothing in it (lane-P)', () => {
  type OutcomeCause = NonNullable<AgentNodeDto['outcomeCause']>;

  async function outcomeRows(agents: readonly AgentNodeDto[]): Promise<string[]> {
    routeFetch({ tree: jsonResponse(200, sessionTree({ agents: [...agents], edges: [] })) });
    renderView();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    const list = await screen.findByRole('list', { name: 'observed agent outcomes' });
    return Array.from(list.querySelectorAll('li')).map((row) => row.textContent ?? '');
  }

  it('quotes a blank cause instead of printing an empty parenthesis', async () => {
    // `unrecognised ()` reads as a rendering fault. The reader cannot tell
    // whether the server sent an empty cause or whether this page lost it -
    // and a row that shows no cause at all is worse than no row, because the
    // list is titled "observed agent outcomes".
    const rows = await outcomeRows([
      agentNode({ id: 'agent-main', outcomeCause: '' as OutcomeCause }),
    ]);
    expect(rows).toEqual(['main agent-main - unrecognised ("")']);
  });

  it('makes a whitespace-only cause visible', async () => {
    const rows = await outcomeRows([
      agentNode({ id: 'agent-main', outcomeCause: '  ' as OutcomeCause }),
    ]);
    expect(rows).toEqual(['main agent-main - unrecognised ("  ")']);
  });
});

/**
 * Lane-EP (2026-09-23). The tree's strokes are the reader's only account of how
 * the server knows one agent spawned another, and they had two settings for
 * three facts: `tool_use` drew the solid observed line and EVERYTHING ELSE drew
 * the dashed inferred one. `inferred` is a positive claim - that the server
 * derived the link - made here on the sole evidence that the word was not
 * `tool_use`. A source word this build has not learned could equally be a new
 * OBSERVATION, in which case the same dash understates the graph. The claim was
 * the client's either way, which is the one thing this channel exists to
 * prevent, so an unreadable word now gets its own dotted stroke and its raw
 * value in quotes - and both views ask the same function for the answer.
 */
describe('SessionsView edge provenance (lane-EP)', () => {
  it('draws a source word it has not learned as unrecognised, not as inferred', async () => {
    routeFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          edges: [orchestrationEdge({ source: 'mcp_spawn' as OrchestrationEdgeSource })],
        }),
      ),
    });
    const { container } = renderView();
    await screen.findByRole('list', { name: 'session list' });

    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    await screen.findByRole('img', { name: /agent tree for session/ });

    const line = container.querySelector('line.edge-unrecognised');
    expect(line).not.toBeNull();
    expect(line?.querySelector('title')?.textContent).toBe('unrecognised ("mcp_spawn")');
    expect(container.querySelectorAll('line.edge-inferred')).toHaveLength(0);
    // Never a symbol the legend does not explain.
    expect(screen.getByLabelText('edge provenance legend').textContent).toContain('unrecognised');
  });

  it('says no source word arrived rather than stringifying the absence', async () => {
    // `dto-guards.ts` checks containers and load-bearing numbers and
    // deliberately not strings, so a server that drops or renames `source`
    // reaches the renderer with `undefined`. The old dash was titled
    // `inferred (undefined)` - the same sentence SV-3 removed from `statusMeta`,
    // which told the reader their server had sent the word "undefined" when it
    // had sent no word at all.
    const edge = orchestrationEdge();
    const sourceless = Object.fromEntries(
      Object.entries(edge).filter(([key]) => key !== 'source'),
    ) as unknown as typeof edge;
    routeFetch({ tree: jsonResponse(200, sessionTree({ edges: [sourceless] })) });
    const { container } = renderView();
    await screen.findByRole('list', { name: 'session list' });

    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    await screen.findByRole('img', { name: /agent tree for session/ });

    expect(container.querySelector('line.edge-unrecognised title')?.textContent).toBe(
      'unrecognised (no source word sent)',
    );
  });
});
