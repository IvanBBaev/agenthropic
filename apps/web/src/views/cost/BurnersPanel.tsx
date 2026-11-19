/**
 * The cost view's "top agent burners" table (M-8). Split out of CostView.tsx
 * in UX-16 (2026-11-19).
 */
import type { GlobalDagDto } from '../../dto';
import { agentTypeLabel, formatTokens, shortId } from '../../format';
import { UsdCell } from '../UsdCell';
import { rankTopBurners } from '../top-burners';
import { TOP_BURNERS_N, TOP_BURNERS_NODE_LIMIT, UnpricedCell } from './shared';

// The burners table has its own state machine: it rides a second endpoint
// (/api/dag/global), and a failure there must degrade ONE section, not take
// the whole cost view down with it.
export type BurnersState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly dag: GlobalDagDto };

/**
 * The M-8 burners table. Ranks the served DAG nodes by token burn (see
 * top-burners.ts for the key and why), and states its own scope out loud:
 * how many agents are ranked, how many were excluded for zero usage, and -
 * when the server truncated by recency - that the ranking covers a slice.
 */
function BurnersPanel({ dag }: { readonly dag: GlobalDagDto }) {
  const ranking = rankTopBurners(dag.nodes, TOP_BURNERS_N);
  // AMENDED 2026-09-02 (F-6). The truncation banner used to live INSIDE the
  // ranked branch, below an early return for `rankedCount === 0`. The
  // reasoning was tidy - no ranking, nothing to qualify - and it inverted the
  // disclosure exactly where it mattered most: when the server returns a
  // recency slice in which nothing happens to carry tokens, the page dropped
  // the "this is a slice" warning and printed the confident global claim "No
  // agent has recorded token usage yet" over a corpus it had not seen. The
  // banner is now hoisted above every branch (the DAG view's own ordering),
  // and the empty copy no longer speaks for agents outside the slice.
  // KK2 (2026-09-25). DagView's A4 check, mirrored: the flag is a claim about
  // the answer and the node array IS the answer, so when they disagree the
  // ranking is a slice whether or not the server said so. Without this a
  // payload of 5 nodes counting 1200 agents printed "All 5 agents with
  // recorded usage." - completeness nobody measured.
  const countsDisagree = dag.nodes.length !== dag.counts.totalAgents;
  const partial = dag.counts.truncated || countsDisagree;
  const truncationNotice = dag.counts.truncated ? (
    <p className="truncation-banner" data-testid="burners-truncation">
      The server returned the {dag.counts.returnedAgents} most recently active of{' '}
      {dag.counts.totalAgents} agents (node limit {TOP_BURNERS_NODE_LIMIT}), so this ranking covers
      that slice only - an older agent may have burned more.
    </p>
  ) : countsDisagree ? (
    <p className="truncation-banner" data-testid="burners-count-disagreement">
      {dag.nodes.length} of the {dag.counts.totalAgents} agents this same read counts were returned,
      and the answer was not marked truncated - the returned list and the served count disagree, so
      this ranking covers a slice of unknown size.
    </p>
  ) : null;
  if (ranking.rankedCount === 0) {
    return (
      <>
        {truncationNotice}
        <p className="empty-state" data-testid="burners-empty">
          {partial
            ? 'No agent in the returned slice has a recorded token count. That is a statement about the slice above, not about the agents outside it.'
            : 'No agent has a recorded token count yet. Usage unattributed to any persisted agent is outside this ranking either way.'}
        </p>
      </>
    );
  }
  return (
    <>
      {truncationNotice}
      <p className="muted" data-testid="burners-scope">
        {ranking.entries.length < ranking.rankedCount
          ? `Top ${String(ranking.entries.length)} of ${String(ranking.rankedCount)} agents with recorded usage${partial ? ' in the returned slice' : ''}.`
          : `${partial ? '' : 'All '}${String(ranking.rankedCount)} agent${ranking.rankedCount === 1 ? '' : 's'} with recorded usage${partial ? ' in the returned slice' : ''}.`}{' '}
        {ranking.zeroUsageCount > 0 &&
          `Not ranked: ${String(ranking.zeroUsageCount)} agent${ranking.zeroUsageCount === 1 ? '' : 's'} with zero recorded tokens. `}
        {/*
          CA-6 (2026-09-03). Kept as its own sentence rather than added to the
          count above it. "We measured nothing" and "we cannot read what we
          measured" are different facts, and only the first is a statement
          about the agent: the second is a statement about our own figure.
          Summing them would let a parse failure be read as an idle agent.
        */}
        {ranking.unreadableUsageCount > 0 &&
          `Not ranked: ${String(ranking.unreadableUsageCount)} agent${ranking.unreadableUsageCount === 1 ? '' : 's'} whose recorded token count could not be read - that is a gap in our figure, not a measured zero. `}
        Usage unattributed to any persisted agent is outside this ranking.
      </p>
      <table className="data-table" aria-label="top agents by token burn">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Agent</th>
            <th>Session</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
            <th className="num">Unpriced</th>
          </tr>
        </thead>
        <tbody>
          {ranking.entries.map((agent, index) => (
            <tr key={agent.id}>
              <td className="num">{index + 1}</td>
              <td>
                {agentTypeLabel(agent.subagentType, agent.type)} <code>{shortId(agent.id)}</code>
              </td>
              <td>
                <code>{shortId(agent.sessionId)}</code>
              </td>
              <td className="num">{formatTokens(agent.totalTokens)}</td>
              <UsdCell costUsd={agent.costUsd} />
              <UnpricedCell tokens={agent.unpricedTokens} />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** The "Top agent burners" section, in each state of its read. */
export function BurnersSection({ burners }: { readonly burners: BurnersState }) {
  return (
    <>
      <h2>Top agent burners</h2>
      {burners.kind === 'loading' && <p className="muted">Loading agent burners…</p>}
      {burners.kind === 'error' && (
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load agent burners: {burners.message}
        </p>
      )}
      {burners.kind === 'ready' && <BurnersPanel dag={burners.dag} />}
    </>
  );
}
