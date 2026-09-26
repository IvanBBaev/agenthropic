/**
 * A3 (2026-09-23). The one place that says how much usage sits OUTSIDE a
 * dollar figure.
 *
 * Five render sites - the live cards, the session rows, the unattributed line
 * and the two chart hover titles - each gated their unpriced clause on
 * `unpricedTokens > 0`. `dto-guards.ts` validates shape, not sanity (its own
 * docblock says so), so an `unpricedTokens` that arrives `NaN` or `Infinity`
 * reaches the view intact, fails `> 0` exactly as a measured zero does, and
 * the clause disappears. The only signal any of these five carries about
 * unpriced usage is the PRESENCE of the clause, so its absence reads as "every
 * token behind this figure is priced" - the dollar amount beside it looks
 * complete precisely when nobody can say whether it is.
 *
 * `chart-summary.ts` (CS-2), `flowNodeTitle` (CV-3) and the Total cost tile
 * (CV-4) each removed this test from one site. These are the sites they did
 * not reach, and they now share the code rather than the pattern, so the next
 * site cannot drift away from the other four.
 *
 * The unreadable wording reuses `formatTokens` instead of inventing a phrase:
 * "tokens unreadable" is already what this app says about a count it cannot
 * read, and a second vocabulary for one fact is a third thing to learn.
 *
 * Zero is the only value with nothing to disclose, so it - and not "anything
 * not positive" - is the silent case, matching `UnpricedCell` in CostView.tsx.
 * A negative count is as impossible as a NaN one and is shown rather than
 * swallowed.
 */
import { formatTokens } from '../format';

/**
 * The clause for a hover `<title>`, ready to concatenate onto the figure it
 * qualifies. `''` only when the count is a measured zero.
 */
export function unpricedTitleSuffix(tokens: number): string {
  if (!Number.isFinite(tokens)) return `, unpriced: ${formatTokens(tokens)}`;
  return tokens === 0 ? '' : `, ~${formatTokens(tokens)} unpriced`;
}

/**
 * The same clause as a rendered node. `lead` is whatever separates it from the
 * figure it qualifies at this call site (nothing in a metrics row, ` · ` in a
 * run of inline facts). It is a required prop rather than a defaulted one
 * because the separator belongs to the line being joined, not to this module -
 * and because a default arm is an arm the coverage gate would have to reach.
 */
export function UnpricedNote({ tokens, lead }: { readonly tokens: number; readonly lead: string }) {
  if (!Number.isFinite(tokens)) {
    return (
      <span className="unpriced">
        {lead}unpriced: {formatTokens(tokens)}
      </span>
    );
  }
  if (tokens === 0) return null;
  return (
    <span className="unpriced">
      {lead}~ {formatTokens(tokens)} unpriced
    </span>
  );
}
