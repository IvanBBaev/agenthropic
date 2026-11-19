/**
 * UX-19 - USD columns in the dense tables show cents only, so the decimal
 * points line up; a non-zero sub-cent amount shows `<$0.01` and keeps its
 * precise figure in the cell's title.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { UNREADABLE_USD } from '../src/format';
import { createSseClient, type SseClient } from '../src/sse';
import { CostView } from '../src/views/CostView';
import { UsdCell } from '../src/views/UsdCell';
import {
  aggregateSavings,
  changes,
  costAnalysis,
  costSummary,
  globalDag,
  jsonResponse,
} from './fixtures';
import { MockEventSource } from './mock-event-source';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCell(costUsd: number, prefix?: string): HTMLElement {
  render(
    <table>
      <tbody>
        <tr>
          <UsdCell costUsd={costUsd} prefix={prefix} />
        </tr>
      </tbody>
    </table>,
  );
  return screen.getByRole('cell');
}

describe('UsdCell (UX-19)', () => {
  it('shows cents with no title when cents are the precise figure', () => {
    const cell = renderCell(1.41);
    expect(cell.textContent).toBe('$1.41');
    expect(cell.className).toBe('num');
    expect(cell.hasAttribute('title')).toBe(false);
  });

  it('shows <$0.01 for a sub-cent amount and puts the real figure in the title', () => {
    const cell = renderCell(0.0043);
    expect(cell.textContent).toBe('<$0.01');
    expect(cell.getAttribute('title')).toBe('$0.0043');
  });

  it('carries an estimate marker into both the cell and its title', () => {
    const cell = renderCell(-0.0043, '~ ');
    expect(cell.textContent).toBe('~ >-$0.01');
    expect(cell.getAttribute('title')).toBe('~ $-0.0043');
  });

  it('adds no title to the honest zero or to an unreadable figure', () => {
    expect(renderCell(0).hasAttribute('title')).toBe(false);
    cleanup();
    const unreadable = renderCell(Number.NaN);
    expect(unreadable.textContent).toBe(UNREADABLE_USD);
    expect(unreadable.hasAttribute('title')).toBe(false);
  });
});

describe('the cost tables (UX-19)', () => {
  let sse: SseClient;

  beforeEach(() => {
    MockEventSource.reset();
    vi.stubGlobal('EventSource', MockEventSource);
    sse = createSseClient('secret-token');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/changes')) return Promise.resolve(jsonResponse(200, changes()));
        if (url.includes('cost-analysis')) {
          return Promise.resolve(jsonResponse(200, costAnalysis()));
        }
        if (url.includes('/api/dag/global')) {
          return Promise.resolve(jsonResponse(200, globalDag()));
        }
        if (url.includes('/api/cost/delegation-savings')) {
          return Promise.resolve(jsonResponse(200, aggregateSavings()));
        }
        return Promise.resolve(
          jsonResponse(
            200,
            costSummary({
              totals: { tokens: 3000, costUsd: 1.4143, unpricedTokens: 0 },
              perModel: [
                { model: 'claude-opus-4', tokens: 2000, costUsd: 1.41, unpricedTokens: 0 },
                { model: 'claude-haiku-3', tokens: 1000, costUsd: 0.0043, unpricedTokens: 0 },
              ],
            }),
          ),
        );
      }),
    );
  });

  it('aligns a sub-cent row with a dollar row in the per-model table', async () => {
    render(<CostView token="secret-token" sse={sse} onAuthRejected={vi.fn()} />);
    const table = await screen.findByRole('table', { name: 'cost per model' });
    const cells = within(table)
      .getAllByRole('cell')
      .filter((cell) => cell.textContent?.includes('$'));
    expect(cells.map((cell) => cell.textContent)).toEqual(['$1.41', '<$0.01']);
    expect(cells[1]?.getAttribute('title')).toBe('$0.0043');
  });
});
