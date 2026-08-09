/**
 * Hand-labeled hierarchy annotations — the vocabulary and shapes.
 *
 * These types describe *ground truth about a session's agent hierarchy* as
 * stated by a human (or, for the synthetic corpus, as fixed by construction).
 * They are deliberately NOT the parser's output types: an annotation is a
 * claim, the parse is an observation, and the scorer compares the two. Keeping
 * the two vocabularies separate is what makes "the parser agrees with itself"
 * impossible to mistake for "the parser agrees with the truth".
 *
 * Expressiveness requirement (docs/analysis/parser-spec.md):
 * - gate #4 — a depth-2 parent block legitimately lives inside a depth-1 agent
 *   transcript, so a parent claim must be able to name *another subagent*, not
 *   just the session root;
 * - the orphan outcome — "no structural join path exists" is a real, correct
 *   parser answer (never fabricate a parent), so it must be claimable;
 * - abstention — "I cannot tell from this transcript" must be sayable and must
 *   be scored as an abstention, never silently as agreement.
 */

/** Where a set of labels came from. Never blended — see `scoreCorpus`. */
export const PROVENANCES = ['human', 'synthetic-by-construction'] as const;

export type Provenance = (typeof PROVENANCES)[number];

/** Literal parent tokens accepted in the `## edges` section. */
export const ROOT_TOKEN = 'ROOT';
export const ORPHAN_TOKEN = 'ORPHAN';
export const UNKNOWN_TOKEN = 'UNKNOWN';

/**
 * A claim about one subagent's parent.
 *
 * - `root`    — the parent is the session's main agent.
 * - `agent`   — the parent is another subagent (the depth-2 case, gate #4).
 * - `orphan`  — a positive claim: this transcript carries no parent link, and
 *               the parser is *right* to emit no edge.
 * - `unknown` — an abstention: the labeler cannot tell. Scored separately and
 *               excluded from the accuracy ratio; never counted as agreement.
 */
export type ParentClaim =
  | { readonly kind: 'root' }
  | { readonly kind: 'orphan' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'agent'; readonly agentId: string };

/** Which files the annotation is a claim about. */
export type SubstrateRef =
  /** A synthetic fixture from this package, by name. */
  | { readonly kind: 'fixture'; readonly name: string }
  /**
   * A real session tree on disk: a directory holding `<session>.jsonl` next to
   * a `<session>/` subtree. Read-only, always; nothing under it is ever
   * written, moved or "fixed".
   */
  | { readonly kind: 'session-tree'; readonly path: string };

/** One `<child> <- <parent>` line. */
export interface AnnotatedEdge {
  readonly childAgentId: string;
  readonly parent: ParentClaim;
  /** 1-based line number in the source file, for diagnosable errors. */
  readonly line: number;
  /** Trailing `# …` text, kept so the report can echo the labeler's reasoning. */
  readonly comment: string | null;
}

/** One fully parsed and validated annotation file. */
export interface SessionAnnotation {
  /** File name or path the annotation was read from (used in error messages). */
  readonly source: string;
  readonly sessionId: string;
  readonly provenance: Provenance;
  readonly substrate: SubstrateRef;
  readonly labeledBy: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly labeledOn: string;
  readonly notes: readonly string[];
  readonly edges: readonly AnnotatedEdge[];
}

/** One validation problem, tied to a line where one is known. */
export interface AnnotationIssue {
  /** 1-based line number, or `0` for a whole-file problem. */
  readonly line: number;
  readonly message: string;
}

/**
 * Thrown when an annotation file is malformed. Carries *every* problem found,
 * not just the first, so a mistyped file is fixed in one pass.
 */
export class AnnotationError extends Error {
  override readonly name = 'AnnotationError';
  readonly source: string;
  readonly issues: readonly AnnotationIssue[];

  constructor(source: string, issues: readonly AnnotationIssue[]) {
    super(formatIssues(source, issues));
    this.source = source;
    this.issues = issues;
  }
}

function formatIssues(source: string, issues: readonly AnnotationIssue[]): string {
  const header = `${source}: ${String(issues.length)} annotation problem(s)`;
  const body = issues.map((issue) =>
    issue.line === 0
      ? `  ${source}: ${issue.message}`
      : `  ${source}:${String(issue.line)}: ${issue.message}`,
  );
  return [header, ...body].join('\n');
}
