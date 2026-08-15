/**
 * SessionsView (WP-U7): session list -> persisted agent tree. The suite pins
 * the honesty contract: the tree renders ONLY the served edges (observed
 * solid, inferred dashed, legend always visible) and the unattributed bucket
 * is shown even at zero. fetch is mocked - no real server, no ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionsView, SESSION_LIST_LIMIT } from '../src/views/SessionsView';
import { createSseClient, type SseClient } from '../src/sse';
import {
  agentNode,
  costAnalysis,
  deferred,
  jsonResponse,
  orchestrationEdge,
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

  it('says "Showing N of M" when the list is truncated by the page size', async () => {
    routeFetch({ list: jsonResponse(200, sessionList([sessionSummary()], { total: 80 })) });
    renderView();
    await screen.findByText('Showing 1 of 80 sessions.');
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
