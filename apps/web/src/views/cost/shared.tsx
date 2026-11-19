/**
 * Constants and small helpers shared by the cost view's panels. Split out of
 * CostView.tsx in UX-16 (2026-11-19); the page-level docblock stays there.
 */
import { formatTokens } from '../../format';

/**
 * Label of the re-read control (KK3). A constant because the "not measured"
 * tile names it in prose, and the two must not drift apart.
 */
export const REFRESH_LABEL = 'Refresh costs';

/** Top-N sessions requested from the summary endpoint. */
export const COST_TOP_N = 5;

/** Rows shown in the top-burners table. PROVISIONAL - enough for "who burned
 * the most?" without turning the table into a second DAG view. */
export const TOP_BURNERS_N = 10;

/**
 * Node cap for the burners' DAG fetch (same figure as the DAG view's cap).
 * PROVISIONAL. The server slices by RECENCY, not by burn, so when it
 * truncates, the true biggest burner may sit outside the returned slice -
 * the table carries a banner saying exactly that instead of pretending the
 * ranking is global.
 */
export const TOP_BURNERS_NODE_LIMIT = 1000;

/**
 * Id of the partial-sessions / dropped-usage / unreadable-line note under the
 * totals row. It qualifies every total on the page, so each group, table and
 * figure that prints one names it (F-18) - and only while it is rendered.
 */
export const COST_HONESTY_ID = 'cost-honesty';

/**
 * A dollar difference small enough that both sides of it print identically.
 * The same 1e-4 the layout balances the diagram with, and the same scale as
 * `formatUsd`'s four-decimal floor: below it a notice announcing a gap would
 * quote two figures the reader cannot tell apart.
 */
export const USD_EPSILON = 1e-4;

/** `1 session` / `2 sessions`. One branch, reused by all the scope copy. */
export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** Unpriced cell: an explicit `~ n` marker, or a plain zero - never blank. */
export function UnpricedCell({ tokens }: { readonly tokens: number }) {
  if (tokens === 0) return <td className="num muted">0</td>;
  return <td className="num unpriced">~ {formatTokens(tokens)}</td>;
}
