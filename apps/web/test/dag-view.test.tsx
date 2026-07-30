/**
 * DagView (WP-U8): the cross-session DAG drawn from the exact returned slice.
 * The suite pins the truncation honesty ("showing N of M", never pretending
 * the slice is the whole story) and the shared edge-provenance vocabulary.
 * fetch is mocked - no real server, no ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DagView, DAG_NODE_LIMIT } from '../src/views/DagView';
import { createSseClient, type SseClient } from '../src/sse';
import { agentNode, globalDag, jsonResponse, orchestrationEdge } from './fixtures';
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
  return render(<DagView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
}

function twoAgentDag() {
  return globalDag({
    nodes: [
      agentNode(),
      agentNode({
        id: 'agent-child',
        type: 'subagent',
        subagentType: 'Explore',
        status: 'completed',
        sessionId: 'bbbbbbbb-5555-6666-7777-888888888888',
      }),
    ],
    edges: [orchestrationEdge()],
    counts: { totalSessions: 2 },
  });
}

describe('DagView', () => {
  it('requests the DAG with the node limit and the Bearer header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, twoAgentDag()));
    renderView();

    expect(screen.getByText('Loading DAG…')).toBeDefined();
    await screen.findByRole('img', { name: 'global orchestration dag' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/dag/global?limit=${String(DAG_NODE_LIMIT)}`);
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });
  });

  it('renders the full-graph summary line when nothing is truncated', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, twoAgentDag()));
    const { container } = renderView();

    await screen.findByText('2 agents across 2 sessions, 1 edge.');
    expect(screen.queryByTestId('truncation-banner')).toBeNull();
    expect(container.querySelectorAll('line.edge-observed')).toHaveLength(1);
    expect(screen.getByTestId('dag-node-agent-main')).toBeDefined();
    // Node label carries the session identity so cross-session nodes stay tellable apart.
    expect(screen.getByTestId('dag-node-agent-child').textContent).toContain('bbbbbbbb…');
    expect(screen.getByLabelText('edge provenance legend').textContent).toContain('inferred');
  });

  it('shows the truncation banner with real N-of-M numbers', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode()],
          edges: [],
          counts: {
            totalSessions: 40,
            totalAgents: 1200,
            totalEdges: 900,
            returnedAgents: 1,
            returnedEdges: 0,
            truncated: true,
          },
        }),
      ),
    );
    renderView();

    const banner = await screen.findByTestId('truncation-banner');
    expect(banner.textContent).toBe(
      'Truncated: showing 1 of 1200 agents and 0 of 900 edges (node limit 1000).',
    );
  });

  it('counts edges pointing outside the returned slice instead of drawing them', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode()],
          edges: [orchestrationEdge({ childAgentId: 'agent-not-returned' })],
          counts: { totalSessions: 1 },
        }),
      ),
    );
    const { container } = renderView();

    await screen.findByText(
      /1 edge reference agents outside the returned slice and are not drawn\./,
    );
    expect(container.querySelectorAll('line.edge')).toHaveLength(0);
  });

  it('renders the honest empty state when no agents are persisted', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, globalDag()));
    renderView();
    await screen.findByText('No agents persisted yet - the DAG appears with the first ingest.');
  });

  it('shows the error state on a failed fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal server error.' }));
    renderView();
    await screen.findByText(/Could not load DAG: Internal server error\./);
  });

  it('calls onAuthRejected on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized.' }));
    renderView();
    await waitFor(() => expect(onAuthRejected).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Could not load DAG/)).toBeNull();
  });
});
