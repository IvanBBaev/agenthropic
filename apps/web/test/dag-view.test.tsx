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
    // The legend enumerates every inferred kind the parser can emit; a new
    // kind that is not listed here would make the legend lie by omission.
    const legend = screen.getByLabelText('edge provenance legend').textContent;
    expect(legend).toContain('observed (tool_use)');
    for (const kind of ['directory', 'task_notification', 'queue_operation', 'legacy_explore']) {
      expect(legend).toContain(kind);
    }
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

  it('draws an inferred edge differently from an observed one, in class and in title', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [
            agentNode(),
            agentNode({ id: 'agent-child', type: 'subagent', subagentType: 'Explore' }),
            agentNode({ id: 'agent-third', type: 'subagent', subagentType: 'Plan' }),
          ],
          edges: [
            orchestrationEdge(),
            orchestrationEdge({ id: 2, childAgentId: 'agent-third', source: 'directory' }),
          ],
          counts: { totalSessions: 1 },
        }),
      ),
    );
    const { container } = renderView();
    await screen.findByRole('img', { name: 'global orchestration dag' });

    expect(screen.getByText('3 agents across 1 session, 2 edges.')).toBeDefined();

    const observed = [...container.querySelectorAll('line.edge-observed')];
    const inferred = [...container.querySelectorAll('line.edge-inferred')];
    expect(observed).toHaveLength(1);
    expect(inferred).toHaveLength(1);
    // Provenance is carried by a distinct class (the dashed CSS hook), never
    // by the same markup with a different colour only.
    expect(observed[0]?.getAttribute('class')).toBe('edge edge-observed');
    expect(inferred[0]?.getAttribute('class')).toBe('edge edge-inferred');
    // ...and it is spelled out for anyone hovering or using a screen reader.
    expect(observed[0]?.querySelector('title')?.textContent).toBe('observed (tool_use)');
    expect(inferred[0]?.querySelector('title')?.textContent).toBe('inferred (directory)');
  });

  it('keeps an unknown status and unpriced tokens on a node that has no type at all', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [
            agentNode({
              id: 'agent-x',
              type: null,
              subagentType: null,
              status: 'unknown',
              totalTokens: 1500,
              costUsd: 0,
              unpricedTokens: 2500,
            }),
          ],
          counts: { totalSessions: 1 },
        }),
      ),
    );
    renderView();
    await screen.findByRole('img', { name: 'global orchestration dag' });

    expect(screen.getByText('1 agent across 1 session, 0 edges.')).toBeDefined();

    const node = screen.getByTestId('dag-node-agent-x');
    // Neither subagentType nor type is recorded: the label says exactly that
    // rather than claiming the generic word "agent" as a fact; the $0 is
    // qualified by the unpriced tokens right next to it.
    expect(node.querySelector('title')?.textContent).toBe(
      'type unrecorded agent-x - session aaaaaaaa… - unknown - 1,500 tokens, $0.00, ~2,500 unpriced',
    );
    // The watchdog's honest 'unknown' is rendered, never filtered away.
    expect(node.getAttribute('class')).toBe('status-unknown');
    expect(node.querySelector('.node-symbol')?.textContent).toBe('▲');
  });

  it('parks a self-referencing agent on a fallback layer instead of looping forever', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode()],
          edges: [orchestrationEdge({ childAgentId: 'agent-main' })],
          counts: { totalSessions: 1 },
        }),
      ),
    );
    const { container } = renderView();

    await screen.findByText('1 agent sit in a cycle and are placed on a fallback layer.');
    // The cycle is reported, not hidden: the node and its edge are still drawn.
    expect(screen.getByTestId('dag-node-agent-main')).toBeDefined();
    expect(container.querySelectorAll('line.edge')).toHaveLength(1);
    expect(screen.queryByText(/reference agents outside the returned slice/)).toBeNull();
  });

  it('counts every member of a two-agent cycle in the fallback-layer notice', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode(), agentNode({ id: 'agent-child', type: 'subagent' })],
          edges: [
            orchestrationEdge(),
            orchestrationEdge({
              id: 2,
              parentAgentId: 'agent-child',
              childAgentId: 'agent-main',
            }),
          ],
          counts: { totalSessions: 1 },
        }),
      ),
    );
    renderView();

    await screen.findByText('2 agents sit in a cycle and are placed on a fallback layer.');
    expect(screen.getByTestId('dag-node-agent-main')).toBeDefined();
    expect(screen.getByTestId('dag-node-agent-child')).toBeDefined();
  });

  it('pluralises the dropped-edge notice and draws none of those edges', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode()],
          edges: [
            orchestrationEdge({ childAgentId: 'agent-ghost-1' }),
            orchestrationEdge({ id: 2, childAgentId: 'agent-ghost-2' }),
          ],
          counts: { totalSessions: 1 },
        }),
      ),
    );
    const { container } = renderView();

    await screen.findByText(
      '2 edges reference agents outside the returned slice and are not drawn.',
    );
    expect(container.querySelectorAll('line.edge')).toHaveLength(0);
    // No phantom node is invented for the missing endpoints.
    expect(container.querySelectorAll('[data-testid^="dag-node-"]')).toHaveLength(1);
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
