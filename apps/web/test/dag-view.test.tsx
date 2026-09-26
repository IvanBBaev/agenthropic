/**
 * DagView (WP-U8): the cross-session DAG drawn from the exact returned slice.
 * The suite pins the truncation honesty ("showing N of M", never pretending
 * the slice is the whole story) and the shared edge-provenance vocabulary.
 * fetch is mocked - no real server, no ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DagView, DAG_NODE_LIMIT } from '../src/views/DagView';
import { CLOCK_INTERVAL_MS } from '../src/clock';
import { createSseClient, type SseClient } from '../src/sse';
import type { OrchestrationEdgeSource } from '../src/dto';
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

/**
 * F-4 (2026-09-02). The view reads the DAG once and then keeps painting it.
 * These tests pin what the reader is TOLD about that read - how old it is,
 * that the "showing N of M" figures belong to it rather than to now, and that
 * there is a way to take a new one - not that a timestamp field exists.
 *
 * A separate describe so nothing above is disturbed; the file-level
 * beforeEach/afterEach still apply.
 */
describe('DagView - snapshot provenance (F-4)', () => {
  // Four clock ticks: two minutes, comfortably past the 90 s window inside
  // which `formatRelativeMs` still says "just now" (see src/views/snapshot.ts).
  const AGED_MS = CLOCK_INTERVAL_MS * 4;
  const TRUNCATED_DAG = () =>
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
    });

  it('ages the read on screen and qualifies every figure once it is stale, without refetching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 2, 12, 0, 0));
    try {
      fetchMock.mockResolvedValue(jsonResponse(200, twoAgentDag()));
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const fresh = screen.getByTestId('dag-provenance');
      expect(fresh.textContent).toContain('Read just now.');
      // Inside the app's own "just now" window the caveat is a truism, so it
      // is stated quietly rather than shouted on every load.
      expect(fresh.getAttribute('class')).toBe('muted card-provenance');
      expect(
        screen.getByTestId('dag-node-agent-main').querySelector('title')?.textContent,
      ).not.toContain('as recorded');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGED_MS);
      });

      const aged = screen.getByTestId('dag-provenance');
      expect(aged.textContent).toContain('Read 2m ago');
      expect(aged.textContent).toContain('remembered, not observed');
      expect(aged.textContent).toContain('may have finished or failed since');
      // Outside that window it marks real drift, so it takes the banner
      // treatment the truncation notice already uses.
      expect(aged.getAttribute('class')).toBe('truncation-banner');
      // The hover text a reader lands on carries the same qualification.
      expect(
        screen.getByTestId('dag-node-agent-main').querySelector('title')?.textContent,
      ).toContain('- as recorded 2m ago');
      // Ageing is arithmetic on a stamp, not a reason to hit the API...
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // ...and the served status is never rewritten into a guess: the node
      // still says exactly what the ingest recorded, dated rather than edited.
      expect(screen.getByTestId('dag-node-agent-main').getAttribute('class')).toBe(
        'status-working',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads and re-stamps when the refresh control is used', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 2, 12, 0, 0));
    try {
      fetchMock.mockResolvedValue(jsonResponse(200, twoAgentDag()));
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGED_MS);
      });
      expect(screen.getByTestId('dag-provenance').textContent).toContain('Read 2m ago');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Refresh DAG' }));
        await vi.advanceTimersByTimeAsync(0);
      });

      // A second read, and the disclosure resets with it - the control is not
      // decorative, and the age it resets is the age of the new read.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const refreshed = screen.getByTestId('dag-provenance');
      expect(refreshed.textContent).toContain('Read just now.');
      expect(refreshed.getAttribute('class')).toBe('muted card-provenance');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a truncated graph is the newest slice AS OF the read, beside the untouched banner', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, TRUNCATED_DAG()));
    renderView();

    const banner = await screen.findByTestId('truncation-banner');
    // The N-of-M wording is unchanged; the as-of qualification lives in its
    // own element so the counts sentence stays exactly as pinned above.
    expect(banner.textContent).toBe(
      'Truncated: showing 1 of 1200 agents and 0 of 900 edges (node limit 1000).',
    );
    const provenance = screen.getByTestId('dag-provenance').textContent ?? '';
    // The endpoint slices by recency, so both figures count what existed at
    // one moment - the banner alone understates the incompleteness.
    expect(provenance).toContain('most recent agents first');
    expect(provenance).toContain('newest slice as of that read');
    expect(provenance).toContain('"showing N of M"');
  });

  it('claims no slice when the whole graph was returned', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, twoAgentDag()));
    renderView();
    await screen.findByRole('img', { name: 'global orchestration dag' });

    const provenance = screen.getByTestId('dag-provenance').textContent ?? '';
    expect(provenance).toContain('Read just now.');
    // Nothing was cut, so no cut is announced: a caveat that does not apply
    // is noise that teaches the reader to skip the ones that do.
    expect(provenance).not.toContain('newest slice');
  });

  it('dates the empty state too - "no agents persisted" is itself a claim with an age', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, globalDag()));
    renderView();

    await screen.findByText('No agents persisted yet - the DAG appears with the first ingest.');
    expect(screen.getByTestId('dag-provenance').textContent).toContain('Read just now.');
  });

  it('offers a retry that actually re-reads after a failed fetch', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: 'Internal server error.' }))
      .mockResolvedValueOnce(jsonResponse(200, twoAgentDag()));
    renderView();

    await screen.findByText(/Could not load DAG: Internal server error\./);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByRole('img', { name: 'global orchestration dag' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
describe('DagView - red-team honesty wave (2026-09-07)', () => {
  const AGED_MS = CLOCK_INTERVAL_MS * 4;

  /** One node returned out of a 1200-agent corpus. */
  const SLICE_OF_A_BIG_CORPUS = () =>
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
    });

  /**
   * The shape the server itself contemplates: "a zero-node selection over a
   * non-empty agents table is honestly truncated" (queries.ts, getGlobalDag).
   */
  const EMPTY_SLICE_OF_A_BIG_CORPUS = () =>
    globalDag({
      nodes: [],
      edges: [],
      counts: {
        totalSessions: 40,
        totalAgents: 1200,
        totalEdges: 900,
        returnedAgents: 0,
        returnedEdges: 0,
        truncated: true,
      },
    });

  it('DG-1: the chart text alternative describes the returned slice AS a slice', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, SLICE_OF_A_BIG_CORPUS()));
    renderView();

    const svg = await screen.findByRole('img', { name: 'global orchestration dag' });
    const summary = document.getElementById(svg.getAttribute('aria-describedby') ?? '');
    expect(summary?.textContent).toContain('Agents by status: 1 working.');
    // The image is named "global orchestration dag" and its description is
    // the only channel a screen reader has for the tally - so the tally must
    // say it counts 1 of 1200 agents, not the corpus.
    expect(summary?.textContent).toContain('1 of 1200 agents');
  });

  it('DG-1: the chart text alternative is dated once the read is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 2, 12, 0, 0));
    try {
      fetchMock.mockResolvedValue(jsonResponse(200, twoAgentDag()));
      renderView();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGED_MS);
      });

      const svg = screen.getByRole('img', { name: 'global orchestration dag' });
      const summary = document.getElementById(svg.getAttribute('aria-describedby') ?? '');
      // Every node's hover text carries "- as recorded 2m ago"; the prose that
      // stands in for those titles carried nothing.
      expect(summary?.textContent).toContain('As recorded 2m ago, not as of now.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('DG-2: does not claim nothing is persisted when the same payload counts 1200 agents', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, EMPTY_SLICE_OF_A_BIG_CORPUS()));
    renderView();

    await screen.findByTestId('dag-provenance');
    expect(
      screen.queryByText('No agents persisted yet - the DAG appears with the first ingest.'),
    ).toBeNull();
    expect(screen.getByTestId('dag-empty').textContent).toContain('1200');
  });

  it('DG-2: renders the "showing N of M" figures its own provenance sends the reader to', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, EMPTY_SLICE_OF_A_BIG_CORPUS()));
    renderView();

    const provenance = await screen.findByTestId('dag-provenance');
    expect(provenance.textContent).toContain('"showing N of M" figures above');
    // ...so those figures have to exist above it.
    expect(screen.getByTestId('truncation-banner').textContent).toContain(
      'showing 0 of 1200 agents',
    );
  });
});

/**
 * DG-3 (2026-09-08). The wave above asked what a rendered claim makes a reader
 * believe. This one asks the narrower question it did not: of the disclosures
 * on this page, which ones reach a reader who is handed the diagram as a
 * single `role="img"` object, and which exist only for someone who can see it.
 *
 * A separate describe so nothing above is disturbed; the file-level
 * beforeEach/afterEach still apply.
 */
describe('DagView - the accessible description of the picture (2026-09-08)', () => {
  /** The ids `aria-describedby` names, and the prose they actually resolve to. */
  function describedBy(svg: Element): { readonly ids: string[]; readonly text: string } {
    const ids = (svg.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
    return { ids, text: ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ') };
  }

  const SELF_REFERENCING_DAG = () =>
    globalDag({
      nodes: [agentNode()],
      edges: [orchestrationEdge({ childAgentId: 'agent-main' })],
      counts: { totalSessions: 1 },
    });

  it('DG-3: tells the description that some agents are drawn on a fallback layer', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, SELF_REFERENCING_DAG()));
    renderView();

    const svg = await screen.findByRole('img', { name: 'global orchestration dag' });
    // The notice is on the page for a reader who can see it...
    expect(
      screen.getByText('1 agent sit in a cycle and are placed on a fallback layer.'),
    ).toBeDefined();
    // ...and now also in what the diagram itself says it means. Without it the
    // other reader is given "Agents by status: 1 working" about a picture whose
    // geometry, for that node, is a stand-in rather than its real position -
    // and the hierarchy is the whole point of this image.
    const described = describedBy(svg);
    expect(described.text).toContain('sit in a cycle and are placed on a fallback layer');
    // The summary is not displaced by the notice; the list holds both.
    expect(described.text).toContain('Agents by status: 1 working.');
    // Every named id resolves: an idref pointing at nothing describes nothing
    // while reading, to anyone auditing the markup, as though it had.
    for (const id of described.ids) expect(document.getElementById(id)).not.toBeNull();
  });

  it('KK1: counts only true cycle members and names the agents below the cycle apart', async () => {
    // main <-> child is the cycle; c and d hang below it and are not in it.
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [
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
          counts: { totalSessions: 1 },
        }),
      ),
    );
    renderView();

    const svg = await screen.findByRole('img', { name: 'global orchestration dag' });
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
    fetchMock.mockResolvedValue(jsonResponse(200, twoAgentDag()));
    renderView();

    const svg = await screen.findByRole('img', { name: 'global orchestration dag' });
    const described = describedBy(svg);
    expect(described.ids.length).toBeGreaterThan(0);
    for (const id of described.ids) expect(document.getElementById(id)).not.toBeNull();
    // No cycle, no caveat: a notice that does not apply is what teaches a
    // reader to stop reading the ones that do.
    expect(described.text).not.toContain('cycle');
  });
});

/**
 * A3 / A4 (2026-09-23), from the Lane A behavioural audit. Both tests are
 * about a payload that contradicts itself and a page that used to pick the
 * confident reading: an unpriced count that is not a number (the clause
 * disappeared, which on a node hover means "fully priced"), and a node array
 * shorter than the agent count served beside it with `truncated` false (the
 * caption spoke for the whole corpus over a picture of part of it).
 */
describe('DagView claims the served payload does not support (A3, A4)', () => {
  it('A3: keeps the unpriced clause in a node hover title when the count is unreadable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode({ unpricedTokens: Number.NaN })],
          counts: { totalSessions: 1 },
        }),
      ),
    );
    renderView();

    const node = await screen.findByTestId('dag-node-agent-main');
    expect(node.querySelector('title')?.textContent).toContain(', unpriced: tokens unreadable');
  });

  it('A4: says the drawn graph and the served count disagree when nothing is marked truncated', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode()],
          // The flag is a claim ABOUT the answer; the node array IS the answer.
          counts: { totalAgents: 1200, returnedAgents: 1, totalSessions: 30, truncated: false },
        }),
      ),
    );
    renderView();

    const notice = await screen.findByTestId('dag-count-disagreement');
    expect(notice.textContent).toContain('1 of the 1200 agents this same read counts are drawn');
    expect(notice.textContent).toContain('this picture is a slice of unknown size');
    // The unqualified corpus caption is the thing this replaces - it read as a
    // description of the picture, and it was a description of the database.
    expect(screen.queryByText('1200 agents across 30 sessions, 1 edge.')).toBeNull();

    // DG-3's reader, who gets the diagram as one `role="img"` object, is owed
    // the same scope: the notice above is on the page, not in the description.
    const svg = screen.getByRole('img', { name: 'global orchestration dag' });
    const ids = (svg.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
    const described = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toContain('This counts the returned slice only: 1 of 1200 agents.');
  });
});

/**
 * SA-Z4 (2026-09-23), handed over from the Lane Z read-API audit. `totalEdges`
 * is `COUNT(*)` over `orchestration_edges`, and the returned `edges` keep only
 * those whose BOTH endpoints are among the returned agents. The table carries
 * no foreign key to agents, so an edge naming an agent id with no stored row is
 * counted by that COUNT and can never survive that filter: `returnedEdges 0`
 * against `totalEdges 1`, with `truncated` false. That is none of the three
 * states the caption distinguished - it fell to the untruncated arm, which
 * prints the corpus figures with no qualifier, and captioned a picture holding
 * no lines with the number of edges in the database.
 *
 * The page reports the gap and declines to name its cause on purpose. That the
 * node limit is NOT the explanation is provable here (`truncated` is false);
 * what the explanation IS is a fact about the server's join that this view does
 * not hold, and guessing it in the reader's hearing would be the same class of
 * claim the caption was fixed for.
 */
describe('DagView edges counted but not returned (SA-Z4)', () => {
  function danglingEdgeDag() {
    return globalDag({
      nodes: [
        agentNode(),
        agentNode({ id: 'agent-child', type: 'subagent', subagentType: 'Explore' }),
      ],
      edges: [orchestrationEdge()],
      // Agents agree, so the A4 notice is silent and this gap is the only one:
      // two edges name an agent id that has no row, and were never returned.
      counts: { totalSessions: 1, totalEdges: 3, returnedEdges: 1, truncated: false },
    });
  }

  it('captions the edges with both numbers instead of the corpus count alone', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, danglingEdgeDag()));
    renderView();

    await screen.findByText('2 agents across 1 session, 1 of 3 edges.');
    // The bare corpus count is the reading this replaces: every other figure in
    // that sentence describes the picture, so this one was read that way too.
    expect(screen.queryByText('2 agents across 1 session, 3 edges.')).toBeNull();
    // The agent counts agree, so the A4 notice must not fire alongside it.
    expect(screen.queryByTestId('dag-count-disagreement')).toBeNull();
  });

  it('names the gap, rules out the node limit, and refuses to name a cause', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, danglingEdgeDag()));
    renderView();

    const notice = await screen.findByTestId('dag-edge-count-disagreement');
    expect(notice.textContent).toContain('2 of the 3 edges this read counts were not returned');
    expect(notice.textContent).toContain('the node limit is not the reason');
    expect(notice.textContent).toContain('this page cannot say what is');

    // DG-3: the summary is the WHOLE description of the diagram for a reader
    // who cannot see the paragraph above, so the same gap goes into it.
    const svg = screen.getByRole('img', { name: 'global orchestration dag' });
    const ids = (svg.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
    const described = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toContain('Not returned: 2 of the 3 edges this same read counts');
  });

  it('leaves the paragraph out when the server already claimed truncation', async () => {
    // The truncation banner prints both edge counts itself; a second paragraph
    // repeating them buys the reader nothing and reads as two separate gaps.
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode()],
          counts: {
            totalSessions: 9,
            totalAgents: 900,
            returnedAgents: 1,
            totalEdges: 900,
            returnedEdges: 0,
            truncated: true,
          },
        }),
      ),
    );
    renderView();

    await screen.findByTestId('truncation-banner');
    expect(screen.queryByTestId('dag-edge-count-disagreement')).toBeNull();
  });

  it('says nothing when the two edge counts agree', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, twoAgentDag()));
    renderView();

    await screen.findByText('2 agents across 2 sessions, 1 edge.');
    expect(screen.queryByTestId('dag-edge-count-disagreement')).toBeNull();
  });

  /**
   * Lane-EP, same day: the strokes are the only channel that tells a sighted
   * reader how the server knows an edge exists, and they used to have two
   * settings for three facts. A source word this build has not learned drew the
   * dashed `inferred` line, which asserts a derivation the client cannot know
   * happened. It now draws its own dotted stroke and quotes the raw word.
   */
  it('draws a source word it has not learned as unrecognised, not as inferred', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [
            agentNode(),
            agentNode({ id: 'agent-child', type: 'subagent', subagentType: 'Explore' }),
          ],
          edges: [orchestrationEdge({ source: 'mcp_spawn' as OrchestrationEdgeSource })],
          counts: { totalSessions: 1 },
        }),
      ),
    );
    const { container } = renderView();

    await screen.findByRole('img', { name: 'global orchestration dag' });
    const line = container.querySelector('line.edge-unrecognised');
    expect(line).not.toBeNull();
    expect(line?.querySelector('title')?.textContent).toBe('unrecognised ("mcp_spawn")');
    expect(container.querySelectorAll('line.edge-inferred')).toHaveLength(0);
    // The legend explains the stroke the page just drew - drawing a symbol the
    // legend does not carry is this file's own standing complaint.
    expect(screen.getByLabelText('edge provenance legend').textContent).toContain('unrecognised');
  });
});

/**
 * RR1 (2026-09-26), from the adversarial review of the A4 / SA-Z4 hunks. Both
 * disagreement checks are inequalities, but every sentence they gated described
 * the one direction the audits had seen - fewer returned than counted - and the
 * edge banner subtracted the two raw. A payload that runs the other way (three
 * drawn, two counted; three edges returned, two counted) passes the shape guard
 * and used to print "3 of the 2 agents ... are drawn ... so this picture is a
 * slice", "-1 of the 2 edges ... were not returned", and "They are not in the
 * picture below" - a negative figure and two false claims. The page still
 * reports the disagreement; it names the direction and stops claiming a slice
 * or a missing edge it cannot see.
 */
describe('DagView counts that run the other way (RR1)', () => {
  function overCountedAgentsDag() {
    return globalDag({
      nodes: [
        agentNode(),
        agentNode({ id: 'agent-b', type: 'subagent', subagentType: 'Explore' }),
        agentNode({ id: 'agent-c', type: 'subagent', subagentType: 'Plan' }),
      ],
      counts: { totalAgents: 2, totalSessions: 1, truncated: false },
    });
  }

  it('reports more drawn than counted without calling the picture a slice', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, overCountedAgentsDag()));
    renderView();

    const notice = await screen.findByTestId('dag-count-disagreement');
    expect(notice.textContent).toContain('3 agents are drawn, but this same read counts only 2');
    expect(notice.textContent).toContain('this page cannot say which is right');
    // Three drawn out of two is not a slice of anything.
    expect(notice.textContent).not.toContain('slice');
    expect(notice.textContent).not.toContain('3 of the 2 agents');

    // DG-3: the description a screen reader gets carries the same direction.
    const svg = screen.getByRole('img', { name: 'global orchestration dag' });
    const ids = (svg.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
    const described = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toContain('This counts 3 agents while the same read counts only 2');
    expect(described).not.toContain('returned slice only');
  });

  function overCountedEdgesDag() {
    return globalDag({
      nodes: [
        agentNode(),
        agentNode({ id: 'agent-child', type: 'subagent', subagentType: 'Explore' }),
      ],
      edges: [orchestrationEdge()],
      // Agents agree; the read says it returned three edges and counts two.
      counts: { totalSessions: 1, totalEdges: 2, returnedEdges: 3, truncated: false },
    });
  }

  it('reports more edges returned than counted without a negative figure', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, overCountedEdgesDag()));
    renderView();

    await screen.findByText('2 agents across 1 session, 3 edges returned against 2 counted.');
    expect(screen.queryByText('2 agents across 1 session, 3 of 2 edges.')).toBeNull();

    const notice = screen.getByTestId('dag-edge-count-disagreement');
    expect(notice.textContent).toContain(
      '3 edges came back with this read, but the same read counts only 2',
    );
    expect(notice.textContent).toContain('this page cannot say which is right');
    expect(notice.textContent).not.toContain('-1');
    expect(notice.textContent).not.toContain('not returned');
    expect(notice.textContent).not.toContain('not in the picture');

    const svg = screen.getByRole('img', { name: 'global orchestration dag' });
    const ids = (svg.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
    const described = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toContain('The answer carried 3 edges while the same read counts only 2');
    expect(described).not.toContain('Not returned:');
  });
});
