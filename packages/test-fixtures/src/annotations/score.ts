/**
 * The scorer: hand-labeled claims vs. what the parser actually reconstructed.
 *
 * Deliberate properties, in order of importance:
 *
 * 1. **Unknown is never agreement.** An `UNKNOWN` claim and an agent the
 *    labeler never mentioned are counted in their own buckets and kept out of
 *    the numerator *and* the denominator of the headline accuracy. A blank file
 *    therefore scores `n = 0`, not `100%`.
 * 2. **The sample size travels with the number.** Every ratio is reported next
 *    to the `n` it was computed from, and the exit-gate verdict refuses to
 *    certify below the sample size the threshold actually needs (see
 *    {@link minimumClaimsForThreshold}).
 * 3. **Provenance cannot be blended.** {@link scoreCorpus} takes the provenance
 *    as an argument and rejects any entry that disagrees, so a synthetic
 *    fixture score and a human-labeled score can never be summed into one
 *    figure by accident. Machine-vs-machine agreement is not evidence about
 *    the truth, and {@link certifyExitGate} says so out loud.
 *
 * This module is pure and structurally typed: it takes an
 * {@link ObservedHierarchy}, which a `ParsedSession` from `@agenthropic/core`
 * satisfies as-is. Keeping the dependency structural (rather than importing
 * core) is what lets the fixture package host the tooling without a cycle -
 * core already depends on this package.
 */
import { ORPHAN_TOKEN, ROOT_TOKEN, UNKNOWN_TOKEN, type ParentClaim } from './types.js';
import type { Provenance, SessionAnnotation, SubstrateRef } from './types.js';

/** One agent as the parser reconstructed it. `ParsedAgent` satisfies this. */
export interface ObservedAgent {
  readonly id: string;
  readonly type: 'main' | 'subagent';
  readonly parentAgentId: string | null;
}

/** One session as the parser reconstructed it. `ParsedSession` satisfies this. */
export interface ObservedHierarchy {
  readonly sessionId: string;
  readonly agents: readonly ObservedAgent[];
}

/**
 * - `correct`            - claim and observation agree.
 * - `wrong-parent`       - both exist and disagree. The failure the gate hunts.
 * - `missing-from-parse` - labeled agent the parser never produced. Also a
 *                          failure (it is a hierarchy the parser did not build)
 *                          and counted as such, but kept distinguishable
 *                          because the fix is a different one.
 * - `abstained`          - the labeler said `UNKNOWN`. Excluded from accuracy.
 */
export type CaseOutcome = 'correct' | 'wrong-parent' | 'missing-from-parse' | 'abstained';

/** One scored claim, carrying enough context to diagnose a disagreement. */
export interface HierarchyCase {
  readonly childAgentId: string;
  /** The claim, as written in the annotation file. */
  readonly expected: string;
  /** What the parser said, or `null` when it produced no such agent. */
  readonly observed: string | null;
  readonly outcome: CaseOutcome;
  /** Line in the annotation file the claim came from. */
  readonly line: number;
  readonly comment: string | null;
}

/** The result of scoring one annotated session. */
export interface SessionScore {
  readonly source: string;
  readonly sessionId: string;
  readonly provenance: Provenance;
  readonly substrate: SubstrateRef;
  readonly cases: readonly HierarchyCase[];
  /** Subagents the parser produced that carry no claim at all. */
  readonly unlabeled: readonly string[];
  readonly parsedSubagents: number;
  readonly correct: number;
  readonly wrongParent: number;
  readonly missingFromParse: number;
  readonly abstained: number;
  /** `correct + wrongParent + missingFromParse` - the accuracy denominator. */
  readonly claimed: number;
}

/** The aggregate over one provenance-homogeneous corpus. */
export interface CorpusScore {
  readonly provenance: Provenance;
  readonly sessions: readonly SessionScore[];
  readonly sessionCount: number;
  readonly parsedSubagents: number;
  readonly correct: number;
  readonly wrongParent: number;
  readonly missingFromParse: number;
  /** `wrongParent + missingFromParse`. */
  readonly wrong: number;
  readonly abstained: number;
  readonly unlabeled: number;
  /** The `n` behind {@link accuracy}. Say it out loud wherever the ratio goes. */
  readonly claimed: number;
  /** Every agent in play: claimed + abstained + unlabeled. */
  readonly population: number;
  /** `correct / claimed`, or `null` when nothing was claimed. */
  readonly accuracy: number | null;
  /** One-sided 95% lower confidence bound on {@link accuracy}. */
  readonly accuracyLowerBound95: number | null;
  /** `claimed / population` - how much of the corpus carries a claim at all. */
  readonly labelCoverage: number | null;
  /** `correct / population` - accuracy if every abstention were a miss. */
  readonly worstCaseAccuracy: number | null;
}

/** The exit-gate answer, with every reason it is not a yes. */
export interface ExitGateVerdict {
  readonly certified: boolean;
  readonly threshold: number;
  readonly requiredSampleSize: number;
  readonly reasons: readonly string[];
}

/** Raised when an annotation and a parse cannot legitimately be compared. */
export class ScoringError extends Error {
  override readonly name = 'ScoringError';
}

/** z for a one-sided 95% bound (the 95th percentile of the standard normal). */
export const WILSON_Z_95_ONE_SIDED = 1.6448536269514722;

/** The hierarchy accuracy the Phase-3 exit gate calls for. */
export const EXIT_GATE_THRESHOLD = 0.95;

/**
 * Wilson score lower confidence bound for `successes / n`.
 *
 * Chosen over the naive ratio because the naive ratio is silent about `n`:
 * 3/3 and 300/300 both read "100%", and only one of them is evidence. With no
 * observations at all the bound is 0 - no data, no confidence.
 */
export function wilsonLowerBound(
  successes: number,
  n: number,
  z: number = WILSON_Z_95_ONE_SIDED,
): number {
  if (n <= 0) {
    return 0;
  }
  const phat = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  const lower = (centre - margin) / denominator;
  return Math.max(0, Math.min(1, lower));
}

/**
 * The smallest `n` at which a *flawless* run can clear `threshold` on its
 * lower confidence bound - i.e. the smallest sample for which the figure means
 * anything at all. At 95% with a one-sided 95% bound this is 52.
 *
 * Solving `n / (n + z^2) >= threshold` gives `n >= threshold * z^2 / (1 - threshold)`.
 */
export function minimumClaimsForThreshold(
  threshold: number = EXIT_GATE_THRESHOLD,
  z: number = WILSON_Z_95_ONE_SIDED,
): number {
  if (threshold <= 0 || threshold >= 1) {
    throw new RangeError(`threshold must be strictly between 0 and 1, got ${String(threshold)}`);
  }
  return Math.ceil((threshold * z * z) / (1 - threshold));
}

/** Renders a claim back into the token a labeler would have typed. */
export function renderClaim(claim: ParentClaim): string {
  switch (claim.kind) {
    case 'root':
      return ROOT_TOKEN;
    case 'orphan':
      return ORPHAN_TOKEN;
    case 'unknown':
      return UNKNOWN_TOKEN;
    default:
      return claim.agentId;
  }
}

/** Renders the parser's answer in the same vocabulary as a claim. */
function renderObservation(agent: ObservedAgent, sessionId: string): string {
  if (agent.parentAgentId === null) {
    return ORPHAN_TOKEN;
  }
  if (agent.parentAgentId === sessionId) {
    return ROOT_TOKEN;
  }
  return agent.parentAgentId;
}

function classify(claim: ParentClaim, observed: string | null): CaseOutcome {
  if (claim.kind === 'unknown') {
    return 'abstained';
  }
  if (observed === null) {
    return 'missing-from-parse';
  }
  return renderClaim(claim) === observed ? 'correct' : 'wrong-parent';
}

/**
 * Scores one annotated session against one parse.
 *
 * @throws {ScoringError} when the annotation and the parse are about different
 * sessions - comparing them would produce a number about nothing.
 */
export function scoreSession(
  annotation: SessionAnnotation,
  observed: ObservedHierarchy,
): SessionScore {
  if (annotation.sessionId !== observed.sessionId) {
    throw new ScoringError(
      `${annotation.source}: annotation is about session ${annotation.sessionId} but the parse is about ${observed.sessionId}`,
    );
  }

  const subagents = new Map<string, ObservedAgent>();
  for (const agent of observed.agents) {
    if (agent.type === 'subagent') {
      subagents.set(agent.id, agent);
    }
  }

  const cases: HierarchyCase[] = [];
  const labeled = new Set<string>();
  let correct = 0;
  let wrongParent = 0;
  let missingFromParse = 0;
  let abstained = 0;

  for (const edge of annotation.edges) {
    labeled.add(edge.childAgentId);
    const agent = subagents.get(edge.childAgentId);
    const observedToken = agent === undefined ? null : renderObservation(agent, observed.sessionId);
    const outcome = classify(edge.parent, observedToken);
    if (outcome === 'correct') {
      correct += 1;
    } else if (outcome === 'wrong-parent') {
      wrongParent += 1;
    } else if (outcome === 'missing-from-parse') {
      missingFromParse += 1;
    } else {
      abstained += 1;
    }
    cases.push({
      childAgentId: edge.childAgentId,
      expected: renderClaim(edge.parent),
      observed: observedToken,
      outcome,
      line: edge.line,
      comment: edge.comment,
    });
  }

  const unlabeled = [...subagents.keys()].filter((id) => !labeled.has(id)).sort();

  return {
    source: annotation.source,
    sessionId: annotation.sessionId,
    provenance: annotation.provenance,
    substrate: annotation.substrate,
    cases,
    unlabeled,
    parsedSubagents: subagents.size,
    correct,
    wrongParent,
    missingFromParse,
    abstained,
    claimed: correct + wrongParent + missingFromParse,
  };
}

/** One annotated session paired with the parse it is a claim about. */
export interface ScoringEntry {
  readonly annotation: SessionAnnotation;
  readonly observed: ObservedHierarchy;
}

/**
 * Aggregates a provenance-homogeneous corpus.
 *
 * The provenance is a required *argument*, not something inferred from the
 * entries: that is what makes a blended human+synthetic figure impossible to
 * produce by accident, and what lets an empty human corpus still be reported
 * as "human corpus, n = 0" rather than silently vanishing.
 *
 * @throws {ScoringError} when any entry carries a different provenance.
 */
export function scoreCorpus(provenance: Provenance, entries: readonly ScoringEntry[]): CorpusScore {
  const sessions: SessionScore[] = [];
  for (const entry of entries) {
    if (entry.annotation.provenance !== provenance) {
      throw new ScoringError(
        `${entry.annotation.source}: provenance '${entry.annotation.provenance}' cannot be scored into a '${provenance}' corpus - the two populations are never blended`,
      );
    }
    sessions.push(scoreSession(entry.annotation, entry.observed));
  }

  const sum = (pick: (session: SessionScore) => number): number =>
    sessions.reduce((total, session) => total + pick(session), 0);

  const correct = sum((s) => s.correct);
  const wrongParent = sum((s) => s.wrongParent);
  const missingFromParse = sum((s) => s.missingFromParse);
  const abstained = sum((s) => s.abstained);
  const unlabeled = sum((s) => s.unlabeled.length);
  const claimed = correct + wrongParent + missingFromParse;
  const population = claimed + abstained + unlabeled;

  return {
    provenance,
    sessions,
    sessionCount: sessions.length,
    parsedSubagents: sum((s) => s.parsedSubagents),
    correct,
    wrongParent,
    missingFromParse,
    wrong: wrongParent + missingFromParse,
    abstained,
    unlabeled,
    claimed,
    population,
    accuracy: claimed === 0 ? null : correct / claimed,
    accuracyLowerBound95: claimed === 0 ? null : wilsonLowerBound(correct, claimed),
    labelCoverage: population === 0 ? null : claimed / population,
    worstCaseAccuracy: population === 0 ? null : correct / population,
  };
}

/**
 * The Phase-3 exit-gate verdict: hierarchy accuracy >= 95% without
 * `SubagentStart`, measured against hand-labeled ground truth.
 *
 * Three independent ways to fail, all reported together:
 * - the corpus is synthetic (machine-vs-machine cannot sign a gate about truth);
 * - the sample is too small for the threshold to mean anything;
 * - the measured lower bound is below the threshold.
 */
export function certifyExitGate(
  score: CorpusScore,
  threshold: number = EXIT_GATE_THRESHOLD,
): ExitGateVerdict {
  const requiredSampleSize = minimumClaimsForThreshold(threshold);
  const reasons: string[] = [];

  if (score.provenance !== 'human') {
    reasons.push(
      `provenance is '${score.provenance}': fixture ground truth is true by construction, so agreement with it measures the parser against its own authors, not against reality - it cannot certify the exit gate`,
    );
  }
  if (score.claimed < requiredSampleSize) {
    reasons.push(
      `sample too small: n = ${String(score.claimed)} claimed edges, need n >= ${String(requiredSampleSize)} for a flawless run to clear ${formatPercent(threshold)} on its one-sided 95% lower bound`,
    );
  }
  const lowerBound = score.accuracyLowerBound95;
  if (lowerBound !== null && lowerBound < threshold) {
    reasons.push(
      `measured lower bound ${formatPercent(lowerBound)} is below the ${formatPercent(threshold)} threshold (${String(score.correct)}/${String(score.claimed)} correct)`,
    );
  }

  return { certified: reasons.length === 0, threshold, requiredSampleSize, reasons };
}

/** Renders a ratio as a percentage with one decimal. */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
