/**
 * SessionsView (WP-U7): session list -> persisted agent tree. The suite pins
 * the honesty contract: the tree renders ONLY the served edges (observed
 * solid, inferred dashed, legend always visible) and the unattributed bucket
 * is shown even at zero. fetch is mocked - no real server, no ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionsView, SESSION_LIST_LIMIT } from '../src/views/SessionsView';
import { createSseClient, type SseClient } from '../src/sse';
import {
  agentNode,
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

/** Route list vs tree fetches; /tree must match before /api/sessions. */
function routeFetch(options: { list?: Response; tree?: Response } = {}): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/tree')) {
      return Promise.resolve(options.tree ?? jsonResponse(200, sessionTree()));
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
    expect(screen.getByLabelText('edge provenance legend').textContent).toContain(
      'observed (tool_use)',
    );

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
    expect(screen.getByText('no project')).toBeDefined();
  });
});
