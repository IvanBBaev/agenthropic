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

  it('shows a negative count rather than swallowing it', () => {
    const { container } = render(<DroppedUsageNote count={-1} lead="" />);
    expect(container.textContent).toBe(
      '-1 usage records could not be deduplicated and were excluded',
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
});
