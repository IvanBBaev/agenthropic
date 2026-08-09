/**
 * Honesty-invariant regression suite (audit of WP-U5..U9).
 *
 * Every test here pins one rule the dashboard must never break:
 *   - `unknown` (and any status the UI does not recognise) stays VISIBLE -
 *     never coerced to a friendlier default, never omitted, never a crash;
 *   - a missing value reads as "we do not know", never as a confident claim
 *     ("no project", "agent") and never as a silent zero;
 *   - inferred edges stay distinguishable from observed ones;
 *   - `unpricedTokens` surfaces everywhere a dollar figure is shown;
 *   - the honesty signals survive without colour and without a pointer: the
 *     D3 charts carry a text alternative that assistive tech can reach.
 * fetch and EventSource are mocked - no real server, no ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Shell } from '../src/Shell';
import { CostView } from '../src/views/CostView';
import { DagView } from '../src/views/DagView';
import { LiveView } from '../src/views/LiveView';
import { SessionsView } from '../src/views/SessionsView';
import { createSseClient, type SseClient } from '../src/sse';
import { agentTypeLabel, projectLabel } from '../src/format';
import { describeAgentGraph, describeCostFlow } from '../src/views/chart-summary';
import { applyAgentStatusChange } from '../src/views/live-model';
import {
  AGENT_STATUSES,
  NULL_STATUS_META,
  STATUS_META,
  statusMeta,
  UNRECOGNISED_STATUS_LABEL,
  unrecognisedStatusMeta,
} from '../src/views/status';
import { computeCostFlow, toFlowLink, toFlowNode } from '../src/views/layout/cost-flow';
import type { AgentStatus, SessionStatusCountsDto } from '../src/dto';
import {
  agentNode,
  costSummary,
  globalDag,
  jsonResponse,
  orchestrationEdge,
  sessionList,
  sessionSummary,
  sessionTree,
  statusCounts,
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

function renderLive() {
  return render(<LiveView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
}

function renderSessions() {
  return render(<SessionsView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
}

function renderDag() {
  return render(<DagView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
}

function renderCost() {
  return render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
}

/** Route list vs tree fetches; /tree must match before /api/sessions. */
function routeSessionFetch(options: { list?: Response; tree?: Response } = {}): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/tree')) {
      return Promise.resolve(options.tree ?? jsonResponse(200, sessionTree()));
    }
    return Promise.resolve(options.list ?? jsonResponse(200, sessionList([sessionSummary()])));
  });
}

describe('a status the UI does not recognise', () => {
  it('renders visibly instead of vanishing or crashing', () => {
    const meta = statusMeta('archived');
    expect(meta.symbol.length).toBeGreaterThan(0);
    expect(meta.label).toContain(UNRECOGNISED_STATUS_LABEL);
    // The raw value is shown, not swallowed - the operator can look it up.
    expect(meta.label).toContain('archived');
    expect(meta.className).toBe('status-unrecognised');
    expect(meta).toEqual(unrecognisedStatusMeta('archived'));
    // It is NOT quietly folded into one of the known states.
    for (const status of AGENT_STATUSES)
      expect(meta.className).not.toBe(STATUS_META[status].className);
    expect(meta.className).not.toBe(NULL_STATUS_META.className);
  });

  it('keeps the session tree drawable when an agent carries an unknown status word', async () => {
    routeSessionFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          agents: [agentNode({ id: 'agent-main', status: 'archived' as AgentStatus })],
          edges: [],
        }),
      ),
    });
    renderSessions();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const node = await screen.findByTestId('tree-node-agent-main');
    expect(node.textContent).toContain('archived');
    expect(node.getAttribute('class')).toBe('status-unrecognised');
  });

  it('keeps the global DAG drawable when an agent carries an unknown status word', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({ nodes: [agentNode({ id: 'a1', status: 'archived' as AgentStatus })] }),
      ),
    );
    renderDag();

    const node = await screen.findByTestId('dag-node-a1');
    expect(node.textContent).toContain('archived');
    expect(node.getAttribute('class')).toBe('status-unrecognised');
  });
});

describe('the session-level status', () => {
  it('is rendered on the live board, including the watchdog `unknown`', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, sessionList([sessionSummary({ status: 'unknown' })])),
    );
    renderLive();
    const chip = await screen.findByTestId('session-status-aaaaaaaa-1111-2222-3333-444444444444');
    expect(chip.textContent).toContain('unknown');
  });

  it('distinguishes an unrecorded session status from the watchdog `unknown`', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary({ status: null })])));
    renderLive();
    const chip = await screen.findByTestId('session-status-aaaaaaaa-1111-2222-3333-444444444444');
    expect(chip.textContent).toContain(NULL_STATUS_META.label);
    expect(chip.textContent).not.toContain('unknown');
  });

  it('is rendered in the session list row too', async () => {
    routeSessionFetch({
      list: jsonResponse(200, sessionList([sessionSummary({ status: 'zombie' })])),
    });
    renderSessions();
    await screen.findByRole('list', { name: 'session list' });
    expect(screen.getByRole('list', { name: 'session list' }).textContent).toContain('zombie');
  });
});

describe('a status bucket the server did not send', () => {
  it('renders an explicit unknown marker, never a blank next to the label', async () => {
    const holes = { working: 1, completed: 2 } as SessionStatusCountsDto;
    fetchMock.mockResolvedValue(
      jsonResponse(200, sessionList([sessionSummary({ statusCounts: holes })])),
    );
    renderLive();
    const buckets = await screen.findByLabelText(
      'status counts for aaaaaaaa-1111-2222-3333-444444444444',
    );
    expect(buckets.textContent).toContain('? waiting');
    expect(buckets.textContent).toContain('? error');
    expect(buckets.textContent).toContain('? unknown');
  });
});

describe('a missing project slug', () => {
  it('reads as unknown, never as a confident "no project"', () => {
    expect(projectLabel(null)).toBe('project unknown');
    expect(projectLabel('agenthropic')).toBe('agenthropic');
  });

  it('uses that copy on the live board', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, sessionList([sessionSummary({ projectSlug: null })])),
    );
    renderLive();
    await screen.findByText('project unknown');
  });

  it('uses that copy in the session list', async () => {
    routeSessionFetch({
      list: jsonResponse(200, sessionList([sessionSummary({ projectSlug: null })])),
    });
    renderSessions();
    await screen.findByText('project unknown');
  });

  it('uses that copy in the top-sessions table', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 100, costUsd: 0.5, unpricedTokens: 0 },
          topSessions: [
            { sessionId: 's1', projectSlug: null, tokens: 100, costUsd: 0.5, unpricedTokens: 0 },
          ],
        }),
      ),
    );
    renderCost();
    await screen.findByText('project unknown');
  });
});

describe('an agent with no recorded type', () => {
  it('says so instead of calling itself the generic word "agent"', () => {
    expect(agentTypeLabel('Explore', 'subagent')).toBe('Explore');
    expect(agentTypeLabel(null, 'main')).toBe('main');
    expect(agentTypeLabel(null, null)).toBe('type unrecorded');
  });

  it('shows the unrecorded label on a tree node', async () => {
    routeSessionFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          agents: [agentNode({ id: 'agent-main', type: null, subagentType: null })],
          edges: [],
        }),
      ),
    });
    renderSessions();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const node = await screen.findByTestId('tree-node-agent-main');
    expect(node.textContent).toContain('type unrecorded');
  });

  it('shows the unrecorded label in a DAG node title', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({ nodes: [agentNode({ id: 'a1', type: null, subagentType: null })] }),
      ),
    );
    renderDag();
    const node = await screen.findByTestId('dag-node-a1');
    expect(node.textContent).toContain('type unrecorded');
  });
});

describe('unpriced tokens in the session list', () => {
  it('are marked on the row that shows the dollar figure', async () => {
    routeSessionFetch({
      list: jsonResponse(
        200,
        sessionList([sessionSummary({ totalCostUsd: 0, unpricedTokens: 3000 })]),
      ),
    });
    renderSessions();
    const row = await screen.findByRole('button', { name: /agenthropic/ });
    expect(row.textContent).toContain('$0.00');
    expect(row.textContent).toContain('~ 3,000 unpriced');
    expect(row.querySelector('.unpriced')).not.toBeNull();
  });
});

describe('the cost totals', () => {
  it('say the headline dollar figure covers priced tokens only when a gap exists', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 9000, costUsd: 1.5, unpricedTokens: 4000 },
          perModel: [{ model: 'claude-a', tokens: 9000, costUsd: 1.5, unpricedTokens: 4000 }],
        }),
      ),
    );
    renderCost();
    const totals = await screen.findByLabelText('totals');
    expect(totals.textContent).toContain('priced tokens only');
  });

  it('do not carry that note when every token is priced', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 9000, costUsd: 1.5, unpricedTokens: 0 },
          perModel: [{ model: 'claude-a', tokens: 9000, costUsd: 1.5, unpricedTokens: 0 }],
        }),
      ),
    );
    renderCost();
    const totals = await screen.findByLabelText('totals');
    expect(totals.textContent).not.toContain('priced tokens only');
  });

  it('distinguish an empty database from a genuine $0', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, costSummary()));
    renderCost();
    await screen.findByLabelText('totals');
    expect(screen.getByTestId('no-usage-note').textContent).toContain('No usage recorded yet');
  });

  it('do not claim emptiness when usage exists but nothing is priced', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 500, costUsd: 0, unpricedTokens: 500 },
          perModel: [{ model: 'claude-x', tokens: 500, costUsd: 0, unpricedTokens: 500 }],
        }),
      ),
    );
    renderCost();
    await screen.findByLabelText('totals');
    expect(screen.queryByTestId('no-usage-note')).toBeNull();
  });
});

describe('the cost-flow session labels', () => {
  it('never truncate a real project slug into something that reads like an id', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 4000, costUsd: 1, unpricedTokens: 0 },
          perModel: [{ model: 'claude-a', tokens: 4000, costUsd: 1, unpricedTokens: 0 }],
          topSessions: [
            {
              sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
              projectSlug: 'agenthropic',
              tokens: 4000,
              costUsd: 1,
              unpricedTokens: 0,
            },
          ],
        }),
      ),
    );
    renderCost();
    const svg = await screen.findByRole('img', { name: 'cost flow from models to sessions' });
    expect(svg.textContent).toContain('agenthropic');
    expect(svg.textContent).not.toContain('agenthro…');
  });

  it('shortens a session id when there is no project slug to show', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 4000, costUsd: 1, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 4000, costUsd: 1, unpricedTokens: 0 }],
        topSessions: [
          {
            sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
            projectSlug: null,
            tokens: 4000,
            costUsd: 1,
            unpricedTokens: 0,
          },
        ],
      }),
    );
    const session = flow.nodes.find((node) => node.kind === 'session');
    expect(session?.label).toBe('aaaaaaaa…');
  });
});

describe('the chart text alternatives', () => {
  it('describes the status mix, the provenance split and the unpriced gap', () => {
    const text = describeAgentGraph(
      [
        agentNode({ id: 'a', status: 'working' }),
        agentNode({ id: 'b', status: 'unknown', unpricedTokens: 3000 }),
        agentNode({ id: 'c', status: null }),
        agentNode({ id: 'd', status: 'zombie' as AgentStatus }),
      ],
      [
        orchestrationEdge({ id: 1, source: 'tool_use' }),
        orchestrationEdge({ id: 2, source: 'directory' }),
        orchestrationEdge({ id: 3, source: 'task_notification' }),
      ],
    );
    expect(text).toContain('1 working');
    expect(text).toContain('1 unknown');
    expect(text).toContain(`1 ${NULL_STATUS_META.label}`);
    expect(text).toContain('unrecognised (zombie)');
    expect(text).toContain('1 observed (tool_use)');
    expect(text).toContain('2 inferred (directory, task_notification)');
    expect(text).toContain('3,000');
  });

  it('says so honestly when there is nothing to describe', () => {
    const text = describeAgentGraph([], []);
    expect(text).toContain('No agents');
    expect(text).toContain('No edges');
    expect(text).not.toContain('unpriced');
  });

  it('names only observed edges when nothing was inferred', () => {
    const text = describeAgentGraph([agentNode()], [orchestrationEdge({ source: 'tool_use' })]);
    expect(text).toContain('1 observed (tool_use)');
    expect(text).toContain('0 inferred');
    expect(text).not.toContain('(directory');
  });

  it('describes the dollar flow, the undrawn models and the unpriced remainder', () => {
    const summary = costSummary({
      totals: { tokens: 9000, costUsd: 1.25, unpricedTokens: 4000 },
      perModel: [
        { model: 'claude-a', tokens: 4000, costUsd: 1.0, unpricedTokens: 0 },
        { model: 'claude-b', tokens: 1000, costUsd: 0.25, unpricedTokens: 0 },
        { model: 'claude-x', tokens: 4000, costUsd: 0, unpricedTokens: 4000 },
      ],
      topSessions: [
        {
          sessionId: 's1',
          projectSlug: 'agenthropic',
          tokens: 5000,
          costUsd: 1.0,
          unpricedTokens: 2000,
        },
      ],
    });
    const text = describeCostFlow(computeCostFlow(summary), summary.totals.unpricedTokens);
    expect(text).toContain('claude-a $1.00');
    expect(text).toContain('agenthropic $1.00');
    expect(text).toContain('other sessions $0.25');
    expect(text).toContain('claude-x');
    expect(text).toContain('2,000');
    expect(text).toContain('4,000');
  });

  it('says there is no priced flow rather than describing an empty picture', () => {
    const flow = computeCostFlow(costSummary());
    expect(describeCostFlow(flow, 0)).toContain('No priced dollar flow');
  });

  it('is reachable from the tree chart through aria-describedby', async () => {
    routeSessionFetch({
      tree: jsonResponse(
        200,
        sessionTree({
          agents: [agentNode({ id: 'agent-main' }), agentNode({ id: 'agent-child' })],
          edges: [orchestrationEdge({ source: 'directory' })],
        }),
      ),
    });
    renderSessions();
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));

    const svg = await screen.findByRole('img', { name: /agent tree for session/ });
    const describedBy = svg.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const summary = document.getElementById(describedBy!);
    expect(summary?.textContent).toContain('1 inferred (directory)');
  });

  it('is reachable from the DAG chart through aria-describedby', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode({ id: 'a1', status: 'unknown' })],
          edges: [],
        }),
      ),
    );
    renderDag();

    const svg = await screen.findByRole('img', { name: 'global orchestration dag' });
    const describedBy = svg.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const summary = document.getElementById(describedBy!);
    expect(summary?.textContent).toContain('1 unknown');
  });

  it('is reachable from the cost flow through aria-describedby', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 4000, costUsd: 1, unpricedTokens: 500 },
          perModel: [{ model: 'claude-a', tokens: 4000, costUsd: 1, unpricedTokens: 500 }],
        }),
      ),
    );
    renderCost();

    const svg = await screen.findByRole('img', { name: 'cost flow from models to sessions' });
    const describedBy = svg.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const summary = document.getElementById(describedBy!);
    expect(summary?.textContent).toContain('claude-a $1.00');
  });
});

describe('the shell legend', () => {
  function renderShell() {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/health')) {
        return Promise.resolve(jsonResponse(200, { status: 'ok', schemaVersion: 3 }));
      }
      return Promise.resolve(jsonResponse(200, sessionList()));
    });
    return render(<Shell token="secret-token" onLock={vi.fn()} onAuthRejected={onAuthRejected} />);
  }

  it('lists every symbol the app can actually paint', async () => {
    renderShell();
    const legend = (await screen.findByLabelText('uncertainty legend')).textContent ?? '';
    for (const status of AGENT_STATUSES) {
      expect(legend).toContain(STATUS_META[status].symbol);
      expect(legend).toContain(STATUS_META[status].label);
    }
    expect(legend).toContain(NULL_STATUS_META.symbol);
    expect(legend).toContain(NULL_STATUS_META.label);
    expect(legend).toContain(unrecognisedStatusMeta('x').symbol);
    expect(legend).toContain(UNRECOGNISED_STATUS_LABEL);
  });

  it('calls the tilde what it is - unpriced, not an estimate the app never makes', async () => {
    renderShell();
    const legend = (await screen.findByLabelText('uncertainty legend')).textContent ?? '';
    expect(legend).toContain('~ unpriced');
    expect(legend).not.toContain('est.');
  });
});

describe('an SSE frame the board cannot absorb', () => {
  it('never fabricates a bucket count when the previous bucket is already empty', () => {
    const session = sessionSummary({ statusCounts: statusCounts({ completed: 3 }) });
    const result = applyAgentStatusChange([session], {
      type: 'agent-status-changed',
      sessionId: session.id,
      agentId: 'agent-child',
      status: 'completed',
      previousStatus: 'working',
      occurredAt: '2026-07-29T10:10:00.000Z',
    });

    // The snapshot disagrees with the event; inventing a 4th completed agent
    // would be a lie, so the caller is told to refetch persisted truth.
    expect(result.matched).toBe(false);
    expect(result.sessions[0]!.statusCounts).toEqual(statusCounts({ completed: 3 }));
  });

  it('never invents the bucket the agent arrives in when the snapshot lacks it', () => {
    const holes = { working: 1, error: 0 } as SessionStatusCountsDto;
    const session = sessionSummary({ statusCounts: holes });
    const result = applyAgentStatusChange([session], {
      type: 'agent-status-changed',
      sessionId: session.id,
      agentId: 'agent-child',
      status: 'completed',
      previousStatus: 'working',
      occurredAt: '2026-07-29T10:10:00.000Z',
    });

    // `completed` is absent from the snapshot, so a count of 1 would be made
    // up out of nothing (and `undefined + 1` would paint a literal NaN).
    expect(result.matched).toBe(false);
    expect(result.sessions[0]!.statusCounts).toEqual(holes);
  });

  it('never invents the bucket the agent leaves when the snapshot lacks it', () => {
    const holes = { completed: 1 } as SessionStatusCountsDto;
    const session = sessionSummary({ statusCounts: holes });
    const result = applyAgentStatusChange([session], {
      type: 'agent-status-changed',
      sessionId: session.id,
      agentId: 'agent-child',
      status: 'completed',
      previousStatus: 'working',
      occurredAt: '2026-07-29T10:10:00.000Z',
    });

    expect(result.matched).toBe(false);
    expect(result.sessions[0]!.statusCounts).toEqual(holes);
  });

  it('refetches persisted truth instead of silently showing a stale board', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList([sessionSummary()])));
    renderLive();
    await screen.findByRole('list', { name: 'sessions' });
    const before = fetchMock.mock.calls.length;

    act(() => {
      MockEventSource.latest().emit('agent-status-changed', { type: 'agent-status-changed' });
    });

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
  });
});

describe('the cost-flow layout helpers', () => {
  it('coerces missing sankey geometry to zeros rather than rendering NaN', () => {
    expect(
      toFlowNode({ id: 'x', label: 'x', kind: 'hub', colorIndex: null, unpricedTokens: 0 }),
    ).toEqual({
      id: 'x',
      label: 'x',
      kind: 'hub',
      colorIndex: null,
      unpricedTokens: 0,
      value: 0,
      x0: 0,
      x1: 0,
      y0: 0,
      y1: 0,
    });
    expect(
      toFlowNode({
        id: 'x',
        label: 'x',
        kind: 'hub',
        colorIndex: null,
        unpricedTokens: 7,
        value: 2,
        x0: 1,
        x1: 2,
        y0: 3,
        y1: 4,
      }),
    ).toEqual({
      id: 'x',
      label: 'x',
      kind: 'hub',
      colorIndex: null,
      unpricedTokens: 7,
      value: 2,
      x0: 1,
      x1: 2,
      y0: 3,
      y1: 4,
    });
  });

  it('keeps a link drawable when the path generator or the width is missing', () => {
    const seed = {
      id: 'model:a',
      label: 'a',
      kind: 'model' as const,
      colorIndex: 0,
      unpricedTokens: 0,
    };
    const target = {
      id: 'hub',
      label: 'all cost',
      kind: 'hub' as const,
      colorIndex: null,
      unpricedTokens: 0,
    };
    const colors = new Map<string, number | null>([
      ['model:a', 0],
      ['hub', null],
    ]);

    const withoutPath = toFlowLink({ source: seed, target, value: 1 }, colors, () => null);
    expect(withoutPath.path).toBe('');
    expect(withoutPath.width).toBe(1);
    expect(withoutPath.colorIndex).toBe(0);

    const withPath = toFlowLink(
      { source: seed, target, value: 1, width: 12 },
      colors,
      () => 'M0,0L1,1',
    );
    expect(withPath.path).toBe('M0,0L1,1');
    expect(withPath.width).toBe(12);

    // The hub is the neutral side of a flow - no borrowed model hue.
    const neutral = toFlowLink({ source: target, target: seed, value: 1 }, colors, () => 'M0,0');
    expect(neutral.colorIndex).toBeNull();
  });

  it('uses the real d3 path generator by default', () => {
    const seed = {
      id: 'model:a',
      label: 'a',
      kind: 'model' as const,
      colorIndex: 0,
      unpricedTokens: 0,
    };
    const target = {
      id: 'hub',
      label: 'all cost',
      kind: 'hub' as const,
      colorIndex: null,
      unpricedTokens: 0,
    };
    const link = toFlowLink(
      {
        source: { ...seed, x0: 0, x1: 10, y0: 0, y1: 20 },
        target: { ...target, x0: 100, x1: 110, y0: 0, y1: 20 },
        value: 1,
        width: 4,
        y0: 10,
        y1: 10,
      },
      new Map([['model:a', 0]]),
    );
    expect(link.path.startsWith('M')).toBe(true);
  });
});

describe('coverage honesty', () => {
  // This used to inspect exactly one file (`views/layout/cost-flow.ts`), which
  // meant a pragma anywhere else in the SPA passed unnoticed. It now sweeps the
  // whole of `src/`, matching the server-side guard in
  // `apps/server/test/coverage-honesty.test.ts`.
  //
  // The pragma is banned rather than discouraged because `/* v8 ignore start */`
  // removes BOTH arms of an operator from the coverage DENOMINATOR: the reported
  // percentage rises while the untested code stays exactly as untested. For a
  // project whose central claim is that its numbers are ground truth, a coverage
  // figure inflated by hiding code is the same category of lie as a silent $0.
  // The remedy for a genuinely unreachable branch is to DELETE it.

  /** Every `.ts`/`.tsx` file under `src/`, recursively, as absolute paths. */
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
      const abs = resolve(dir, entry);
      if (statSync(abs).isDirectory()) {
        found.push(...sourceFiles(abs));
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        found.push(abs);
      }
    }
    return found;
  }

  // import.meta.url is not a file: URL under the Vitest transform, so sources
  // are resolved from the package root (the Vitest `root`) instead.
  const SRC_ROOT = resolve(process.cwd(), 'src');
  const FILES = sourceFiles(SRC_ROOT);

  it('sweeps a non-empty set of source files', () => {
    // Guards the guard: a walker that silently returns nothing would make every
    // assertion below pass vacuously.
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('keeps the whole of src/ free of coverage-ignore pragmas', () => {
    const offenders = FILES.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return (
        text.includes('v8 ignore') || text.includes('c8 ignore') || text.includes('istanbul ignore')
      );
    }).map((file) => relative(SRC_ROOT, file));

    // Listed, not counted: the failure has to name the file, or the next person
    // just deletes the test.
    expect(offenders).toEqual([]);
  });
});
