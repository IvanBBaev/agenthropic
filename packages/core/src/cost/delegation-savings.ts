/**
 * WP-C5 — delegation-savings metric, tied to the model-routing decision
 * (development-plan section 5, cost workstream; clean-room, no source lifted).
 *
 * THE FORMULA (per the plan): `savings = Σ_subagents max(0, topTierEquivUsd -
 * actualUsd)`, where for each subagent:
 * - `actualUsd` prices the subagent's OWN deduped usage at its OWN models'
 *   dated per-bucket rates — ground truth;
 * - `topTierEquivUsd` (`hypotheticalUsd`) reprices the SAME token buckets at
 *   the ORCHESTRATOR's model — the model the delegated work would have run on
 *   had it stayed in the parent's context. The routing decision being measured
 *   is "spawn a subagent (often on a cheaper model) instead of doing the work
 *   in the parent's own top-tier context".
 *
 * HONEST-UNCERTAINTY LABEL (`isEstimate: true`, a literal type): the
 * hypothetical carries the subagent's actual cache-read/cache-write profile
 * over unchanged. Had the work truly run inline, the parent's cache lineage
 * would differ in both directions (more cache reads over a bigger prefix, no
 * separate context warm-up, possibly earlier compaction), and no ground truth
 * for that counterfactual exists in the substrate. The figure is therefore an
 * ESTIMATE by construction and is typed as such — it must never be presented
 * as a measured dollar amount.
 *
 * Top-tier model resolution (the plan leaves this free; chosen rules):
 * 1. An explicit `options.topTierModel` wins — the caller names the routing
 *    alternative being measured.
 * 2. Otherwise the model is derived per subagent from its nearest ancestor
 *    that has usage: walk `parentAgentId` upward (main-agent usage carries
 *    `agentId === null` — parser-spec 5.1) and take the ancestor's model from
 *    its greatest-`output` usage row (the settled-model convention of the
 *    message-id dedup, parser-spec 5.2).
 * 3. A subagent whose ancestor chain yields no model (an orphan, a dangling
 *    parent pointer, or a defensive cycle guard) has NO observable routing
 *    decision: it is excluded from the sums and reported in
 *    `skippedAgentIds` — never priced against a guessed model.
 *
 * `<synthetic>` rows (CLI-internal, $0 by explicit seed) keep their own model
 * in the hypothetical: a message that never hit the API would cost $0 in the
 * parent's context too — repricing it at top-tier rates would fabricate spend.
 *
 * Pricing is delegated to `computeCostUsd`: an unknown model id — actual OR
 * hypothetical — still HALTS with `PricingError`, never a silent $0.
 */
import type { DedupedUsage, PricingEntry } from '../types';
import type { ParsedAgent, ParsedSession } from '../parser/types';
import { computeCostUsd } from './compute-cost';

/** Explicit `$0`-seeded pseudo-model of CLI-internal messages (parser-spec 5.4). */
const SYNTHETIC_MODEL_ID = '<synthetic>';

export interface DelegationSavingsOptions {
  /**
   * The model to price the hypothetical at, overriding per-subagent ancestor
   * derivation. Use it to measure a specific routing alternative.
   */
  topTierModel?: string;
}

/** Per-subagent breakdown of the delegation-savings estimate. */
export interface AgentDelegationSavings {
  agentId: string;
  parentAgentId: string | null;
  /** The subagent's own usage at its own models' dated rates — ground truth. */
  actualUsd: number;
  /** The same buckets repriced at `hypotheticalModel` — the top-tier equivalent. */
  hypotheticalUsd: number;
  /** `max(0, hypotheticalUsd - actualUsd)` — the plan's per-agent savings term. */
  savingsUsd: number;
  /** The model the hypothetical was priced at (explicit or ancestor-derived). */
  hypotheticalModel: string;
  /** Always `true`: the counterfactual cache profile is not observable. */
  isEstimate: true;
}

/** The WP-C5 delegation-savings result for one parsed session. */
export interface DelegationSavingsResult {
  /** Σ per-subagent `actualUsd` (skipped subagents excluded). */
  actualUsd: number;
  /** Σ per-subagent `hypotheticalUsd` (skipped subagents excluded). */
  hypotheticalUsd: number;
  /** Σ per-subagent `max(0, hypotheticalUsd - actualUsd)` — the plan's formula. */
  savingsUsd: number;
  perAgent: AgentDelegationSavings[];
  /** Subagents with no resolvable top-tier model (no observable routing decision). */
  skippedAgentIds: string[];
  /** Always `true`: the whole metric inherits the per-agent estimate label. */
  isEstimate: true;
}

/**
 * The settled model of one agent's usage rows: the model on the
 * greatest-`output` row (mirrors the dedup model-settle convention), ignoring
 * `<synthetic>` rows, or `undefined` when the agent has no priceable usage.
 */
function settledModel(rows: readonly DedupedUsage[]): string | undefined {
  let model: string | undefined;
  let bestOutput = -1;
  for (const row of rows) {
    if (row.model === SYNTHETIC_MODEL_ID) {
      continue;
    }
    if (row.usage.output > bestOutput) {
      bestOutput = row.usage.output;
      model = row.model;
    }
  }
  return model;
}

/**
 * Computes the WP-C5 delegation-savings estimate for one parsed session — see
 * the module doc for the formula, the top-tier resolution rules and the
 * honest-uncertainty label.
 *
 * Edge behavior: a session with no subagents (empty tree / single root)
 * returns all-zero sums with empty `perAgent`; a subagent with no usage rows
 * is included with zeros; an orphan with no derivable top-tier model lands in
 * `skippedAgentIds`.
 *
 * @throws {PricingError} (from `computeCostUsd`) when any priced row — actual
 *   or repriced-hypothetical — has an unknown model or a missing dated bucket
 *   price. Never a silent $0.
 */
export function computeDelegationSavings(
  session: ParsedSession,
  pricing: readonly PricingEntry[],
  options: DelegationSavingsOptions = {},
): DelegationSavingsResult {
  const agentById = new Map<string, ParsedAgent>(session.agents.map((agent) => [agent.id, agent]));

  // Usage rows per attribution key: `null` = the main agent's own turns.
  const usageByAgent = new Map<string | null, DedupedUsage[]>();
  for (const row of session.usage) {
    const rows = usageByAgent.get(row.agentId);
    if (rows === undefined) {
      usageByAgent.set(row.agentId, [row]);
    } else {
      rows.push(row);
    }
  }

  /** Usage attribution key of an agent id: main-agent rows carry `agentId === null`. */
  const usageKeyOf = (agentId: string): string | null =>
    agentById.get(agentId)?.type === 'main' ? null : agentId;

  /** Nearest ancestor settled model, walking `parentAgentId` with a cycle guard. */
  const deriveTopTierModel = (subagent: ParsedAgent): string | undefined => {
    const visited = new Set<string>([subagent.id]);
    let cursor = subagent.parentAgentId;
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor);
      const model = settledModel(usageByAgent.get(usageKeyOf(cursor)) ?? []);
      if (model !== undefined) {
        return model;
      }
      cursor = agentById.get(cursor)?.parentAgentId ?? null;
    }
    return undefined;
  };

  const perAgent: AgentDelegationSavings[] = [];
  const skippedAgentIds: string[] = [];
  let actualUsd = 0;
  let hypotheticalUsd = 0;
  let savingsUsd = 0;

  for (const agent of session.agents) {
    if (agent.type !== 'subagent') {
      continue;
    }
    const topTierModel = options.topTierModel ?? deriveTopTierModel(agent);
    if (topTierModel === undefined) {
      skippedAgentIds.push(agent.id);
      continue;
    }

    const rows = usageByAgent.get(agent.id) ?? [];
    const agentActualUsd = computeCostUsd(rows, pricing);
    const repricedRows = rows.map((row) =>
      row.model === SYNTHETIC_MODEL_ID ? row : { ...row, model: topTierModel },
    );
    const agentHypotheticalUsd = computeCostUsd(repricedRows, pricing);
    const agentSavingsUsd = Math.max(0, agentHypotheticalUsd - agentActualUsd);

    actualUsd += agentActualUsd;
    hypotheticalUsd += agentHypotheticalUsd;
    savingsUsd += agentSavingsUsd;
    perAgent.push({
      agentId: agent.id,
      parentAgentId: agent.parentAgentId,
      actualUsd: agentActualUsd,
      hypotheticalUsd: agentHypotheticalUsd,
      savingsUsd: agentSavingsUsd,
      hypotheticalModel: topTierModel,
      isEstimate: true,
    });
  }

  return { actualUsd, hypotheticalUsd, savingsUsd, perAgent, skippedAgentIds, isEstimate: true };
}
