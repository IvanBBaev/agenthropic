/**
 * (d) Cost view (WP-U9): totals, per-model and per-day breakdowns, top
 * sessions, and a sankey of dollar flows (model -> all cost -> session).
 * Every dollar figure is server-side ground truth (tokens x dated price);
 * `unpricedTokens` is an honest gap and is surfaced EVERYWHERE it appears -
 * as its own headline tile, as a column in every table, and as a note on
 * flow nodes - never hidden, never rendered as $0.
 */
import { useEffect, useState } from 'react';
import { fetchCostSummary } from '../api';
import type { CostSummaryDto } from '../dto';
import { formatTokens, formatUsd, shortId } from '../format';
import { computeCostFlow, type FlowNode } from './layout/cost-flow';
import type { ViewProps } from './types';

/** Top-N sessions requested from the summary endpoint. */
export const COST_TOP_N = 5;

type CostState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly summary: CostSummaryDto };

function flowNodeClass(node: FlowNode): string {
  return node.colorIndex !== null ? `flow-node cat-${node.colorIndex}` : 'flow-node flow-neutral';
}

/** Unpriced cell: an explicit `~ n` marker, or a plain zero - never blank. */
function UnpricedCell({ tokens }: { readonly tokens: number }) {
  if (tokens === 0) return <td className="num muted">0</td>;
  return <td className="num unpriced">~ {formatTokens(tokens)}</td>;
}

export function CostView({ token, onAuthRejected }: ViewProps) {
  const [state, setState] = useState<CostState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void fetchCostSummary(token, COST_TOP_N, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setState({ kind: 'error', message: result.message });
      } else {
        setState({ kind: 'ready', summary: result.data });
      }
    });
    return () => controller.abort();
  }, [token, onAuthRejected]);

  if (state.kind === 'loading') {
    return (
      <section aria-label="cost summary">
        <p className="muted">Loading cost summary…</p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section aria-label="cost summary">
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load cost summary: {state.message}
        </p>
      </section>
    );
  }

  const { summary } = state;
  const flow = computeCostFlow(summary);
  const maxDailyCost = Math.max(0, ...summary.perDay.map((day) => day.costUsd));

  return (
    <section aria-label="cost summary">
      <div className="kpis" aria-label="totals">
        <div className="kpi">
          <span className="kpi-label">Total cost</span>
          <span className="kpi-value">{formatUsd(summary.totals.costUsd)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Total tokens</span>
          <span className="kpi-value">{formatTokens(summary.totals.tokens)}</span>
        </div>
        <div className="kpi" data-testid="kpi-unpriced">
          <span className="kpi-label">Unpriced tokens</span>
          <span className={summary.totals.unpricedTokens > 0 ? 'kpi-value unpriced' : 'kpi-value'}>
            {formatTokens(summary.totals.unpricedTokens)}
          </span>
          {summary.totals.unpricedTokens > 0 && (
            <span className="muted kpi-note">no price row matched - not counted in $</span>
          )}
        </div>
      </div>

      <h2>Cost flow</h2>
      {flow.hasFlow ? (
        <>
          <div className="chart-scroll">
            <svg
              role="img"
              aria-label="cost flow from models to sessions"
              width={flow.width}
              height={flow.height}
              viewBox={`0 0 ${String(flow.width)} ${String(flow.height)}`}
            >
              {flow.links.map((link) => (
                <path
                  key={`${link.sourceId}->${link.targetId}`}
                  className={
                    link.colorIndex !== null
                      ? `flow-link cat-${link.colorIndex}`
                      : 'flow-link flow-neutral'
                  }
                  d={link.path}
                  strokeWidth={link.width}
                >
                  <title>{`${link.sourceId} -> ${link.targetId}: ${formatUsd(link.value)}`}</title>
                </path>
              ))}
              {flow.nodes.map((node) => (
                <g key={node.id} className={flowNodeClass(node)}>
                  <title>
                    {`${node.label}: ${formatUsd(node.value)}${node.unpricedTokens > 0 ? ` (+ ~${formatTokens(node.unpricedTokens)} unpriced tokens)` : ''}`}
                  </title>
                  <rect
                    x={node.x0}
                    y={node.y0}
                    width={node.x1 - node.x0}
                    height={Math.max(1, node.y1 - node.y0)}
                    fill="currentColor"
                  />
                  <text
                    className="node-label"
                    x={
                      node.kind === 'model' || node.kind === 'other-models'
                        ? node.x1 + 6
                        : node.x0 - 6
                    }
                    y={(node.y0 + node.y1) / 2 + 4}
                    textAnchor={
                      node.kind === 'model' || node.kind === 'other-models' ? 'start' : 'end'
                    }
                  >
                    {node.kind === 'session' ? shortId(node.label) : node.label}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <ul className="chart-legend" aria-label="model legend">
            {flow.nodes
              .filter((node) => node.kind === 'model' || node.kind === 'other-models')
              .map((node) => (
                <li key={node.id}>
                  <span className={flowNodeClass(node)} aria-hidden="true">
                    ■
                  </span>{' '}
                  {node.label}
                </li>
              ))}
          </ul>
        </>
      ) : (
        <p className="empty-state">
          Nothing priced yet - no dollar flow to draw. Token usage may still exist as unpriced
          tokens (see the tables below).
        </p>
      )}
      {flow.zeroCostModels.length > 0 && (
        <p className="muted" data-testid="zero-cost-models">
          Not in the flow (usage but $0 priced): {flow.zeroCostModels.join(', ')}.
        </p>
      )}

      <h2>Per model</h2>
      {summary.perModel.length === 0 ? (
        <p className="empty-state">No per-model usage recorded yet.</p>
      ) : (
        <table className="data-table" aria-label="cost per model">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Unpriced</th>
            </tr>
          </thead>
          <tbody>
            {summary.perModel.map((model) => (
              <tr key={model.model}>
                <td>{model.model}</td>
                <td className="num">{formatTokens(model.tokens)}</td>
                <td className="num">{formatUsd(model.costUsd)}</td>
                <UnpricedCell tokens={model.unpricedTokens} />
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Per day</h2>
      {summary.perDay.length === 0 ? (
        <p className="empty-state">No daily usage recorded yet.</p>
      ) : (
        <table className="data-table" aria-label="cost per day">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Unpriced</th>
              <th aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {summary.perDay.map((day) => (
              <tr key={day.day}>
                <td className={day.day === 'unknown' ? 'muted' : undefined}>{day.day}</td>
                <td className="num">{formatTokens(day.tokens)}</td>
                <td className="num">{formatUsd(day.costUsd)}</td>
                <UnpricedCell tokens={day.unpricedTokens} />
                <td className="bar-cell" aria-hidden="true">
                  <span
                    className="bar-fill"
                    style={{
                      width:
                        maxDailyCost > 0 ? `${String((day.costUsd / maxDailyCost) * 100)}%` : '0%',
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Top sessions</h2>
      {summary.topSessions.length === 0 ? (
        <p className="empty-state">No sessions recorded yet.</p>
      ) : (
        <table className="data-table" aria-label="top sessions by cost">
          <thead>
            <tr>
              <th>Session</th>
              <th>Project</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Unpriced</th>
            </tr>
          </thead>
          <tbody>
            {summary.topSessions.map((session) => (
              <tr key={session.sessionId}>
                <td>
                  <code>{shortId(session.sessionId)}</code>
                </td>
                <td className={session.projectSlug === null ? 'muted' : undefined}>
                  {session.projectSlug ?? 'no project'}
                </td>
                <td className="num">{formatTokens(session.tokens)}</td>
                <td className="num">{formatUsd(session.costUsd)}</td>
                <UnpricedCell tokens={session.unpricedTokens} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
