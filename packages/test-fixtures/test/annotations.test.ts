/**
 * Unit tests for the hierarchy-annotation tooling: the format's validator, the
 * scorer's arithmetic, the report and the read-only disk adapters.
 *
 * The end-to-end proof (real parser vs. annotated corpus) lives in
 * `packages/core/test/hierarchy-gate.test.ts`, because only that package may
 * import the parser. What is tested here is everything that must hold *before*
 * a number is believable:
 *
 * - a malformed annotation fails loudly, at a line, with every problem at once;
 * - an abstention (`UNKNOWN`) and an unlabeled agent are never counted as
 *   agreement;
 * - a percentage never travels without its `n`, and the gate refuses samples
 *   too small for the threshold to mean anything;
 * - a synthetic corpus can never be certified, nor blended with a human one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANNOTATION_SUFFIX,
  AnnotationError,
  EXIT_GATE_THRESHOLD,
  ORPHAN_TOKEN,
  PROVENANCES,
  ROOT_TOKEN,
  ScoringError,
  UNKNOWN_TOKEN,
  WILSON_Z_95_ONE_SIDED,
  certifyExitGate,
  formatPercent,
  minimumClaimsForThreshold,
  parseAnnotation,
  readAnnotationDir,
  readSessionTree,
  renderClaim,
  renderCorpusReport,
  scoreCorpus,
  scoreSession,
  wilsonLowerBound,
  type AnnotationIssue,
  type CorpusScore,
  type ObservedAgent,
  type ObservedHierarchy,
  type SessionAnnotation,
} from '../src/index';

const SOURCE = 't.hierarchy.md';
const SESSION = '11111111-2222-4333-8444-555555555555';

const ANNOTATIONS_DIR = fileURLToPath(new URL('../annotations/', import.meta.url));

/** Builds a well-formed file body from its two sections. */
function file(meta: readonly string[], edges: readonly string[]): string {
  return ['# title prose', '', '## meta', ...meta, '', '## edges', ...edges].join('\n');
}

const VALID_META = [
  `session: ${SESSION}`,
  'provenance: human',
  'substrate: session-tree:some/dir',
  'labeled-by: Ivan Baev',
  'labeled-on: 2026-08-07',
];

/** Parses text that is expected to fail, and returns the issues it reported. */
function issuesOf(text: string): readonly AnnotationIssue[] {
  try {
    parseAnnotation(SOURCE, text);
  } catch (error) {
    if (error instanceof AnnotationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected the annotation to be rejected, but it parsed');
}

/** Asserts that exactly the given messages (as substrings) were reported. */
function expectIssues(text: string, expected: readonly string[]): readonly AnnotationIssue[] {
  const issues = issuesOf(text);
  expect(issues.map((issue) => issue.message)).toHaveLength(expected.length);
  expected.forEach((fragment, index) => {
    expect(issues[index]?.message).toContain(fragment);
  });
  return issues;
}

// --- the format ------------------------------------------------------------

describe('parseAnnotation - a well-formed file', () => {
  const annotation = parseAnnotation(
    SOURCE,
    [
      '# title prose',
      '',
      '## meta',
      ...VALID_META,
      'note: first note',
      'note: second note',
      '',
      '## notes to myself',
      'free prose in an unrecognised section is ignored',
      '',
      '## edges',
      'aaaa1111 <- ROOT # top level',
      'bbbb2222   <-   aaaa1111',
      'cccc3333 <- ORPHAN',
      'dddd4444 <- UNKNOWN # compacted away, cannot tell',
    ].join('\n'),
  );

  it('keeps the metadata, including repeatable notes', () => {
    expect(annotation.source).toBe(SOURCE);
    expect(annotation.sessionId).toBe(SESSION);
    expect(annotation.provenance).toBe('human');
    expect(annotation.substrate).toEqual({ kind: 'session-tree', path: 'some/dir' });
    expect(annotation.labeledBy).toBe('Ivan Baev');
    expect(annotation.labeledOn).toBe('2026-08-07');
    expect(annotation.notes).toEqual(['first note', 'second note']);
  });

  it('records every claim with its line number and its comment', () => {
    expect(annotation.edges).toEqual([
      { childAgentId: 'aaaa1111', parent: { kind: 'root' }, line: 16, comment: 'top level' },
      {
        childAgentId: 'bbbb2222',
        parent: { kind: 'agent', agentId: 'aaaa1111' },
        line: 17,
        comment: null,
      },
      { childAgentId: 'cccc3333', parent: { kind: 'orphan' }, line: 18, comment: null },
      {
        childAgentId: 'dddd4444',
        parent: { kind: 'unknown' },
        line: 19,
        comment: 'compacted away, cannot tell',
      },
    ]);
  });

  it('accepts a fixture substrate and the synthetic provenance', () => {
    const synthetic = parseAnnotation(
      SOURCE,
      file(
        [
          `session: ${SESSION}`,
          'provenance: synthetic-by-construction',
          'substrate: fixture:depth-2-sync',
          'labeled-by: corpus',
          'labeled-on: 2026-08-07',
        ],
        ['aaaa1111 <- ROOT'],
      ),
    );
    expect(synthetic.provenance).toBe('synthetic-by-construction');
    expect(synthetic.substrate).toEqual({ kind: 'fixture', name: 'depth-2-sync' });
  });

  it('tolerates CRLF line endings', () => {
    const annotation = parseAnnotation(
      SOURCE,
      file(VALID_META, ['aaaa1111 <- ROOT']).replace(/\n/g, '\r\n'),
    );
    expect(annotation.edges[0]?.childAgentId).toBe('aaaa1111');
  });

  it('exposes the vocabulary it validates against', () => {
    expect(PROVENANCES).toEqual(['human', 'synthetic-by-construction']);
    expect([ROOT_TOKEN, ORPHAN_TOKEN, UNKNOWN_TOKEN]).toEqual(['ROOT', 'ORPHAN', 'UNKNOWN']);
    expect(ANNOTATION_SUFFIX).toBe('.hierarchy.md');
  });
});

describe('parseAnnotation - structural problems', () => {
  it('reports both missing sections in a file with no sections at all', () => {
    expectIssues('# just prose\n\nnothing structural here', [
      `missing '## meta' section`,
      `missing '## edges' section`,
    ]);
  });

  it('reports a missing edges section without also complaining that it is empty', () => {
    expectIssues(['## meta', ...VALID_META].join('\n'), [`missing '## edges' section`]);
  });

  it('rejects an edges section that claims nothing', () => {
    expectIssues(file(VALID_META, []), [`'## edges' is empty`]);
  });

  it('rejects duplicated sections', () => {
    expectIssues(
      ['## meta', ...VALID_META, '## meta', '## edges', 'aaaa1111 <- ROOT', '## edges'].join('\n'),
      [`duplicate '## meta' section`, `duplicate '## edges' section`],
    );
  });

  it('points at an edge-shaped line that ended up outside the edges section', () => {
    const issues = expectIssues(
      ['## meta', ...VALID_META, '', '## edgez', 'aaaa1111 <- ROOT'].join('\n'),
      [`edge-shaped line outside the '## edges' section`, `missing '## edges' section`],
    );
    expect(issues[0]?.line).toBe(9);
  });
});

describe('parseAnnotation - metadata problems', () => {
  it('rejects a meta line that is not key: value', () => {
    expectIssues(file([...VALID_META, 'a stray sentence'], ['aaaa1111 <- ROOT']), [
      `not a 'key: value' line`,
    ]);
  });

  it('rejects an unknown meta key', () => {
    expectIssues(file([...VALID_META, 'confidence: high'], ['aaaa1111 <- ROOT']), [
      `unknown meta key 'confidence'`,
    ]);
  });

  it('rejects a duplicated meta key', () => {
    expectIssues(file([...VALID_META, 'labeled-by: someone else'], ['aaaa1111 <- ROOT']), [
      `duplicate meta key 'labeled-by'`,
    ]);
  });

  it('rejects an empty meta value', () => {
    expectIssues(
      file(
        [`session: ${SESSION}`, 'provenance: human', 'substrate:', 'labeled-by: x'],
        ['aaaa1111 <- ROOT'],
      ),
      [
        `meta key 'substrate' has an empty value`,
        `missing required meta key 'substrate'`,
        `missing required meta key 'labeled-on'`,
      ],
    );
  });

  it('rejects a template blank left in a meta value', () => {
    expectIssues(
      file([...VALID_META.slice(0, 4), 'labeled-on: __________'], ['aaaa1111 <- ROOT']),
      [`still holds the template blank`, `missing required meta key 'labeled-on'`],
    );
  });

  it('lists every missing required key', () => {
    expectIssues(file([`session: ${SESSION}`], ['aaaa1111 <- ROOT']), [
      `missing required meta key 'provenance'`,
      `missing required meta key 'substrate'`,
      `missing required meta key 'labeled-by'`,
      `missing required meta key 'labeled-on'`,
    ]);
  });

  it('validates the session id, the provenance and the date', () => {
    expectIssues(
      file(
        [
          'session: not-a-uuid',
          'provenance: vibes',
          'substrate: fixture:x',
          'labeled-by: x',
          'labeled-on: 07/08/2026',
        ],
        ['aaaa1111 <- ROOT'],
      ),
      [
        `is not a session UUID`,
        `provenance 'vibes' is not one of`,
        `labeled-on '07/08/2026' is not a YYYY-MM-DD date`,
      ],
    );
  });

  it.each([
    ['substrate: nocolon', 'a missing kind separator'],
    ['substrate: bogus:thing', 'an unknown kind'],
    ['substrate: fixture:', 'an empty target'],
  ])('rejects %s (%s)', (line) => {
    expectIssues(
      file(
        [
          `session: ${SESSION}`,
          'provenance: human',
          line,
          'labeled-by: x',
          'labeled-on: 2026-08-07',
        ],
        ['aaaa1111 <- ROOT'],
      ),
      [`must be 'fixture:<name>' or 'session-tree:<directory>'`],
    );
  });
});

describe('parseAnnotation - edge problems', () => {
  it('rejects a line with no arrow', () => {
    expectIssues(file(VALID_META, ['aaaa1111 is a child of ROOT']), [
      `expected '<child-agent-hex>`,
    ]);
  });

  it('names the unfilled template blank in the parent slot', () => {
    const issues = expectIssues(file(VALID_META, ['aaaa1111 <- __________   # some agent']), [
      `unfilled template blank for 'aaaa1111'`,
    ]);
    expect(issues[0]?.message).toContain('replace');
  });

  it('rejects an unfilled child slot', () => {
    expectIssues(file(VALID_META, ['__________ <- ROOT']), [
      `unfilled template blank in the child slot`,
    ]);
  });

  it('rejects a child that is not an agent hex', () => {
    expectIssues(file(VALID_META, ['Explore <- ROOT']), [`'Explore' is not an agent hex`]);
  });

  it('rejects a parent token that is neither a keyword nor a hex', () => {
    expectIssues(file(VALID_META, ['aaaa1111 <- the main agent']), [
      `'the main agent' is not a valid parent`,
    ]);
  });

  it('rejects an agent claimed as its own parent', () => {
    expectIssues(file(VALID_META, ['aaaa1111 <- aaaa1111']), [`is claimed as its own parent`]);
  });

  it('rejects a duplicated child label and says where the first one was', () => {
    expectIssues(file(VALID_META, ['aaaa1111 <- ROOT', 'aaaa1111 <- ORPHAN']), [
      `duplicate label for 'aaaa1111' (first labeled on line 11)`,
    ]);
  });

  it('rejects a subagent parent that carries no line of its own', () => {
    expectIssues(file(VALID_META, ['bbbb2222 <- aaaa1111']), [
      `parent 'aaaa1111' is never labeled as a child in this file`,
    ]);
  });

  it('rejects a parent cycle', () => {
    expectIssues(file(VALID_META, ['aaaa1111 <- bbbb2222', 'bbbb2222 <- aaaa1111']), [
      `takes part in a parent cycle`,
    ]);
  });
});

describe('AnnotationError', () => {
  it('reports every problem at once, each with file and line where known', () => {
    let caught: AnnotationError | undefined;
    try {
      parseAnnotation(SOURCE, ['## edges', 'aaaa1111 <- nonsense'].join('\n'));
    } catch (error) {
      caught = error as AnnotationError;
    }
    expect(caught?.name).toBe('AnnotationError');
    expect(caught?.source).toBe(SOURCE);
    expect(caught?.issues).toHaveLength(2);
    expect(caught?.message).toContain(`${SOURCE}: 2 annotation problem(s)`);
    expect(caught?.message).toContain(`${SOURCE}:2: 'nonsense' is not a valid parent`);
    expect(caught?.message).toContain(`${SOURCE}: missing '## meta' section`);
  });
});

// --- the scorer's arithmetic -----------------------------------------------

function agents(...list: readonly ObservedAgent[]): ObservedHierarchy {
  return { sessionId: SESSION, agents: list };
}

function subagent(id: string, parentAgentId: string | null): ObservedAgent {
  return { id, type: 'subagent', parentAgentId };
}

const MAIN: ObservedAgent = { id: SESSION, type: 'main', parentAgentId: null };

describe('wilsonLowerBound', () => {
  it('is zero with no observations at all', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, -1)).toBe(0);
  });

  it('collapses to n / (n + z^2) on a flawless run', () => {
    const z2 = WILSON_Z_95_ONE_SIDED * WILSON_Z_95_ONE_SIDED;
    expect(wilsonLowerBound(10, 10)).toBeCloseTo(10 / (10 + z2), 12);
    expect(wilsonLowerBound(100, 100)).toBeCloseTo(100 / (100 + z2), 12);
  });

  it('separates a small perfect sample from a large one', () => {
    expect(wilsonLowerBound(3, 3)).toBeLessThan(wilsonLowerBound(300, 300));
    expect(wilsonLowerBound(3, 3)).toBeLessThan(EXIT_GATE_THRESHOLD);
  });

  it('accepts an explicit z and never leaves [0, 1]', () => {
    expect(wilsonLowerBound(10, 10, 1)).toBeCloseTo(10 / 11, 12);
    expect(wilsonLowerBound(0, 5)).toBe(0);
  });
});

describe('minimumClaimsForThreshold', () => {
  it('is 52 for the Phase-3 exit gate', () => {
    expect(minimumClaimsForThreshold()).toBe(52);
    // The definition it is derived from: a flawless run of exactly n clears it.
    expect(wilsonLowerBound(52, 52)).toBeGreaterThanOrEqual(EXIT_GATE_THRESHOLD);
    expect(wilsonLowerBound(51, 51)).toBeLessThan(EXIT_GATE_THRESHOLD);
  });

  it('scales with the threshold and accepts an explicit z', () => {
    expect(minimumClaimsForThreshold(0.9)).toBe(25);
    expect(minimumClaimsForThreshold(0.5, 2)).toBe(4);
  });

  it.each([0, 1, -0.5, 1.5])('rejects a threshold of %s', (threshold) => {
    expect(() => minimumClaimsForThreshold(threshold)).toThrow(RangeError);
  });
});

describe('renderClaim', () => {
  it('renders every claim back into the token a labeler would type', () => {
    expect(renderClaim({ kind: 'root' })).toBe(ROOT_TOKEN);
    expect(renderClaim({ kind: 'orphan' })).toBe(ORPHAN_TOKEN);
    expect(renderClaim({ kind: 'unknown' })).toBe(UNKNOWN_TOKEN);
    expect(renderClaim({ kind: 'agent', agentId: 'aaaa1111' })).toBe('aaaa1111');
  });
});

describe('scoreSession', () => {
  const annotation = parseAnnotation(
    SOURCE,
    file(VALID_META, [
      'aaaa1111 <- ROOT      # right',
      'bbbb2222 <- aaaa1111  # right, depth 2',
      'cccc3333 <- ORPHAN    # right, no join path',
      'dddd4444 <- ROOT      # wrong: the parser found a subagent parent',
      'eeee5555 <- UNKNOWN   # abstention',
      'ffff6666 <- ROOT      # the parser produced no such agent',
    ]),
  );
  const score = scoreSession(
    annotation,
    agents(
      MAIN,
      subagent('aaaa1111', SESSION),
      subagent('bbbb2222', 'aaaa1111'),
      subagent('cccc3333', null),
      subagent('dddd4444', 'aaaa1111'),
      subagent('eeee5555', SESSION),
      subagent('99990000', SESSION),
    ),
  );

  it('refuses to compare an annotation with a parse of a different session', () => {
    expect(() => scoreSession(annotation, { sessionId: 'other', agents: [] })).toThrow(
      ScoringError,
    );
  });

  it('separates correct, wrong, missing and abstained', () => {
    expect(score.correct).toBe(3);
    expect(score.wrongParent).toBe(1);
    expect(score.missingFromParse).toBe(1);
    expect(score.abstained).toBe(1);
    expect(score.claimed).toBe(5);
  });

  it('excludes the main agent and lists parsed subagents that carry no claim', () => {
    expect(score.parsedSubagents).toBe(6);
    expect(score.unlabeled).toEqual(['99990000']);
  });

  it('keeps enough per-case detail to diagnose a disagreement', () => {
    const wrong = score.cases.find((item) => item.childAgentId === 'dddd4444');
    expect(wrong).toEqual({
      childAgentId: 'dddd4444',
      expected: 'ROOT',
      observed: 'aaaa1111',
      outcome: 'wrong-parent',
      line: 14,
      comment: 'wrong: the parser found a subagent parent',
    });
    expect(score.cases.find((item) => item.childAgentId === 'ffff6666')?.observed).toBeNull();
    expect(score.cases.find((item) => item.childAgentId === 'eeee5555')?.outcome).toBe('abstained');
  });
});

/** A corpus of `total` ROOT claims of which `correct` actually parse as ROOT. */
function syntheticCorpus(total: number, correct: number, provenance = 'human'): CorpusScore {
  const ids = Array.from({ length: total }, (_, index) => index.toString(16).padStart(4, '0'));
  const annotation = parseAnnotation(
    SOURCE,
    file(
      [
        `session: ${SESSION}`,
        `provenance: ${provenance}`,
        'substrate: session-tree:some/dir',
        'labeled-by: x',
        'labeled-on: 2026-08-07',
      ],
      ids.map((id) => `${id} <- ROOT`),
    ),
  );
  const observed = agents(
    MAIN,
    ...ids.map((id, index) => subagent(id, index < correct ? SESSION : null)),
  );
  return scoreCorpus(annotation.provenance, [{ annotation, observed }]);
}

describe('scoreCorpus', () => {
  it('reports null ratios rather than a fake 100% for an empty corpus', () => {
    const score = scoreCorpus('human', []);
    expect(score.sessionCount).toBe(0);
    expect(score.claimed).toBe(0);
    expect(score.population).toBe(0);
    expect(score.accuracy).toBeNull();
    expect(score.accuracyLowerBound95).toBeNull();
    expect(score.labelCoverage).toBeNull();
    expect(score.worstCaseAccuracy).toBeNull();
  });

  it('never folds an abstention or an unlabeled agent into the numerator', () => {
    const annotation = parseAnnotation(
      SOURCE,
      file(VALID_META, ['aaaa1111 <- UNKNOWN', 'bbbb2222 <- UNKNOWN']),
    );
    const score = scoreCorpus('human', [
      {
        annotation,
        observed: agents(
          subagent('aaaa1111', SESSION),
          subagent('bbbb2222', SESSION),
          subagent('cccc3333', SESSION),
        ),
      },
    ]);
    expect(score.claimed).toBe(0);
    expect(score.accuracy).toBeNull();
    expect(score.abstained).toBe(2);
    expect(score.unlabeled).toBe(1);
    expect(score.population).toBe(3);
    expect(score.labelCoverage).toBe(0);
    expect(score.worstCaseAccuracy).toBe(0);
  });

  it('refuses to blend provenances into one figure', () => {
    const annotation = parseAnnotation(SOURCE, file(VALID_META, ['aaaa1111 <- ROOT']));
    expect(() =>
      scoreCorpus('synthetic-by-construction', [
        { annotation, observed: agents(subagent('aaaa1111', SESSION)) },
      ]),
    ).toThrow(ScoringError);
  });

  it('aggregates the failure buckets into one wrong count', () => {
    const score = syntheticCorpus(10, 7);
    expect(score.correct).toBe(7);
    expect(score.wrong).toBe(3);
    expect(score.wrongParent).toBe(3);
    expect(score.missingFromParse).toBe(0);
    expect(score.accuracy).toBeCloseTo(0.7, 12);
    expect(score.labelCoverage).toBe(1);
  });
});

describe('certifyExitGate', () => {
  it('refuses machine-authored ground truth outright', () => {
    const score = syntheticCorpus(60, 60, 'synthetic-by-construction');
    const verdict = certifyExitGate(score);
    expect(verdict.certified).toBe(false);
    expect(verdict.reasons[0]).toContain('cannot certify the exit gate');
    expect(verdict.threshold).toBe(EXIT_GATE_THRESHOLD);
  });

  it('refuses a perfect score from too small a sample', () => {
    const verdict = certifyExitGate(syntheticCorpus(10, 10));
    expect(verdict.certified).toBe(false);
    // A flawless 10/10 fails twice over: too small, and consequently a lower
    // bound that cannot reach the threshold no matter how clean the run was.
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toContain('sample too small: n = 10 claimed edges, need n >= 52');
    expect(verdict.reasons[1]).toContain('is below the 95.0% threshold (10/10 correct)');
  });

  it('refuses a large sample whose lower bound misses the threshold', () => {
    const verdict = certifyExitGate(syntheticCorpus(60, 59));
    expect(verdict.certified).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain('is below the 95.0% threshold (59/60 correct)');
  });

  it('certifies a hand-labeled sample that is both big enough and clean', () => {
    const verdict = certifyExitGate(syntheticCorpus(60, 60));
    expect(verdict.reasons).toEqual([]);
    expect(verdict.certified).toBe(true);
    expect(verdict.requiredSampleSize).toBe(52);
  });

  it('accepts an explicit threshold', () => {
    const verdict = certifyExitGate(syntheticCorpus(30, 30), 0.9);
    expect(verdict.threshold).toBe(0.9);
    expect(verdict.requiredSampleSize).toBe(25);
    expect(verdict.certified).toBe(true);
  });
});

describe('formatPercent', () => {
  it('renders one decimal', () => {
    expect(formatPercent(0.95)).toBe('95.0%');
    expect(formatPercent(2 / 3)).toBe('66.7%');
  });
});

// --- the report ------------------------------------------------------------

describe('renderCorpusReport', () => {
  it('says "no claims" instead of printing a ratio it does not have', () => {
    const report = renderCorpusReport(scoreCorpus('human', []));
    expect(report).toContain('ADMISSIBLE - hand-labeled ground truth');
    expect(report).toContain('(no annotation files found for this provenance)');
    expect(report).toMatch(/accuracy +: n\/a \(no claims\) {2}\(n = 0\)/);
    expect(report).toMatch(/95% lower bound +: n\/a \(no claims\)/);
    expect(report).toContain('NOT CERTIFIED');
  });

  it('marks a synthetic corpus as inadmissible', () => {
    const report = renderCorpusReport(syntheticCorpus(60, 60, 'synthetic-by-construction'));
    expect(report).toContain('NOT ADMISSIBLE for the exit gate');
    expect(report).toContain('NOT CERTIFIED');
  });

  it('prints CERTIFIED only when the verdict is a yes', () => {
    const report = renderCorpusReport(syntheticCorpus(60, 60));
    expect(report).toContain('CERTIFIED');
    expect(report).not.toContain('NOT CERTIFIED');
    expect(report).toMatch(/accuracy +: 100\.0% {2}\(n = 60\)/);
    expect(report).toContain('disagreements: 0');
  });

  it('prints one diagnosable line per disagreement and lists unlabeled agents', () => {
    const annotation = parseAnnotation(
      SOURCE,
      file(
        [
          `session: ${SESSION}`,
          'provenance: human',
          'substrate: fixture:depth-2-sync',
          'labeled-by: x',
          'labeled-on: 2026-08-07',
        ],
        [
          'aaaa1111 <- ROOT     # commented',
          'bbbb2222 <- ROOT',
          'cccc3333 <- UNKNOWN',
          'dddd4444 <- ROOT',
        ],
      ),
    );
    const report = renderCorpusReport(
      scoreCorpus('human', [
        {
          annotation,
          observed: agents(
            subagent('aaaa1111', 'bbbb2222'),
            subagent('bbbb2222', SESSION),
            subagent('cccc3333', SESSION),
            subagent('99990000', SESSION),
          ),
        },
      ]),
    );
    expect(report).toContain('[fixture:depth-2-sync]');
    expect(report).toContain('disagreements: 2');
    expect(report).toContain(
      `  ${SOURCE}:11  aaaa1111  labeled=ROOT  parsed=bbbb2222  [wrong-parent]   # commented`,
    );
    expect(report).toContain(
      `  ${SOURCE}:14  dddd4444  labeled=ROOT  parsed=ABSENT-FROM-PARSE  [missing-from-parse]`,
    );
    // The abstention is neither a disagreement nor an agreement: its own block.
    expect(report).toContain('abstentions (UNKNOWN - excluded from accuracy, never agreement): 1');
    expect(report).toContain(`  ${SOURCE}:13  cccc3333  labeled=UNKNOWN  parsed=ROOT  [abstained]`);
    expect(report).toContain('unlabeled agents (parsed but never claimed): 1');
    expect(report).toContain(`  ${SOURCE}: 99990000`);
  });

  it('labels a session-tree substrate by its path and accepts an explicit threshold', () => {
    const report = renderCorpusReport(syntheticCorpus(30, 30), 0.9);
    expect(report).toContain('[session-tree:some/dir]');
    expect(report).toContain('EXIT GATE (>= 90.0% hierarchy accuracy, n >= 25): CERTIFIED');
  });
});

// --- the disk adapters -----------------------------------------------------

describe('readAnnotationDir', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-annotations-'));
    writeFileSync(join(dir, `b${ANNOTATION_SUFFIX}`), file(VALID_META, ['bbbb2222 <- ROOT']));
    writeFileSync(join(dir, `a${ANNOTATION_SUFFIX}`), file(VALID_META, ['aaaa1111 <- ROOT']));
    writeFileSync(join(dir, 'README.md'), '# not an annotation\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty corpus for a directory that does not exist', () => {
    expect(readAnnotationDir(join(dir, 'nope'))).toEqual([]);
  });

  it('loads only *.hierarchy.md, sorted, tagged with their file name', () => {
    expect(readAnnotationDir(dir).map((a: SessionAnnotation) => a.source)).toEqual([
      `a${ANNOTATION_SUFFIX}`,
      `b${ANNOTATION_SUFFIX}`,
    ]);
  });

  it('loads the shipped synthetic corpus, all of it machine-authored', () => {
    const corpus = readAnnotationDir(join(ANNOTATIONS_DIR, 'synthetic'));
    // One annotation per shipped fixture — 7 since `legacy-bare-explore`
    // (parser-spec gate #7) joined the corpus.
    expect(corpus).toHaveLength(7);
    for (const annotation of corpus) {
      expect(annotation.provenance).toBe('synthetic-by-construction');
      expect(annotation.substrate.kind).toBe('fixture');
    }
  });

  it('rejects a template that still has its blanks, so an unfilled file cannot score', () => {
    let caught: AnnotationError | undefined;
    try {
      readAnnotationDir(join(ANNOTATIONS_DIR, 'templates'));
    } catch (error) {
      caught = error as AnnotationError;
    }
    expect(caught?.name).toBe('AnnotationError');
    expect(caught?.issues.some((issue) => issue.message.includes('template blank'))).toBe(true);
  });
});

describe('readSessionTree', () => {
  let dir = '';
  const sessionId = SESSION;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-session-tree-'));
    writeFileSync(join(dir, `${sessionId}.jsonl`), '{"a":1}\n{"b":2}\n');
    mkdirSync(join(dir, sessionId, 'subagents'), { recursive: true });
    writeFileSync(join(dir, sessionId, 'subagents', 'agent-aaaa1111.jsonl'), '{"c":3}\n');
    writeFileSync(join(dir, sessionId, 'ignored.txt'), 'not an artifact\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is null when the session is simply not on this machine', () => {
    expect(readSessionTree(join(dir, 'nope'), sessionId, () => true)).toBeNull();
  });

  it('reads the main transcript plus the artifacts the caller recognises', () => {
    const substrate = readSessionTree(dir, sessionId, (path) => path.endsWith('.jsonl'));
    expect(substrate?.files.map((f) => f.relativePath)).toEqual([
      `${sessionId}.jsonl`,
      'subagents/agent-aaaa1111.jsonl',
    ]);
    expect(substrate?.files[0]?.lines).toEqual(['{"a":1}', '{"b":2}', '']);
  });

  it('reads a bare session with no subtree at all', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agenthropic-bare-'));
    writeFileSync(join(bare, `${sessionId}.jsonl`), '{"a":1}\n');
    try {
      expect(readSessionTree(bare, sessionId, () => true)?.files).toHaveLength(1);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
