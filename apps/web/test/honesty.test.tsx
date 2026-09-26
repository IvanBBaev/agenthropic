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
import { CLOCK_INTERVAL_MS } from '../src/clock';
import { agentTypeLabel, formatUsd, projectLabel, UNREADABLE_USD } from '../src/format';
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
import {
  computeCostFlow,
  flowNodeValueUsd,
  toFlowLink,
  toFlowNode,
} from '../src/views/layout/cost-flow';
import type { AgentStatus, SessionStatusCountsDto } from '../src/dto';
import {
  agentNode,
  aggregateSavings,
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
  // One test below crosses UTC midnight with fake timers. Restoring here rather
  // than at the end of that test means a failure inside it cannot leave a
  // frozen clock behind for everything that follows.
  vi.useRealTimers();
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

/**
 * The cost view rides three endpoints since M-9 (summary + the burners' DAG
 * slice + the aggregate delegation savings), so a blanket mockResolvedValue
 * would feed the summary to all three. Route the DAG and savings requests to
 * their own payloads; everything else gets the summary under test.
 */
function routeCostFetch(summary: Response): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/dag/global')) {
      return Promise.resolve(jsonResponse(200, globalDag()));
    }
    if (url.includes('/api/cost/delegation-savings')) {
      return Promise.resolve(jsonResponse(200, aggregateSavings()));
    }
    return Promise.resolve(summary);
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
    /*
      AMENDED 2026-09-03 (LV-3). These three assertions used to read `'? waiting'`
      and so on. The marker was explicit, which is what this test was written to
      demand - but `?` is UNRECOGNISED_STATUS_SYMBOL, the vocabulary for "the
      server sent a status word this build does not know". A missing COUNT for a
      status we do know is a different fact, and printing it with the other
      fact's glyph is the same borrowing F-14 removed elsewhere. The expected
      text moves to NO_FIGURE_META's symbol AND word; the assertion is otherwise
      unchanged, and still fails on a blank.
    */
    expect(buckets.textContent).toContain('∅ no figure waiting');
    expect(buckets.textContent).toContain('∅ no figure error');
    expect(buckets.textContent).toContain('∅ no figure unknown');
    // The borrowed glyph must be gone, not merely joined by the right one.
    expect(buckets.textContent).not.toContain('? waiting');
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
    routeCostFetch(
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
    routeCostFetch(
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
    routeCostFetch(
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
    routeCostFetch(jsonResponse(200, costSummary()));
    renderCost();
    await screen.findByLabelText('totals');
    expect(screen.getByTestId('no-usage-note').textContent).toContain('No usage recorded yet');
  });

  it('do not claim emptiness when usage exists but nothing is priced', async () => {
    routeCostFetch(
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

/**
 * F-1. The windows tick; the rows do not. Past UTC midnight the today window
 * names a day the snapshot was taken before, so its sum is zero for a reason
 * that has nothing to do with spending - and $0.00 in the slot where measured
 * dollars go is the same lie as any other unmeasured number, told in the most
 * credible font on the page.
 *
 * The pre-existing rollover test in cost-view.test.tsx crosses the same
 * boundary and does NOT trip this, because its fixture happens to carry a row
 * dated into the new day. That is the rarer case (a writer's clock running
 * ahead of the viewer's); the common one is here.
 */
describe('a cost page left open across UTC midnight', () => {
  it('refuses to print a $0.00 it could not have measured', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 15, 23, 59, 50));
    routeCostFetch(
      jsonResponse(
        200,
        costSummary({
          totals: { tokens: 1000, costUsd: 0.1, unpricedTokens: 0 },
          // Nothing dated 2026-08-16: the snapshot predates that day entirely.
          perDay: [{ day: '2026-08-15', tokens: 1000, costUsd: 0.1, unpricedTokens: 0 }],
        }),
      ),
    );
    renderCost();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Before the boundary the figure is a measurement and reads as one.
    expect(screen.getByTestId('kpi-today').textContent).toContain('$0.10');
    expect(screen.queryByTestId('kpi-today-unread')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_INTERVAL_MS);
    });

    const today = screen.getByTestId('kpi-today');
    expect(screen.getByTestId('kpi-today-unread').textContent).toBe('not measured');
    expect(today.textContent).not.toContain('$0.00');
    // The reason is stated with both dates, so the reader can act on it.
    expect(today.textContent).toContain('2026-08-16');
    expect(today.textContent).toContain('read on 2026-08-15');
    // The week window keeps its figure - six measured days is a lower bound,
    // not a fiction - but it stops presenting itself as complete.
    const week = screen.getByTestId('kpi-week');
    expect(week.textContent).toContain('$0.10');
    expect(screen.getByTestId('kpi-week-partial').textContent).toContain('a lower bound');
  });
});

describe('the cost-flow session labels', () => {
  it('never truncate a real project slug into something that reads like an id', async () => {
    routeCostFetch(
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
    // AMENDED 2026-09-23 (lane-P). RE-AIMED at the durable guarantee: the
    // chart's text alternative names the unrecognised status with the server's
    // own word. The word is now quoted so that a blank one is still visible.
    expect(text).toContain('unrecognised ("zombie")');
    expect(text).toContain('zombie');
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
    routeCostFetch(
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

  // Added 2026-09-26. Until then this block guarded only the pragma, so the two
  // other ways to buy a number - lowering a threshold or widening `exclude` -
  // passed CI in this package alone (`docs/site/contributing/testing.md`,
  // "Three asymmetries", and `RELEASE.md` §1 recorded it as a real gap). The
  // other four packages assert there is no `exclude` at all; this one
  // legitimately has one, so it pins the exact list instead. The config is read
  // as TEXT, like theirs: importing it is not possible here (`vitest/config`
  // does not load under jsdom, and the file is outside this tsconfig project).
  const VITEST_CONFIG = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');

  /** The single match of `pattern` in the config; two matches fail loudly. */
  function onlyMatch(pattern: RegExp): string {
    const matches = [...VITEST_CONFIG.matchAll(pattern)];
    expect(matches, String(pattern)).toHaveLength(1);
    return matches[0]![1]!;
  }

  it('keeps every coverage threshold at exactly 100, with no extra threshold keys', () => {
    // An exact object, not four lookups: a per-glob or per-file threshold added
    // beside the four would be a lower bar for some files that checks on the
    // four keys alone could not see.
    const body = onlyMatch(/thresholds:\s*\{([^}]*)\}/g);
    const entries = Object.fromEntries(
      [...body.matchAll(/(\w+):\s*([^,\s]+)/g)].map((m) => [m[1], m[2]]),
    );
    expect(entries).toEqual({ lines: '100', branches: '100', functions: '100', statements: '100' });
  });

  it('measures all of src/ except exactly the two named entry files', () => {
    expect(onlyMatch(/include:\s*\[([^\]]*)\]/g).trim()).toBe("'src/**'");
    // `main.tsx` is the DOM mount (exercised by the browser, not jsdom) and
    // `vite-env.d.ts` holds only type declarations. A third entry is a decision
    // to take a file out of the denominator, so it has to be made here, in a
    // diff a reviewer sees, not in the config alone.
    const excluded = [...onlyMatch(/exclude:\s*\[([^\]]*)\]/g).matchAll(/'([^']*)'/g)].map(
      (m) => m[1]!,
    );
    expect(excluded).toEqual(['src/main.tsx', 'src/vite-env.d.ts']);
    // An exclude naming a file that no longer exists hides nothing today but
    // would silently hide whatever is created under that name tomorrow.
    for (const file of excluded) {
      expect(statSync(resolve(process.cwd(), file)).isFile(), file).toBe(true);
    }
  });
});

/**
 * F-7 / F-8 (2026-09-02). The block above ("the cost-flow layout helpers")
 * pins `toFlowNode` returning `value: 0` for a node the layout never valued.
 * That assertion is correct about the converter and must not be read as the
 * honesty contract: $0.00 is a measured figure, and a node whose total was
 * never computed has no figure at all. The production path routes the money
 * field through `flowNodeValueUsd`, and these tests state what the PAGE
 * promises rather than what one converter happens to return.
 */
describe('the cost diagram accounts for what it cannot draw', () => {
  it('refuses to put a dollar amount on a node whose total was never computed', () => {
    const seed = {
      id: 'hub',
      label: 'all cost',
      kind: 'hub' as const,
      colorIndex: null,
      unpricedTokens: 0,
    };
    // Not zero: `formatUsd(NaN)` is the app's "cost unreadable", so the gap
    // survives every formatter it passes through instead of being invented
    // into a figure a reader would take as measured.
    expect(formatUsd(flowNodeValueUsd(seed))).toBe(UNREADABLE_USD);
    expect(formatUsd(flowNodeValueUsd({ ...seed, value: 3 }))).toBe('$3.00');
  });

  it('leaves no served cost both undrawn and unnamed', () => {
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 4000, costUsd: 0.7, unpricedTokens: 0 },
        perModel: [
          { model: 'drawn', tokens: 2000, costUsd: 1, unpricedTokens: 0 },
          { model: 'refunded', tokens: 1000, costUsd: -0.3, unpricedTokens: 0 },
          { model: 'broken', tokens: 500, costUsd: Number.NaN, unpricedTokens: 0 },
          { model: 'unpriced-only', tokens: 0, costUsd: 0, unpricedTokens: 500 },
        ],
      }),
    );
    // Every served model row is accounted for by exactly one of the three
    // channels the page renders: a ribbon, the zero-cost list, or the
    // undrawable notice. The old split had a fourth outcome - silence.
    const drawn = flow.links
      .filter((link) => link.sourceId.startsWith('model:'))
      .map((link) => link.sourceId.slice('model:'.length));
    const named = [...flow.zeroCostModels, ...flow.undrawable.map((entry) => entry.label)];
    expect(drawn).toEqual(['drawn']);
    expect(named).toEqual(['unpriced-only', 'model refunded', 'model broken']);
  });

  it('says the picture does not add up rather than letting the layout pick a side', () => {
    // d3-sankey resolves a disagreement between inflow and outflow by taking
    // the larger of the two as the hub's value - silently, and the result
    // still looks like a balanced diagram.
    const flow = computeCostFlow(
      costSummary({
        totals: { tokens: 9000, costUsd: 40, unpricedTokens: 0 },
        perModel: [{ model: 'claude-a', tokens: 9000, costUsd: 12, unpricedTokens: 0 }],
      }),
    );
    expect(flow.balance.balanced).toBe(false);
    expect(flow.balance.modelsMinusTotalUsd).toBe(-28);
  });
});

/**
 * CS-4 (2026-09-08). The block "the chart text alternatives" above pins what
 * `describeAgentGraph` says about the graph it is handed. It could not pin the
 * two things that make that sentence TRUE of the page - how old the reading is
 * and whether the served nodes are the whole graph - because until now the
 * function did not say them: each caller appended its own clause afterwards,
 * so the qualification was a convention two files happened to follow rather
 * than a property of the summary. These tests state the qualification as the
 * function's own contract, and pin that a caller with nothing to disclose gets
 * exactly the old string back.
 */
describe('the agent-graph summary carries its own qualification (CS-4)', () => {
  it('CS-4: dates the tally itself, so the age cannot be lost with the caller', () => {
    const text = describeAgentGraph([agentNode({ status: 'working' })], [], { asOf: '2m ago' });
    expect(text).toContain('Agents by status: 1 working.');
    expect(text).toContain('As recorded 2m ago, not as of now.');
  });

  it('CS-4: says the tally counts a slice when the payload was cut', () => {
    const text = describeAgentGraph([agentNode({ status: 'working' })], [], {
      sliceOf: { returnedAgents: 1, totalAgents: 1200 },
    });
    // Without this the sentence "Agents by status: 1 working" is a claim about
    // a 1200-agent corpus, and it is the only channel a screen reader has.
    expect(text).toContain('This counts the returned slice only: 1 of 1200 agents.');
  });

  it('RR1: a tally larger than the served count is a disagreement, not a slice', () => {
    const text = describeAgentGraph([agentNode({ status: 'working' })], [], {
      sliceOf: { returnedAgents: 3, totalAgents: 2 },
    });
    // "3 of 2" is not a slice of anything; the clause names the direction and
    // declines to say which number is right.
    expect(text).toContain(
      'This counts 3 agents while the same read counts only 2 - the returned graph and the' +
        ' served count disagree, and this page cannot say which is right.',
    );
    expect(text).not.toContain('returned slice only');
  });

  it('CS-4: states the scope of the count before its age, as the page does', () => {
    const text = describeAgentGraph([agentNode()], [], {
      asOf: '2m ago',
      sliceOf: { returnedAgents: 1, totalAgents: 1200 },
    });
    expect(text.indexOf('returned slice only')).toBeLessThan(text.indexOf('As recorded'));
  });

  it('CS-4: adds nothing a caller did not claim - an absent option is not a denial', () => {
    const agents = [agentNode({ status: 'working' }), agentNode({ id: 'b', status: null })];
    const edges = [orchestrationEdge({ source: 'directory' })];
    // A caller that knows neither fact gets the pre-CS-4 string byte for byte:
    // the function must not invent "this is the whole graph" or "as of now".
    expect(describeAgentGraph(agents, edges, {})).toBe(describeAgentGraph(agents, edges));
    expect(describeAgentGraph(agents, edges)).not.toContain('As recorded');
    expect(describeAgentGraph(agents, edges)).not.toContain('returned slice');
  });
});
