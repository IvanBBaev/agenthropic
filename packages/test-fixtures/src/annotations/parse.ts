/**
 * The annotation loader: text in, a validated {@link SessionAnnotation} out.
 *
 * The file format is Markdown-shaped on purpose — it must be hand-writable in
 * any editor with no tooling, and it must stay readable in a diff. Everything
 * outside the two recognised sections is prose and is ignored, so a labeler can
 * leave notes freely.
 *
 * ```markdown
 * # b24be30c - hand-labeled hierarchy
 *
 * ## meta
 * session: b24be30c-2192-407e-82f0-ae0418dc4b7f
 * provenance: human
 * substrate: session-tree:spike/corpus/sessions/b24be30c/data
 * labeled-by: Ivan Baev
 * labeled-on: 2026-08-07
 * note: read the Task tool_use blocks in the main transcript
 *
 * ## edges
 * a11878d3d183602b8  <-  ROOT
 * a1f14d131efa98db9  <-  a17465ba25dcf4c7c   # depth-2, spawned inside Explore
 * a4350c2690813cb6e  <-  UNKNOWN             # compacted away, cannot tell
 * ```
 *
 * Validation is loud and total: every problem in the file is reported at once,
 * with `file:line`, so a typo is found immediately rather than silently scored.
 */
import {
  AnnotationError,
  ORPHAN_TOKEN,
  PROVENANCES,
  ROOT_TOKEN,
  UNKNOWN_TOKEN,
  type AnnotatedEdge,
  type AnnotationIssue,
  type ParentClaim,
  type Provenance,
  type SessionAnnotation,
  type SubstrateRef,
} from './types.js';

/** File suffix the directory reader picks up. */
export const ANNOTATION_SUFFIX = '.hierarchy.md';

const AGENT_ID_RE = /^[0-9a-f]{4,64}$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The `__________` slot a template ships with - never a valid value. */
const BLANK_RE = /^_+$/;
const EDGE_ARROW = '<-';

const REQUIRED_META_KEYS = ['session', 'provenance', 'substrate', 'labeled-by', 'labeled-on'];
const META_KEYS = [...REQUIRED_META_KEYS, 'note'];

type Section = 'none' | 'meta' | 'edges' | 'other';

interface MetaValue {
  readonly value: string;
  readonly line: number;
}

interface ValidatedMeta {
  readonly sessionId: string;
  readonly provenance: Provenance;
  readonly substrate: SubstrateRef;
  readonly labeledBy: string;
  readonly labeledOn: string;
}

/** Splits a trailing `# …` comment off a line. */
function splitComment(line: string): { body: string; comment: string | null } {
  const hash = line.indexOf('#');
  if (hash === -1) {
    return { body: line.trim(), comment: null };
  }
  return { body: line.slice(0, hash).trim(), comment: line.slice(hash + 1).trim() };
}

function parseParentToken(token: string): ParentClaim | undefined {
  if (token === ROOT_TOKEN) {
    return { kind: 'root' };
  }
  if (token === ORPHAN_TOKEN) {
    return { kind: 'orphan' };
  }
  if (token === UNKNOWN_TOKEN) {
    return { kind: 'unknown' };
  }
  if (AGENT_ID_RE.test(token)) {
    return { kind: 'agent', agentId: token };
  }
  return undefined;
}

function parseSubstrateRef(value: string): SubstrateRef | undefined {
  const separator = value.indexOf(':');
  if (separator === -1) {
    return undefined;
  }
  const kind = value.slice(0, separator).trim();
  const rest = value.slice(separator + 1).trim();
  if (rest === '') {
    return undefined;
  }
  if (kind === 'fixture') {
    return { kind: 'fixture', name: rest };
  }
  if (kind === 'session-tree') {
    return { kind: 'session-tree', path: rest };
  }
  return undefined;
}

/** Reports the first edge that takes part in a cycle of claimed parents. */
function findCycle(edges: readonly AnnotatedEdge[]): AnnotatedEdge | undefined {
  const parentOf = new Map<string, string>();
  for (const edge of edges) {
    if (edge.parent.kind === 'agent') {
      parentOf.set(edge.childAgentId, edge.parent.agentId);
    }
  }
  for (const edge of edges) {
    const seen = new Set<string>([edge.childAgentId]);
    let current = parentOf.get(edge.childAgentId);
    while (current !== undefined) {
      if (seen.has(current)) {
        return edge;
      }
      seen.add(current);
      current = parentOf.get(current);
    }
  }
  return undefined;
}

/**
 * Parses and validates one annotation file.
 *
 * @param source - file name or path, echoed in every error message.
 * @param text - the raw file content.
 * @throws {AnnotationError} listing every problem found, each with its line.
 */
export function parseAnnotation(source: string, text: string): SessionAnnotation {
  const issues: AnnotationIssue[] = [];
  const meta = new Map<string, MetaValue>();
  const notes: string[] = [];
  const edges: AnnotatedEdge[] = [];
  const seenSections = new Set<string>();
  let section: Section = 'none';
  let edgeLineCount = 0;

  text.split('\n').forEach((raw, index) => {
    const lineNo = index + 1;
    const trimmed = raw.replace(/\r$/, '').trim();
    if (trimmed === '') {
      return;
    }

    if (trimmed.startsWith('##')) {
      const name = trimmed.replace(/^#+/, '').trim().toLowerCase();
      if (name === 'meta' || name === 'edges') {
        if (seenSections.has(name)) {
          issues.push({ line: lineNo, message: `duplicate '## ${name}' section` });
        }
        seenSections.add(name);
        section = name;
      } else {
        section = 'other';
      }
      return;
    }

    if (trimmed.startsWith('#')) {
      return; // Title / prose comment line.
    }

    if (section === 'meta') {
      readMetaLine(trimmed, lineNo, meta, notes, issues);
      return;
    }

    // `trimmed` is non-empty and does not start with '#', so the body of the
    // split is always non-empty here.
    const { body, comment } = splitComment(trimmed);

    if (section === 'edges') {
      edgeLineCount += 1;
      readEdgeLine(body, comment, lineNo, edges, issues);
      return;
    }

    if (body.includes(EDGE_ARROW)) {
      issues.push({
        line: lineNo,
        message: `edge-shaped line outside the '## edges' section - move it under '## edges' (a mistyped heading is the usual cause)`,
      });
    }
  });

  checkSections(seenSections, edgeLineCount, issues);
  const validated = validateMeta(seenSections, meta, issues);
  checkEdgeSet(edges, issues);

  if (issues.length > 0) {
    throw new AnnotationError(source, issues);
  }

  return {
    source,
    sessionId: validated.sessionId,
    provenance: validated.provenance,
    substrate: validated.substrate,
    labeledBy: validated.labeledBy,
    labeledOn: validated.labeledOn,
    notes,
    edges,
  };
}

function readMetaLine(
  trimmed: string,
  lineNo: number,
  meta: Map<string, MetaValue>,
  notes: string[],
  issues: AnnotationIssue[],
): void {
  const colon = trimmed.indexOf(':');
  if (colon === -1) {
    issues.push({ line: lineNo, message: `not a 'key: value' line inside '## meta'` });
    return;
  }
  const key = trimmed.slice(0, colon).trim().toLowerCase();
  const value = trimmed.slice(colon + 1).trim();

  if (!META_KEYS.includes(key)) {
    issues.push({
      line: lineNo,
      message: `unknown meta key '${key}' - allowed: ${META_KEYS.join(', ')}`,
    });
    return;
  }
  if (key === 'note') {
    notes.push(value);
    return;
  }
  if (meta.has(key)) {
    issues.push({ line: lineNo, message: `duplicate meta key '${key}'` });
    return;
  }
  if (value === '') {
    issues.push({ line: lineNo, message: `meta key '${key}' has an empty value` });
    return;
  }
  if (BLANK_RE.test(value)) {
    issues.push({
      line: lineNo,
      message: `meta key '${key}' still holds the template blank '${value}' - fill it in`,
    });
    return;
  }
  meta.set(key, { value, line: lineNo });
}

function readEdgeLine(
  body: string,
  comment: string | null,
  lineNo: number,
  edges: AnnotatedEdge[],
  issues: AnnotationIssue[],
): void {
  const arrow = body.indexOf(EDGE_ARROW);
  if (arrow === -1) {
    issues.push({
      line: lineNo,
      message: `expected '<child-agent-hex> <- <${ROOT_TOKEN}|${ORPHAN_TOKEN}|${UNKNOWN_TOKEN}|parent-agent-hex>', got '${body}'`,
    });
    return;
  }
  const child = body.slice(0, arrow).trim();
  const parentToken = body.slice(arrow + EDGE_ARROW.length).trim();

  if (BLANK_RE.test(child)) {
    issues.push({
      line: lineNo,
      message: `unfilled template blank in the child slot ('${child}') - the child agent hex must stay as generated`,
    });
    return;
  }
  if (BLANK_RE.test(parentToken)) {
    issues.push({
      line: lineNo,
      message: `unfilled template blank for '${child}' - replace '${parentToken}' with ${ROOT_TOKEN}, ${ORPHAN_TOKEN}, ${UNKNOWN_TOKEN} or a parent agent hex`,
    });
    return;
  }
  if (!AGENT_ID_RE.test(child)) {
    issues.push({
      line: lineNo,
      message: `'${child}' is not an agent hex (lowercase hex, 4-64 chars, as in 'agent-<hex>.jsonl')`,
    });
    return;
  }
  const parent = parseParentToken(parentToken);
  if (parent === undefined) {
    issues.push({
      line: lineNo,
      message: `'${parentToken}' is not a valid parent - use ${ROOT_TOKEN}, ${ORPHAN_TOKEN}, ${UNKNOWN_TOKEN} or a parent agent hex`,
    });
    return;
  }
  if (parent.kind === 'agent' && parent.agentId === child) {
    issues.push({ line: lineNo, message: `'${child}' is claimed as its own parent` });
    return;
  }
  edges.push({ childAgentId: child, parent, line: lineNo, comment });
}

function checkSections(
  seenSections: ReadonlySet<string>,
  edgeLineCount: number,
  issues: AnnotationIssue[],
): void {
  if (!seenSections.has('meta')) {
    issues.push({ line: 0, message: `missing '## meta' section` });
  }
  if (!seenSections.has('edges')) {
    issues.push({ line: 0, message: `missing '## edges' section` });
    return;
  }
  if (edgeLineCount === 0) {
    issues.push({
      line: 0,
      message: `'## edges' is empty - label at least one agent, or the file claims nothing`,
    });
  }
}

/**
 * Validates the `## meta` block and extracts its values. Always returns a
 * complete record (falling back to inert defaults) so the caller never has to
 * narrow: when anything was wrong, `issues` is non-empty and the caller throws
 * before the defaults can escape.
 */
function validateMeta(
  seenSections: ReadonlySet<string>,
  meta: Map<string, MetaValue>,
  issues: AnnotationIssue[],
): ValidatedMeta {
  if (seenSections.has('meta')) {
    for (const key of REQUIRED_META_KEYS) {
      if (!meta.has(key)) {
        issues.push({ line: 0, message: `missing required meta key '${key}'` });
      }
    }
  }

  const session = meta.get('session');
  if (session !== undefined && !SESSION_ID_RE.test(session.value)) {
    issues.push({
      line: session.line,
      message: `session '${session.value}' is not a session UUID (8-4-4-4-12 lowercase hex)`,
    });
  }

  const provenance = meta.get('provenance');
  if (provenance !== undefined && !(PROVENANCES as readonly string[]).includes(provenance.value)) {
    issues.push({
      line: provenance.line,
      message: `provenance '${provenance.value}' is not one of: ${PROVENANCES.join(', ')}`,
    });
  }
  const resolvedProvenance: Provenance =
    provenance?.value === 'synthetic-by-construction' ? 'synthetic-by-construction' : 'human';

  const substrate = meta.get('substrate');
  const substrateRef = parseSubstrateRef(substrate?.value ?? '');
  if (substrate !== undefined && substrateRef === undefined) {
    issues.push({
      line: substrate.line,
      message: `substrate '${substrate.value}' must be 'fixture:<name>' or 'session-tree:<directory>'`,
    });
  }

  const labeledOn = meta.get('labeled-on');
  if (labeledOn !== undefined && !DATE_RE.test(labeledOn.value)) {
    issues.push({
      line: labeledOn.line,
      message: `labeled-on '${labeledOn.value}' is not a YYYY-MM-DD date`,
    });
  }

  return {
    sessionId: session?.value ?? '',
    provenance: resolvedProvenance,
    substrate: substrateRef ?? { kind: 'fixture', name: '' },
    labeledBy: meta.get('labeled-by')?.value ?? '',
    labeledOn: labeledOn?.value ?? '',
  };
}

function checkEdgeSet(edges: readonly AnnotatedEdge[], issues: AnnotationIssue[]): void {
  const firstLineOf = new Map<string, number>();
  for (const edge of edges) {
    const previous = firstLineOf.get(edge.childAgentId);
    if (previous !== undefined) {
      issues.push({
        line: edge.line,
        message: `duplicate label for '${edge.childAgentId}' (first labeled on line ${String(previous)})`,
      });
      continue;
    }
    firstLineOf.set(edge.childAgentId, edge.line);
  }

  for (const edge of edges) {
    if (edge.parent.kind === 'agent' && !firstLineOf.has(edge.parent.agentId)) {
      issues.push({
        line: edge.line,
        message: `parent '${edge.parent.agentId}' is never labeled as a child in this file - a subagent parent needs its own line (use ${ROOT_TOKEN} if it is top-level)`,
      });
    }
  }

  const cycle = findCycle(edges);
  if (cycle !== undefined) {
    issues.push({
      line: cycle.line,
      message: `'${cycle.childAgentId}' takes part in a parent cycle - a hierarchy cannot contain one`,
    });
  }
}
