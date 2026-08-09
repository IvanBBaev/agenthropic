/**
 * The hierarchy-accuracy gate: the real parser, run against annotated ground
 * truth, scored, and reported with its sample size.
 *
 * This is the tooling half of WP-X2 and of the Phase-3 exit clause ("hierarchy
 * >= 95% without `SubagentStart`"). It lives in `packages/core/test` because it
 * is the only place that may import both the real `parseSession` and the
 * annotation tooling: `@agenthropic/core` already depends on
 * `@agenthropic/test-fixtures`, so the tooling had to live in the fixture
 * package and the wiring had to live here.
 *
 * Two corpora are scored, and they are never blended:
 *
 * - `annotations/synthetic/` - the six shipped fixtures, whose hierarchy is
 *   true by construction. Scoring them proves the tooling works end to end and
 *   that the parser reproduces every join path including gate item 4. It proves
 *   nothing about reality: the "truth" was written by the same side as the
 *   parser, and `certifyExitGate` refuses it by provenance. That refusal is
 *   asserted below so the distinction cannot quietly erode.
 * - `annotations/human/` - hand-labeled sessions. Empty until a human labels
 *   one, in which case the gate reports `n = 0` and NOT CERTIFIED rather than
 *   failing: an unlabeled corpus is an honest state, not a broken build. Once
 *   labeled sessions exist *and* their substrate is present on this machine,
 *   the gate becomes a hard assertion.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyRelativePath, parseSession, type ParsedSession } from '../src/index';
import {
  ScoringError,
  certifyExitGate,
  getFixture,
  listFixtures,
  minimumClaimsForThreshold,
  parseAnnotation,
  readAnnotationDir,
  readSessionTree,
  renderCorpusReport,
  scoreCorpus,
  type FixtureName,
  type ScoringEntry,
  type SessionAnnotation,
  type SessionSubstrateLike,
} from '@agenthropic/test-fixtures';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ANNOTATIONS_ROOT = join(REPO_ROOT, 'packages/test-fixtures/annotations');
const SYNTHETIC_DIR = join(ANNOTATIONS_ROOT, 'synthetic');
const HUMAN_DIR = join(ANNOTATIONS_ROOT, 'human');

/** Prints the gate report unconditionally - a gate nobody can read is not a gate. */
function emit(text: string): void {
  process.stdout.write(`\n${text}\n`);
}

function resolveRepoPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : join(REPO_ROOT, path);
}

type Resolution =
  | { readonly available: true; readonly substrate: SessionSubstrateLike }
  | { readonly available: false; readonly reason: string };

/**
 * Turns an annotation's `substrate:` reference into files the parser can read.
 * A missing on-disk session resolves to "unavailable" rather than an error:
 * real transcripts are local-only (the `spike/` corpus is git-excluded), so a
 * checkout elsewhere must degrade to "cannot measure", never to a false pass.
 */
function resolveSubstrate(annotation: SessionAnnotation): Resolution {
  if (annotation.substrate.kind === 'fixture') {
    const known: readonly string[] = listFixtures();
    if (!known.includes(annotation.substrate.name)) {
      return {
        available: false,
        reason: `unknown fixture '${annotation.substrate.name}' (known: ${known.join(', ')})`,
      };
    }
    return { available: true, substrate: getFixture(annotation.substrate.name as FixtureName) };
  }

  const dir = resolveRepoPath(annotation.substrate.path);
  const substrate = readSessionTree(
    dir,
    annotation.sessionId,
    (relativePath) => classifyRelativePath(relativePath) !== 'other',
  );
  if (substrate === null) {
    return { available: false, reason: `session tree not on this machine: ${dir}` };
  }
  return { available: true, substrate };
}

interface CorpusLoad {
  readonly entries: readonly ScoringEntry[];
  readonly unavailable: readonly string[];
}

/** Loads a corpus directory, parses each available substrate, pairs the two. */
function loadCorpus(dir: string): CorpusLoad {
  const entries: ScoringEntry[] = [];
  const unavailable: string[] = [];
  for (const annotation of readAnnotationDir(dir)) {
    const resolution = resolveSubstrate(annotation);
    if (!resolution.available) {
      unavailable.push(`${annotation.source}: ${resolution.reason}`);
      continue;
    }
    entries.push({ annotation, observed: parseSession(resolution.substrate) });
  }
  return { entries, unavailable };
}

// --- synthetic corpus: proves the tooling, certifies nothing ----------------

describe('hierarchy gate - synthetic fixture corpus', () => {
  const { entries, unavailable } = loadCorpus(SYNTHETIC_DIR);
  const score = scoreCorpus('synthetic-by-construction', entries);

  it('resolves every shipped fixture annotation', () => {
    expect(unavailable).toEqual([]);
    expect(score.sessionCount).toBe(listFixtures().length);
  });

  it('reproduces the by-construction hierarchy exactly, and says its n out loud', () => {
    emit(renderCorpusReport(score));
    expect(score.claimed).toBe(8);
    expect(score.correct).toBe(8);
    expect(score.wrong).toBe(0);
    expect(score.abstained).toBe(0);
    expect(score.unlabeled).toBe(0);
    expect(score.accuracy).toBe(1);
    expect(score.labelCoverage).toBe(1);
  });

  it('scores the depth-2 grandchild against its subagent parent (parser-spec gate 4)', () => {
    const depth2 = score.sessions.find((session) => session.source === 'depth-2-sync.hierarchy.md');
    const grandchild = depth2?.cases.find((item) => item.childAgentId === 'd2d2b002');
    expect(grandchild?.expected).toBe('d1d1a001');
    expect(grandchild?.observed).toBe('d1d1a001');
    expect(grandchild?.outcome).toBe('correct');
  });

  it('scores the no-join-path agent as a claimed ORPHAN, not as a fabricated parent', () => {
    const dedup = score.sessions.find((session) => session.source === 'usage-dedup.hierarchy.md');
    const orphan = dedup?.cases.find((item) => item.childAgentId === 'facade07');
    expect(orphan?.expected).toBe('ORPHAN');
    expect(orphan?.observed).toBe('ORPHAN');
    expect(orphan?.outcome).toBe('correct');
  });

  it('REFUSES to certify the Phase-3 exit gate from machine-authored truth', () => {
    const verdict = certifyExitGate(score);
    expect(verdict.certified).toBe(false);
    expect(verdict.reasons.some((reason) => reason.includes('synthetic-by-construction'))).toBe(
      true,
    );
    // A perfect 8/8 is also simply too small a sample to mean 95% of anything.
    expect(verdict.requiredSampleSize).toBe(minimumClaimsForThreshold());
    expect(verdict.reasons.some((reason) => reason.includes('sample too small'))).toBe(true);
    expect(renderCorpusReport(score)).toContain('NOT CERTIFIED');
  });

  it('cannot be laundered into the human corpus', () => {
    expect(() => scoreCorpus('human', entries)).toThrow(ScoringError);
  });
});

// --- the scorer's honesty, proved against the real parser -------------------

describe('hierarchy gate - the scorer reports failure rather than hiding it', () => {
  const observed: ParsedSession = parseSession(getFixture('depth-2-sync'));

  /** A deliberately wrong / abstaining annotation, used only as a self-test. */
  function selfTest(edges: string): SessionAnnotation {
    return parseAnnotation(
      'self-test.hierarchy.md',
      [
        '## meta',
        'session: 66666666-7777-4888-8999-aaaaaaaaaaaa',
        'provenance: synthetic-by-construction',
        'substrate: fixture:depth-2-sync',
        'labeled-by: scorer self-test',
        'labeled-on: 2026-08-07',
        '',
        '## edges',
        edges,
      ].join('\n'),
    );
  }

  it('counts a flattened depth-2 as wrong, and an abstention as neither right nor wrong', () => {
    const annotation = selfTest(
      ['d1d1a001 <- UNKNOWN # abstention', 'd2d2b002 <- ROOT # deliberately wrong'].join('\n'),
    );
    const score = scoreCorpus('synthetic-by-construction', [{ annotation, observed }]);
    expect(score.claimed).toBe(1);
    expect(score.correct).toBe(0);
    expect(score.wrongParent).toBe(1);
    expect(score.abstained).toBe(1);
    expect(score.accuracy).toBe(0);
    // The abstention did not become agreement, and it did not vanish either.
    expect(score.population).toBe(2);
    expect(score.worstCaseAccuracy).toBe(0);
    const report = renderCorpusReport(score);
    expect(report).toContain('labeled=ROOT');
    expect(report).toContain('parsed=d1d1a001');
    expect(report).toContain('[wrong-parent]');
  });

  it('never scores an unlabeled agent as agreement', () => {
    const annotation = selfTest('d1d1a001 <- ROOT');
    const score = scoreCorpus('synthetic-by-construction', [{ annotation, observed }]);
    expect(score.claimed).toBe(1);
    expect(score.correct).toBe(1);
    expect(score.unlabeled).toBe(1);
    expect(score.accuracy).toBe(1);
    // Perfect on what was claimed; only half the population was ever claimed.
    expect(score.labelCoverage).toBe(0.5);
    expect(score.worstCaseAccuracy).toBe(0.5);
    expect(renderCorpusReport(score)).toContain('unlabeled agents (parsed but never claimed): 1');
  });

  it('counts an agent the parser never produced as a failure, not as absent', () => {
    const annotation = selfTest(
      ['d1d1a001 <- ROOT', 'd2d2b002 <- d1d1a001', 'deadbeef <- ROOT # no such agent'].join('\n'),
    );
    const score = scoreCorpus('synthetic-by-construction', [{ annotation, observed }]);
    expect(score.claimed).toBe(3);
    expect(score.correct).toBe(2);
    expect(score.missingFromParse).toBe(1);
    expect(score.accuracy).toBeCloseTo(2 / 3, 10);
    expect(renderCorpusReport(score)).toContain('ABSENT-FROM-PARSE');
  });
});

// --- human corpus: the only one that can sign the exit gate ------------------

describe('hierarchy gate - hand-labeled corpus (Phase-3 exit clause)', () => {
  const { entries, unavailable } = loadCorpus(HUMAN_DIR);
  const score = scoreCorpus('human', entries);
  const verdict = certifyExitGate(score);

  it('reports the measured hierarchy accuracy and its sample size', () => {
    emit(renderCorpusReport(score));
    for (const note of unavailable) {
      emit(`SUBSTRATE UNAVAILABLE - not measured: ${note}`);
    }
    if (score.sessionCount === 0) {
      emit(
        [
          'Phase-3 exit clause: NOT MEASURED - no hand-labeled sessions.',
          `To measure it, label at least ${String(minimumClaimsForThreshold())} agents:`,
          '  see packages/test-fixtures/annotations/README.md',
        ].join('\n'),
      );
    }
    expect(score.provenance).toBe('human');
    expect(score.claimed).toBe(score.correct + score.wrongParent + score.missingFromParse);
  });

  it('is certified only by a large enough hand-labeled sample that actually passes', () => {
    if (score.sessionCount === 0 || unavailable.length > 0) {
      // Nothing to certify on this machine. Do not manufacture a verdict.
      expect(verdict.certified).toBe(false);
      return;
    }
    expect(verdict.reasons).toEqual([]);
    expect(verdict.certified).toBe(true);
  });
});
