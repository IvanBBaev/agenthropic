/**
 * The edge-provenance vocabulary shared by the two graph views (WP-U7/U8) and
 * by their text alternative. It is to `source` what `status.ts` is to
 * `status`: one place that decides what a served word means on screen, so two
 * pictures and one paragraph cannot answer the question differently.
 *
 * WHY IT EXISTS (2026-09-23, lane-EP). `dto-guards.ts` deliberately does not
 * check enum membership, and names three fields it exempts - `status`,
 * `source`, `outcomeCause` - on the stated grounds that "the views already
 * funnel an unrecognised value into an explicit bucket". That was true of two
 * of the three. `status` has `statusMeta` and `outcomeCause` has
 * `outcomeCauseText`, and both answer with `unrecognised (...)` for a word
 * they do not know and for a value that is not a word at all. `source` had
 * neither. Four sites asked `source === 'tool_use'` and sent everything else
 * down the `inferred` arm:
 *
 *   - both graph views drew the edge dashed and titled it `inferred (<raw>)`;
 *   - `chart-summary` counted it into "N inferred" and listed its raw word
 *     inside the inferred parenthetical;
 *   - and both legends explained the dashed stroke by ENUMERATING the four
 *     inferred sources - a closed list that, by construction, did not contain
 *     the word the reader was looking at.
 *
 * So the page named a join path the server had not claimed. `inferred
 * (directory)` says the parent-child link was derived from a working-directory
 * match; `inferred (mcp_spawn)` said the link was derived, full stop, on the
 * sole evidence that the word was not `tool_use`. This build cannot know that.
 * A source it has never heard of might be a NEW OBSERVATION - a future
 * structural join at least as good as `tool_use` - and calling it inferred
 * would then understate the graph rather than overstate it. Either way the
 * claim is the client's, not the server's, and that is the one thing the
 * provenance channel exists to prevent.
 *
 * The same branch also produced the two renderings this codebase has removed
 * twice already: a `source` field the server stopped sending showed as
 * `inferred (undefined)` (the sentence SV-3 took out of `statusMeta`), and an
 * empty one showed as `inferred ()` (the parenthesis lane-P took out of
 * `unrecognisedStatusMeta`). Both are answered here the way those two answer
 * them, in their words, so a reader learns the convention once.
 */
import type { OrchestrationEdgeSource } from '../dto';
import { quoteRawValue } from '../format';
import { UNRECOGNISED_STATUS_LABEL } from './status';

/**
 * The one source that is an OBSERVATION: the parent's own `tool_use` block
 * named the child. Typed against the schema union, so renaming the literal in
 * `@agenthropic/shared` fails this build rather than silently turning every
 * observed edge into an unrecognised one.
 */
export const OBSERVED_EDGE_SOURCE: OrchestrationEdgeSource = 'tool_use';

/**
 * Every source the server can persist, mirroring `OrchestrationEdgeSourceSchema`.
 * Written out rather than derived because the schema is a TypeBox value: the
 * annotation is what makes a rename a build error, and the list is what makes
 * the legend a generated string instead of a hand-kept copy of one.
 */
export const EDGE_SOURCES: readonly OrchestrationEdgeSource[] = [
  'tool_use',
  'directory',
  'task_notification',
  'queue_operation',
  'legacy_explore',
];

/**
 * The join paths that are DERIVED rather than observed - the list the legend
 * enumerates. Filtered from `EDGE_SOURCES` rather than typed a second time,
 * because a legend that enumerates its own copy of a set is a second source of
 * truth for it, and the two drift apart the first time either is edited.
 */
export const INFERRED_EDGE_SOURCES: readonly OrchestrationEdgeSource[] = EDGE_SOURCES.filter(
  (source) => source !== OBSERVED_EDGE_SOURCE,
);

/**
 * No source WORD arrived at all: the field was absent from the payload, or
 * carried something that is not a string. Phrased as `ABSENT_STATUS_REASON`
 * and `ABSENT_OUTCOME_CAUSE_REASON` phrase their own, and exported for the
 * same reason they are - the legend quotes this constant instead of retyping
 * the sentence it explains.
 */
export const ABSENT_EDGE_SOURCE_REASON = 'no source word sent';

/**
 * The three things this build can truthfully say about an edge's provenance.
 *
 * `unrecognised` is spelled from `status.ts`'s constant rather than as its own
 * literal: it is the same claim about the same kind of failure - this build
 * cannot map what arrived onto its vocabulary - and one word for it across the
 * whole UI is what lets the shell legend explain it once.
 */
export type EdgeProvenanceKind = 'observed' | 'inferred' | typeof UNRECOGNISED_STATUS_LABEL;

export interface EdgeProvenance {
  readonly kind: EdgeProvenanceKind;
  /** The parenthetical: the source word, or the stated reason there is none. */
  readonly detail: string;
  /** Stroke class - the colour-independent channel, as the symbol is for status. */
  readonly className: string;
  /** `<title>` text. Built from the two fields above so it cannot disagree with them. */
  readonly title: string;
}

function provenance(kind: EdgeProvenanceKind, detail: string, className: string): EdgeProvenance {
  return { kind, detail, className, title: `${kind} (${detail})` };
}

/**
 * What this build can say about one served `source`.
 *
 * The parameter is `unknown` and not `OrchestrationEdgeSource` for the reason
 * `statusMeta`'s is: the static type is a claim about the wire contract, not a
 * runtime guarantee, and `dto-guards.ts` checks neither this field's membership
 * nor that it is a string at all.
 */
export function edgeProvenance(source: unknown): EdgeProvenance {
  if (source === OBSERVED_EDGE_SOURCE) {
    return provenance('observed', OBSERVED_EDGE_SOURCE, 'edge edge-observed');
  }
  if (typeof source !== 'string') {
    return provenance(
      UNRECOGNISED_STATUS_LABEL,
      ABSENT_EDGE_SOURCE_REASON,
      'edge edge-unrecognised',
    );
  }
  if ((INFERRED_EDGE_SOURCES as readonly string[]).includes(source)) {
    return provenance('inferred', source, 'edge edge-inferred');
  }
  // Not `inferred`: naming a derivation for a word this build has never read
  // would be the client asserting how the server joined two agents.
  return provenance(UNRECOGNISED_STATUS_LABEL, quoteRawValue(source), 'edge edge-unrecognised');
}

/**
 * The edge legend, generated from the constants above.
 *
 * `status.ts`'s rule, applied to the one channel edges have: the stroke, never
 * the colour, is what tells two provenances apart - so the third state gets a
 * third stroke (dotted) rather than a shade of the second. The rule the shell
 * legend keeps applies here too: never draw a stroke the legend does not
 * explain, which is why this string is computed from the same list
 * `edgeProvenance` routes on instead of being written beside it.
 */
export const EDGE_PROVENANCE_LEGEND = [
  `— observed (${OBSERVED_EDGE_SOURCE})`,
  `┄ inferred (${INFERRED_EDGE_SOURCES.join(', ')})`,
  `⋯ ${UNRECOGNISED_STATUS_LABEL} (the raw word in quotes, or "${ABSENT_EDGE_SOURCE_REASON}")`,
].join(' ');
