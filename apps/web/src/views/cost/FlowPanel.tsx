/**
 * The cost view's sankey (model -> all cost -> session), with the balance and
 * undrawable notices above it and the prose text alternative below it. Split
 * out of CostView.tsx in UX-16 (2026-11-19).
 */
import type { CostSummaryDto } from '../../dto';
import { formatTokens, formatUsd } from '../../format';
import {
  describeCostFlow,
  hubImbalanceNote,
  impossibleUnpricedText,
  isImpossibleUnpriced,
} from '../chart-summary';
import { computeCostFlow, type CostFlowLayout, type FlowNode } from '../layout/cost-flow';
import { COST_HONESTY_ID } from './shared';

/**
 * Id of the prose text alternative for the sankey. role="img" hides the SVG
 * subtree (its <title> elements included) from assistive tech, so the same
 * facts are published as visible prose and referenced with aria-describedby.
 */
const FLOW_SUMMARY_ID = 'cost-flow-summary';

/**
 * Ids of the two notices ABOVE the diagram, so they can be named as part of
 * its description (F-18).
 */
const FLOW_BALANCE_ID = 'cost-flow-balance';
const FLOW_UNDRAWABLE_ID = 'cost-flow-undrawable';

/**
 * What describes the sankey, in document order (F-18).
 *
 * The two notices are ordinary prose above the picture, so a reader going
 * down the page meets them before it. A reader who reaches the picture as a
 * picture - jumped to by image, or handed it by a screen reader that reads
 * `role="img"` and its description and nothing of the subtree - met only
 * `describeCostFlow`, which enumerates a confident, self-consistent flow and
 * has no idea the numbers behind it fail to reconcile or that a served cost
 * was left out of the drawing entirely. That is the honesty gap exactly
 * inverted: the reader with the least context got the most confident text.
 *
 * `aria-describedby` takes a LIST, so the fix is to name the notices rather
 * than to restate them. Restating would have put the same paragraph on screen
 * twice for a sighted reader, and two copies of a caveat that can drift apart
 * are worse than one.
 *
 * The page-wide honesty note is first because it is first on the page, and it
 * is listed only when the caller rendered it.
 */
function flowDescribedBy(flow: CostFlowLayout, hasCostHonesty: boolean): string {
  const ids: string[] = [];
  if (hasCostHonesty) ids.push(COST_HONESTY_ID);
  if (!flow.balance.balanced) ids.push(FLOW_BALANCE_ID);
  if (flow.undrawable.length > 0) ids.push(FLOW_UNDRAWABLE_ID);
  ids.push(FLOW_SUMMARY_ID);
  return ids.join(' ');
}

function flowNodeClass(node: FlowNode): string {
  return node.colorIndex !== null ? `flow-node cat-${node.colorIndex}` : 'flow-node flow-neutral';
}

/**
 * CV-2 (2026-09-08), AMENDED 2026-09-09 (CF-2). The hub's hover figure is
 * d3-sankey's `node.value`, which is the LARGER of the node's two sides when
 * they disagree, and the hub's two sides are served independently. The note
 * that states both sides and the gap between them used to be built here and
 * appended by this view; it now lives with the prose summary in
 * chart-summary.ts, for the reason CS-4 records there - a qualification kept
 * by the call site is a convention, not a property of the string, and the next
 * caller inherits the confident sentence without it. The full account of the
 * defect, of what was deliberately NOT changed (the max() itself), and of what
 * CF-2 closed at the source is in the docblock over `hubImbalanceNote`.
 *
 * This view still calls it for the hover, so the picture and its prose
 * alternative remain one string.
 */

/**
 * The hover text of one flow node: its label, its dollar figure, the unpriced
 * tokens sitting behind that figure, and - on the hub - what its two sides
 * carry (CV-2, above).
 *
 * AMENDED 2026-09-08 (CV-3). The unpriced clause was gated on
 * `unpricedTokens > 0`, the same test chart-summary.ts removed from its prose
 * in CS-2 and this picture kept. A count that arrives unreadable fails `> 0`
 * exactly as a measured zero does, so hovering a node whose unpriced gap is
 * unknown read identically to hovering one with no gap at all - while the
 * prose alternative for that same node said the count could not be read. One
 * page, two stories, decided by whether the reader can hover. Unreadable is
 * now its own case in both places, and the wording follows the prose.
 *
 * AMENDED 2026-09-25 (KK6). A negative count failed `> 0` just as silently.
 * The test is now the prose's own (`isImpossibleUnpriced`): every impossible
 * count is named with its value, and only a measured zero adds nothing.
 */
function flowNodeTitle(node: FlowNode, flow: CostFlowLayout): string {
  const tokens = node.unpricedTokens;
  const unpriced = isImpossibleUnpriced(tokens)
    ? ` (+ unpriced: ${impossibleUnpricedText(tokens)})`
    : tokens === 0
      ? ''
      : ` (+ ~${formatTokens(tokens)} unpriced tokens)`;
  const hubNote = hubImbalanceNote(node, flow);
  return `${node.label}: ${formatUsd(node.value)}${unpriced}${hubNote === '' ? '' : ` - ${hubNote}`}`;
}

/** The "Cost flow" section. */
export function FlowPanel({
  summary,
  hasCostHonesty,
}: {
  readonly summary: CostSummaryDto;
  readonly hasCostHonesty: boolean;
}) {
  const flow = computeCostFlow(summary);
  return (
    <>
      <h2>Cost flow</h2>
      {/*
        F-7 / F-8 (2026-09-02). Both notices sit ABOVE the diagram and outside
        the `hasFlow` branch: an undrawable cost is undrawable whether or not
        anything else could be drawn, and the balance check is precisely what
        the reader needs BEFORE reading the picture. They are ordinary prose
        outside the role="img" subtree, so assistive tech reaches them in
        document order (the sankey's own text alternative is built by
        describeCostFlow, which does not know these facts - see the report).

        AMENDED 2026-09-02 (F-18): "assistive tech reaches them in document
        order" was true only of a reader who travels in document order. Reaching
        the sankey AS an image - jumped to, or read as `role="img"` plus its
        description - skipped both notices and delivered only the confident
        summary. Fixed by naming these two paragraphs in the diagram's own
        `aria-describedby` list (see flowDescribedBy) rather than by teaching
        describeCostFlow to repeat them, which would have printed the same
        caveat twice on screen.
      */}
      {!flow.balance.balanced && (
        <p className="truncation-banner" id={FLOW_BALANCE_ID} data-testid="flow-balance">
          This diagram does not account for itself - read it as a sketch and the tables below as the
          record.{' '}
          {!flow.balance.totalReadable &&
            'The served all-time total is not a readable amount, so nothing here can be reconciled against it. '}
          {flow.balance.modelsMinusTotalUsd !== 0 &&
            `The per-model rows sum to ${formatUsd(flow.balance.perModelUsd)} while the served total is ${formatUsd(flow.balance.totalUsd)}; the left side of the diagram is drawn from the first and the right side from the second, and they differ by ${formatUsd(flow.balance.modelsMinusTotalUsd)}. `}
          {flow.balance.sessionsOverTotalUsd > 0 &&
            `The top sessions alone sum to ${formatUsd(flow.balance.sessionsUsd)}, more than the served total ${formatUsd(flow.balance.totalUsd)}; the ${formatUsd(flow.balance.sessionsOverTotalUsd)} excess cannot be drawn as a remainder, so the sessions shown are not a subset of that total. `}
        </p>
      )}
      {flow.undrawable.length > 0 && (
        <p className="truncation-banner" id={FLOW_UNDRAWABLE_ID} data-testid="flow-undrawable">
          Not drawn, because no ribbon can carry the amount served:{' '}
          {flow.undrawable.map((entry) => `${entry.label} ${formatUsd(entry.costUsd)}`).join(', ')}.
          The figure is printed here exactly as it arrived rather than dropped from the diagram in
          silence.
        </p>
      )}
      {flow.hasFlow ? (
        <>
          <div className="chart-scroll">
            <svg
              role="img"
              aria-label="cost flow from models to sessions"
              aria-describedby={flowDescribedBy(flow, hasCostHonesty)}
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
                  <title>{flowNodeTitle(node, flow)}</title>
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
                    {node.label}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          {/*
            CV-2 (2026-09-08). The hub note is published here as well as in the
            hover, from the same builder, for the reason F-18 gives above:
            `role="img"` hides the <title> elements from assistive tech, and a
            caveat only a mouse can reach has not been published. This
            paragraph is already named in the diagram's aria-describedby list,
            so no id and no list changes. One string rendered twice cannot
            drift; two strings could, which is why there is one.

            AMENDED 2026-09-09 (CF-2). Still one string, from one builder - but
            this paragraph no longer appends it. `describeCostFlow` states the
            hub itself, last, so the caveat travels with the summary instead of
            being re-attached by every view that renders one. The rendered
            paragraph is byte-for-byte what it was.
          */}
          <p className="chart-summary" id={FLOW_SUMMARY_ID}>
            {describeCostFlow(flow, summary.totals.unpricedTokens)}
          </p>
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
    </>
  );
}
