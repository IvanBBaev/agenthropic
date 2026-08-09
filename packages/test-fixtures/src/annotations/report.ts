/**
 * The human-readable gate report.
 *
 * A hierarchy-accuracy figure is only useful if a reader can (a) see the `n`
 * without hunting for it, (b) tell a claim from an abstention, and (c) find the
 * exact line of the exact file behind every disagreement. This renderer is
 * pure - it returns a string, so it is testable and the gate can print it.
 */
import {
  certifyExitGate,
  formatPercent,
  EXIT_GATE_THRESHOLD,
  type CaseOutcome,
  type CorpusScore,
  type SessionScore,
} from './score.js';

const RULE = '='.repeat(78);
const THIN_RULE = '-'.repeat(78);

const ADMISSIBILITY: Readonly<Record<CorpusScore['provenance'], string>> = {
  human: 'ADMISSIBLE - hand-labeled ground truth',
  'synthetic-by-construction':
    'NOT ADMISSIBLE for the exit gate - fixture truth is machine-authored',
};

function ratio(value: number | null): string {
  return value === null ? 'n/a (no claims)' : formatPercent(value);
}

function pad(label: string): string {
  return label.padEnd(22, ' ');
}

function substrateLabel(session: SessionScore): string {
  return session.substrate.kind === 'fixture'
    ? `fixture:${session.substrate.name}`
    : `session-tree:${session.substrate.path}`;
}

/** The two ways a claim can be wrong. An abstention is not one of them. */
const FAILURES: ReadonlySet<CaseOutcome> = new Set<CaseOutcome>([
  'wrong-parent',
  'missing-from-parse',
]);
const ABSTENTIONS: ReadonlySet<CaseOutcome> = new Set<CaseOutcome>(['abstained']);

function renderCases(session: SessionScore, outcomes: ReadonlySet<CaseOutcome>): string[] {
  const lines: string[] = [];
  for (const item of session.cases) {
    if (!outcomes.has(item.outcome)) {
      continue;
    }
    const comment = item.comment === null ? '' : `   # ${item.comment}`;
    const observed = item.observed ?? 'ABSENT-FROM-PARSE';
    lines.push(
      `  ${session.source}:${String(item.line)}  ${item.childAgentId}  labeled=${item.expected}  parsed=${observed}  [${item.outcome}]${comment}`,
    );
  }
  return lines;
}

/**
 * Renders one corpus score as a report.
 *
 * @param score - a provenance-homogeneous corpus score.
 * @param threshold - the accuracy bar being tested (default: the exit gate's).
 */
export function renderCorpusReport(
  score: CorpusScore,
  threshold: number = EXIT_GATE_THRESHOLD,
): string {
  const verdict = certifyExitGate(score, threshold);
  const lines: string[] = [
    RULE,
    `HIERARCHY ACCURACY - provenance: ${score.provenance}`,
    ADMISSIBILITY[score.provenance],
    RULE,
    `${pad('sessions scored')}: ${String(score.sessionCount)}`,
    `${pad('subagents parsed')}: ${String(score.parsedSubagents)}`,
    `${pad('agents in play')}: ${String(score.population)}`,
    THIN_RULE,
    `${pad('claimed (n)')}: ${String(score.claimed)}`,
    `${pad('  correct')}: ${String(score.correct)}`,
    `${pad('  wrong parent')}: ${String(score.wrongParent)}`,
    `${pad('  missing from parse')}: ${String(score.missingFromParse)}`,
    `${pad('abstained (UNKNOWN)')}: ${String(score.abstained)}`,
    `${pad('unlabeled')}: ${String(score.unlabeled)}`,
    THIN_RULE,
    `${pad('accuracy')}: ${ratio(score.accuracy)}  (n = ${String(score.claimed)})`,
    `${pad('95% lower bound')}: ${ratio(score.accuracyLowerBound95)}  (one-sided Wilson)`,
    `${pad('label coverage')}: ${ratio(score.labelCoverage)}`,
    `${pad('worst case')}: ${ratio(score.worstCaseAccuracy)}  (every abstention counted as a miss)`,
    THIN_RULE,
  ];

  for (const session of score.sessions) {
    lines.push(
      `${session.source}  [${substrateLabel(session)}]  n=${String(session.claimed)} correct=${String(session.correct)} wrong=${String(session.wrongParent + session.missingFromParse)} unknown=${String(session.abstained)} unlabeled=${String(session.unlabeled.length)}`,
    );
  }
  if (score.sessionCount === 0) {
    lines.push('(no annotation files found for this provenance)');
  }

  // Three separate blocks on purpose: a disagreement, an abstention and an
  // unclaimed agent are three different facts, and only the first is a parser
  // defect. Folding any of them together is how a "95%" stops meaning anything.
  const disagreements = score.sessions.flatMap((session) => renderCases(session, FAILURES));
  lines.push(THIN_RULE, `disagreements: ${String(disagreements.length)}`);
  lines.push(...disagreements);

  const abstentions = score.sessions.flatMap((session) => renderCases(session, ABSTENTIONS));
  lines.push(
    `abstentions (UNKNOWN - excluded from accuracy, never agreement): ${String(score.abstained)}`,
  );
  lines.push(...abstentions);

  const unlabeledLines = score.sessions
    .filter((session) => session.unlabeled.length > 0)
    .map((session) => `  ${session.source}: ${session.unlabeled.join(', ')}`);
  lines.push(`unlabeled agents (parsed but never claimed): ${String(score.unlabeled)}`);
  lines.push(...unlabeledLines);

  lines.push(
    THIN_RULE,
    `EXIT GATE (>= ${formatPercent(threshold)} hierarchy accuracy, n >= ${String(verdict.requiredSampleSize)}): ${verdict.certified ? 'CERTIFIED' : 'NOT CERTIFIED'}`,
  );
  for (const reason of verdict.reasons) {
    lines.push(`  - ${reason}`);
  }
  lines.push(RULE);

  return lines.join('\n');
}
