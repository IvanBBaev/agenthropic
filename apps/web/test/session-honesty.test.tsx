/**
 * Owner decisions 1 and 2 (NN1) on screen. A session whose main transcript was
 * over the 64 MiB read cap is PARTIAL: every total it shows is a lower bound,
 * and the page must say so wherever that total is printed. Usage records with
 * no `message.id` cannot be deduplicated and are excluded from the totals; the
 * count of them is disclosed beside the session. Zero / `null` is the only
 * silent case. fetch is mocked - no real server, no ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CostView } from '../src/views/CostView';
import { LiveView } from '../src/views/LiveView';
import { SessionsView } from '../src/views/SessionsView';
import {
  DroppedUsageNote,
  PARTIAL_SESSION_TEXT,
  PartialAggregateNote,
  PartialBadge,
} from '../src/views/session-honesty';
import { createSseClient, type SseClient } from '../src/sse';
import {
  OVERSIZE_PARTIAL,
  agentNode,
  aggregateSavings,
  costAnalysis,
  costSummary,
  globalDag,
  jsonResponse,
  sessionCost,
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
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', MockEventSource);
  sse = createSseClient('secret-token');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BADGE = 'partial — main transcript too large to read; totals are a lower bound';

/** The ids an element names as its accessible description, in the order it names them. */
function describedByIds(element: Element): string[] {
  return (element.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
}

/** Whether `later` comes after `earlier` in document order. */
function follows(earlier: Node, later: Node): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('the shared honesty components', () => {
  it('names the partial state in the owner-decided words', () => {
    expect(PARTIAL_SESSION_TEXT).toBe(BADGE);
  });

  it('renders nothing for a whole session and the badge for a partial one', () => {
    const { container, rerender } = render(<PartialBadge partial={null} lead="" />);
    expect(container.textContent).toBe('');
    rerender(<PartialBadge partial={OVERSIZE_PARTIAL} lead=" · " />);
    expect(container.textContent).toBe(` · ${BADGE} (70.0 MiB not read)`);
  });

  it('omits the size clause when the skipped size is unknown', () => {
    const { container } = render(
      <PartialBadge partial={{ ...OVERSIZE_PARTIAL, skippedBytes: null }} lead="" />,
    );
    expect(container.textContent).toBe(BADGE);
  });

  it('does not round a small skipped size down to nothing, and names an unreadable one (2026-10-10)', () => {
    // `toFixed(1)` printed "0.0 MiB not read" for anything under 52 KiB - a
    // clause that says bytes were skipped and then names none - and "NaN MiB"
    // for a size that could not be read.
    const { container, rerender } = render(
      <PartialBadge partial={{ ...OVERSIZE_PARTIAL, skippedBytes: 10_240 }} lead="" />,
    );
    expect(container.textContent).toBe(`${BADGE} (under 0.1 MiB not read)`);
    rerender(<PartialBadge partial={{ ...OVERSIZE_PARTIAL, skippedBytes: Number.NaN }} lead="" />);
    expect(container.textContent).toBe(`${BADGE} (skipped size unreadable)`);
    // W-6 (2026-10-12): a served zero beside "too large to read" is the same
    // clause - bytes were skipped, and none are named - and the reason
    // contradicts it, so it is named as a contradiction rather than rounded.
    rerender(<PartialBadge partial={{ ...OVERSIZE_PARTIAL, skippedBytes: 0 }} lead="" />);
    expect(container.textContent).toBe(
      `${BADGE} (skipped size 0, which contradicts a transcript too large to read)`,
    );
    rerender(<PartialBadge partial={{ ...OVERSIZE_PARTIAL, skippedBytes: -5 }} lead="" />);
    expect(container.textContent).toBe(`${BADGE} (skipped size -5, a count that cannot be right)`);
  });

  it('discloses dropped usage records in the singular and plural, and is silent at zero', () => {
    const { container, rerender } = render(<DroppedUsageNote count={0} lead="" />);
    expect(container.textContent).toBe('');
    rerender(<DroppedUsageNote count={1} lead="" />);
    expect(container.textContent).toBe('1 usage record could not be deduplicated and was excluded');
    rerender(<DroppedUsageNote count={3} lead=" · " />);
    expect(container.textContent).toBe(
      ' · 3 usage records could not be deduplicated and were excluded',
    );
  });

  it('names an impossible dropped-usage count rather than swallowing or printing it (W-3, 2026-10-12)', () => {
    // A negative was shown as a figure ("-1 usage records ... were excluded")
    // and NaN reached the sentence as "NaN usage records": both are counts no
    // read can produce, and the page's other counts name such a value.
    const { container, rerender } = render(<DroppedUsageNote count={-1} lead="" />);
    expect(container.textContent).toBe(
      'The dropped-usage count came back as -1, a count that cannot be right, so how many usage records were excluded is unknown.',
    );
    rerender(<DroppedUsageNote count={Number.NaN} lead=" · " />);
    expect(container.textContent).toBe(
      ' · The dropped-usage count came back as unreadable, so how many usage records were excluded is unknown.',
    );
  });

  it('says how many partial sessions an aggregate includes, silent at zero', () => {
    const { container, rerender } = render(<PartialAggregateNote count={0} />);
    expect(container.textContent).toBe('');
    rerender(<PartialAggregateNote count={1} />);
    expect(container.textContent).toBe('Includes 1 partial session (lower bound).');
    rerender(<PartialAggregateNote count={2} />);
    expect(container.textContent).toBe('Includes 2 partial sessions (lower bound).');
  });

  it('names an impossible partial-session count rather than printing it (W-3, 2026-10-12)', () => {
    const { container, rerender } = render(<PartialAggregateNote count={Number.NaN} />);
    expect(container.textContent).toBe(
      'The partial-session count came back as unreadable, so how many of these sessions are partial is unknown - treat every total as a lower bound.',
    );
    rerender(<PartialAggregateNote count={-3} />);
    expect(container.textContent).toContain('came back as -3, a count that cannot be right');
  });
});

describe('LiveView', () => {
  it('marks a partial card and its dropped usage; a whole card carries neither', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        sessionList([
          sessionSummary({
            id: 'partial-1',
            partial: OVERSIZE_PARTIAL,
            usageRecordsDropped: 2,
          }),
          sessionSummary({ id: 'whole-22' }),
        ]),
      ),
    );
    render(<LiveView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const list = await screen.findByRole('list', { name: 'sessions' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain(BADGE);
    expect(cards[0]!.textContent).toContain(
      '2 usage records could not be deduplicated and were excluded',
    );
    expect(cards[1]!.textContent).not.toContain('partial —');
    expect(cards[1]!.textContent).not.toContain('deduplicated');
  });
});

describe('SessionsView', () => {
  function route(list: unknown, tree: unknown): void {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/tree')) return Promise.resolve(jsonResponse(200, tree));
      if (url.includes('cost-analysis')) {
        return Promise.resolve(jsonResponse(200, costAnalysis()));
      }
      return Promise.resolve(jsonResponse(200, list));
    });
  }

  it('marks the partial session row and its tree totals', async () => {
    route(
      sessionList([sessionSummary({ partial: OVERSIZE_PARTIAL, usageRecordsDropped: 5 })]),
      sessionTree({ partial: OVERSIZE_PARTIAL, usageRecordsDropped: 5 }),
    );
    render(<SessionsView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const list = await screen.findByRole('list', { name: 'session list' });
    expect(list.textContent).toContain(BADGE);
    expect(list.textContent).toContain(
      '5 usage records could not be deduplicated and were excluded',
    );

    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    const honesty = await screen.findByTestId('tree-honesty');
    expect(honesty.textContent).toContain(BADGE);
    expect(honesty.textContent).toContain(
      '5 usage records could not be deduplicated and were excluded',
    );
  });

  it('discloses dropped usage on a whole tree with no partial clause', async () => {
    route(sessionList([sessionSummary()]), sessionTree({ usageRecordsDropped: 1 }));
    render(<SessionsView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    const honesty = await screen.findByTestId('tree-honesty');
    expect(honesty.textContent).toBe('1 usage record could not be deduplicated and was excluded');
  });

  it('says nothing about honesty for a whole session', async () => {
    route(sessionList([sessionSummary()]), sessionTree());
    render(<SessionsView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const list = await screen.findByRole('list', { name: 'session list' });
    expect(list.textContent).not.toContain('partial —');
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    await screen.findByTestId('unattributed');
    expect(screen.queryByTestId('tree-honesty')).toBeNull();
  });

  const TREE_SESSION_ID = sessionTree().sessionId;

  /** Opens the tree panel and returns the chart, which is `role="img"`. */
  async function openTreeChart(): Promise<HTMLElement> {
    render(<SessionsView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    await screen.findByRole('list', { name: 'session list' });
    fireEvent.click(screen.getByRole('button', { name: /agenthropic/ }));
    return screen.findByRole('img', { name: `agent tree for session ${TREE_SESSION_ID}` });
  }

  it('names the honesty line in the description of the tree chart it qualifies', async () => {
    // W-F3. `role="img"` hands a reader the chart's description and nothing
    // around it, so the lower-bound caveat has to be in that description.
    route(sessionList([sessionSummary()]), sessionTree({ partial: OVERSIZE_PARTIAL }));
    const chart = await openTreeChart();
    const honesty = screen.getByTestId('tree-honesty');
    expect(honesty.id).toBe(`tree-honesty-${TREE_SESSION_ID}`);
    // Composed with the chart's own summary, in document order.
    expect(describedByIds(chart)).toEqual([`tree-chart-summary-${TREE_SESSION_ID}`, honesty.id]);
  });

  it('adds the honesty line after the observed outcomes without displacing them', async () => {
    route(
      sessionList([sessionSummary()]),
      sessionTree({
        agents: [agentNode({ outcomeCause: 'user_interrupt' })],
        edges: [],
        usageRecordsDropped: 1,
      }),
    );
    const chart = await openTreeChart();
    const ids = describedByIds(chart);
    expect(ids).toEqual([
      `tree-chart-summary-${TREE_SESSION_ID}`,
      `tree-outcomes-${TREE_SESSION_ID}`,
      `tree-honesty-${TREE_SESSION_ID}`,
    ]);
    expect(document.getElementById(ids[2]!)).toBe(screen.getByTestId('tree-honesty'));
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
  });

  it('names no honesty line in the chart description of a whole tree', async () => {
    route(sessionList([sessionSummary()]), sessionTree());
    const chart = await openTreeChart();
    expect(describedByIds(chart)).toEqual([`tree-chart-summary-${TREE_SESSION_ID}`]);
  });
});

describe('CostView', () => {
  function route(summary: unknown): void {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('cost-analysis')) {
        return Promise.resolve(jsonResponse(200, costAnalysis()));
      }
      if (url.includes('/api/dag/global')) return Promise.resolve(jsonResponse(200, globalDag()));
      if (url.includes('/api/cost/delegation-savings')) {
        return Promise.resolve(jsonResponse(200, aggregateSavings()));
      }
      return Promise.resolve(jsonResponse(200, summary));
    });
  }

  it('states the partial-session and dropped-usage aggregates and marks the partial row', async () => {
    route(
      costSummary({
        totals: { tokens: 3000, costUsd: 3, unpricedTokens: 0 },
        topSessions: [
          sessionCost({
            sessionId: 'partial-1',
            costUsd: 2,
            tokens: 2000,
            partial: OVERSIZE_PARTIAL,
            usageRecordsDropped: 1,
          }),
          sessionCost({ sessionId: 'whole-22', costUsd: 1 }),
        ],
        partialSessions: 1,
        usageRecordsDropped: 4,
      }),
    );
    render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const note = await screen.findByTestId('cost-honesty');
    expect(note.textContent).toContain('Includes 1 partial session (lower bound).');
    expect(note.textContent).toContain(
      '4 usage records could not be deduplicated and were excluded',
    );

    const table = screen.getByRole('table', { name: 'top sessions by cost' });
    const rows = within(table).getAllByRole('row');
    // header + two sessions
    expect(rows[1]!.textContent).toContain(BADGE);
    expect(rows[1]!.textContent).toContain(
      '1 usage record could not be deduplicated and was excluded',
    );
    expect(rows[2]!.textContent).not.toContain('partial —');
  });

  it('states dropped usage alone when no session is partial', async () => {
    route(
      costSummary({
        totals: { tokens: 1000, costUsd: 1, unpricedTokens: 0 },
        topSessions: [sessionCost()],
        usageRecordsDropped: 2,
      }),
    );
    render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const note = await screen.findByTestId('cost-honesty');
    expect(note.textContent).toBe('2 usage records could not be deduplicated and were excluded');
  });

  it('names unreadable honesty counts instead of pointing every description at NaN (W-3, 2026-10-12)', async () => {
    // `!== 0` is true of NaN, so the note rendered - and every
    // `aria-describedby` on the page sent a reader to "Includes NaN partial
    // sessions (lower bound). NaN usage records could not be deduplicated".
    route(
      costSummary({
        totals: { tokens: 1000, costUsd: 1, unpricedTokens: 0 },
        topSessions: [sessionCost()],
        partialSessions: Number.NaN,
        usageRecordsDropped: Number.POSITIVE_INFINITY,
      }),
    );
    render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const note = await screen.findByTestId('cost-honesty');
    expect(note.textContent).toContain('The partial-session count came back as unreadable');
    expect(note.textContent).toContain('The dropped-usage count came back as unreadable');
    expect(note.textContent).not.toContain('NaN');
    expect(note.textContent).not.toContain('Infinity');
  });

  it('prints no honesty note when every session is whole and nothing was dropped', async () => {
    route(
      costSummary({
        totals: { tokens: 1000, costUsd: 1, unpricedTokens: 0 },
        topSessions: [sessionCost()],
      }),
    );
    render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    await screen.findByRole('table', { name: 'top sessions by cost' });
    expect(screen.queryByTestId('cost-honesty')).toBeNull();
  });

  /** A summary with a drawable flow and every table populated. */
  function fullSummary(overrides: Parameters<typeof costSummary>[0] = {}) {
    return costSummary({
      totals: { tokens: 3000, costUsd: 3, unpricedTokens: 0 },
      perModel: [{ model: 'claude-a', tokens: 3000, costUsd: 3, unpricedTokens: 0 }],
      perDay: [{ day: '2026-07-29', tokens: 3000, costUsd: 3, unpricedTokens: 0 }],
      topSessions: [sessionCost({ costUsd: 2, tokens: 2000 })],
      ...overrides,
    });
  }

  it('puts the honesty note beside the totals, above every breakdown it qualifies', async () => {
    // W-F2. The note speaks for every total on the page, yet it sat under
    // "Top sessions", below the totals, the windows, the flow and two tables
    // it qualifies - a reader had passed every figure before meeting it.
    route(fullSummary({ partialSessions: 1 }));
    render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const note = await screen.findByTestId('cost-honesty');
    expect(follows(screen.getByLabelText('totals'), note)).toBe(true);
    expect(follows(note, screen.getByLabelText('recent windows'))).toBe(true);
    expect(follows(note, screen.getByRole('heading', { name: 'Top sessions' }))).toBe(true);
  });

  it('names the honesty note as the description of the figures it qualifies', async () => {
    // W-F2. A reader who jumps to the totals, the diagram or a table never
    // passes the prose between them, so each one names the note itself.
    route(fullSummary({ partialSessions: 1, usageRecordsDropped: 4 }));
    render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const note = await screen.findByTestId('cost-honesty');
    expect(note.id).toBe('cost-honesty');

    expect(describedByIds(screen.getByRole('group', { name: 'totals' }))).toEqual([note.id]);
    expect(describedByIds(screen.getByRole('group', { name: 'recent windows' }))).toEqual([
      note.id,
    ]);
    // Composed with the diagram's own description, in document order: the note
    // is above the diagram, the flow summary below it.
    const flow = screen.getByRole('img', { name: 'cost flow from models to sessions' });
    expect(describedByIds(flow)).toEqual([note.id, 'cost-flow-summary']);
    for (const id of describedByIds(flow)) expect(document.getElementById(id)).not.toBeNull();
    for (const name of ['cost per model', 'cost per day', 'top sessions by cost']) {
      expect(describedByIds(screen.getByRole('table', { name }))).toEqual([note.id]);
    }
  });

  it('names no honesty note when none is rendered', async () => {
    // A dangling idref is a caveat that silently disappears, so the id is
    // listed only while its paragraph exists.
    route(fullSummary());
    render(<CostView token="secret-token" sse={sse} onAuthRejected={onAuthRejected} />);
    const flow = await screen.findByRole('img', { name: 'cost flow from models to sessions' });
    expect(screen.queryByTestId('cost-honesty')).toBeNull();
    expect(describedByIds(flow)).toEqual(['cost-flow-summary']);
    expect(screen.getByRole('group', { name: 'totals' }).hasAttribute('aria-describedby')).toBe(
      false,
    );
    expect(
      screen.getByRole('group', { name: 'recent windows' }).hasAttribute('aria-describedby'),
    ).toBe(false);
    for (const name of ['cost per model', 'cost per day', 'top sessions by cost']) {
      expect(screen.getByRole('table', { name }).hasAttribute('aria-describedby')).toBe(false);
    }
  });
});
