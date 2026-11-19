/**
 * UX-17 - the graph layouts and the cost windows are derived once per served
 * payload, not once per render.
 *
 * Every view here re-renders on each tick of the shared clock so its snapshot
 * label keeps ageing. The suite advances that clock, checks that the label DID
 * move (so a re-render really happened), and counts the calls into the
 * derivation underneath - wrapped, not replaced, so every figure on screen is
 * still the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { CLOCK_INTERVAL_MS } from '../src/clock';
import { createSseClient, type SseClient } from '../src/sse';
import { computeCostWindows } from '../src/views/cost-windows';
import { CostView } from '../src/views/CostView';
import { DagView } from '../src/views/DagView';
import { computeLayeredLayout } from '../src/views/layout/layered';
import { memoizeOnPayload } from '../src/views/layout/memo';
import { SessionsView } from '../src/views/SessionsView';
import {
  aggregateSavings,
  agentNode,
  changes,
  costAnalysis,
  costSummary,
  globalDag,
  jsonResponse,
  orchestrationEdge,
  sessionList,
  sessionSummary,
  sessionTree,
} from './fixtures';
import { MockEventSource } from './mock-event-source';

vi.mock('../src/views/layout/layered', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/views/layout/layered')>();
  return { ...actual, computeLayeredLayout: vi.fn(actual.computeLayeredLayout) };
});
vi.mock('../src/views/cost-windows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/views/cost-windows')>();
  return { ...actual, computeCostWindows: vi.fn(actual.computeCostWindows) };
});

/** Two minutes: past the "just now" window, so the label visibly changes. */
const AGED_MS = CLOCK_INTERVAL_MS * 4;

const fetchMock = vi.fn();
let sse: SseClient;
const onAuthRejected = vi.fn();

beforeEach(() => {
  MockEventSource.reset();
  fetchMock.mockReset();
  vi.mocked(computeLayeredLayout).mockClear();
  vi.mocked(computeCostWindows).mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', MockEventSource);
  sse = createSseClient('secret-token');
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 7, 15, 12, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('memoizeOnPayload (UX-17)', () => {
  it('computes once per payload object and again for a new one', () => {
    const compute = vi.fn((payload: { readonly n: number }) => payload.n * 2);
    const memo = memoizeOnPayload(compute);
    const first = { n: 1 };
    expect(memo(first)).toBe(2);
    expect(memo(first)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(1);
    // Equal content is not the same payload: a new read is a new object.
    expect(memo({ n: 1 })).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('remembers a computed undefined instead of recomputing it', () => {
    const compute = vi.fn((): undefined => undefined);
    const memo = memoizeOnPayload(compute);
    const payload = {};
    memo(payload);
    memo(payload);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe('the views across clock ticks (UX-17)', () => {
  it('lays the global DAG out once per read, not once per tick', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        globalDag({
          nodes: [agentNode(), agentNode({ id: 'agent-child', type: 'subagent' })],
          edges: [orchestrationEdge()],
        }),
      ),
    );
    render(<DagView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    await settle();
    expect(screen.getByTestId('dag-provenance').textContent).toContain('Read just now.');
    expect(computeLayeredLayout).toHaveBeenCalledTimes(1);

    await settle(AGED_MS);

    expect(screen.getByTestId('dag-provenance').textContent).toContain('Read 2m ago');
    expect(computeLayeredLayout).toHaveBeenCalledTimes(1);
  });

  it('lays a session tree out once per tree, not once per tick', async () => {
    const session = sessionSummary();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/tree')) return Promise.resolve(jsonResponse(200, sessionTree()));
      if (url.includes('cost-analysis')) {
        return Promise.resolve(jsonResponse(200, costAnalysis()));
      }
      return Promise.resolve(jsonResponse(200, sessionList([session])));
    });
    window.location.hash = `#/sessions/${session.id}`;
    render(<SessionsView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    await settle();
    expect(screen.getByTestId('tree-provenance').textContent).toContain('just now');
    const afterRead = vi.mocked(computeLayeredLayout).mock.calls.length;
    expect(afterRead).toBe(1);

    await settle(AGED_MS);

    expect(screen.getByTestId('tree-provenance').textContent).toContain('2m ago');
    expect(computeLayeredLayout).toHaveBeenCalledTimes(afterRead);
  });

  it('cuts the cost windows once per summary and UTC day, and again at midnight', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/changes')) return Promise.resolve(jsonResponse(200, changes()));
      if (url.includes('cost-analysis')) {
        return Promise.resolve(jsonResponse(200, costAnalysis()));
      }
      if (url.includes('/api/dag/global')) return Promise.resolve(jsonResponse(200, globalDag()));
      if (url.includes('/api/cost/delegation-savings')) {
        return Promise.resolve(jsonResponse(200, aggregateSavings()));
      }
      return Promise.resolve(
        jsonResponse(
          200,
          costSummary({
            perDay: [{ day: '2026-08-15', tokens: 700, costUsd: 0.07, unpricedTokens: 0 }],
          }),
        ),
      );
    });
    render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    await settle();
    expect(screen.getByTestId('cost-provenance').textContent).toContain('Read just now.');
    const afterRead = vi.mocked(computeCostWindows).mock.calls.length;
    expect(afterRead).toBe(1);

    await settle(AGED_MS);

    expect(screen.getByTestId('cost-provenance').textContent).toContain('Read 2m ago');
    expect(computeCostWindows).toHaveBeenCalledTimes(afterRead);

    // Past UTC midnight the same rows fall into a different "today", so the
    // windows must be cut again - within one tick, as before (M-10).
    vi.setSystemTime(Date.UTC(2026, 7, 16, 0, 0, 5));
    await settle(CLOCK_INTERVAL_MS);

    expect(computeCostWindows).toHaveBeenCalledTimes(afterRead + 1);
    expect(screen.getByTestId('kpi-today').textContent).toContain('2026-08-16');
  });
});
