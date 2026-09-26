/**
 * LABEL-ME claim renderer (closing plan, lane L10).
 *
 * Turns one hierarchy template (`annotations/templates/<id>.hierarchy.md`) plus
 * the real session tree it names into one markdown page per claim: the child's
 * first record, its sidecar, the parent-side record the parser joined it to,
 * the join path in the parser's own terms, and `file:line` pointers to every
 * raw line involved - so a human can judge a claim in about twenty seconds
 * instead of grepping an 8 MB transcript for a hex.
 *
 * Two things this module is NOT:
 *
 * - It is not the parser. `@agenthropic/core` depends on this package, so the
 *   join cannot be imported from `packages/core/src/parser/parse-session.ts`;
 *   the resolution below MIRRORS it (same regexes, same priority order, same
 *   last-write-wins indices) and every page says so. Where the two disagree the
 *   parser is the authority and this renderer has a bug - the whole point of
 *   the pages is that the human judges the raw records, not the parser's word.
 * - It does not write the substrate. The session tree is read through
 *   `readSessionTree` (read-only by construction); the only writes are the
 *   markdown pages, and the CLI pins those to a git-ignored directory because
 *   they quote real transcript lines.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readSessionTree, type SessionSubstrateLike, type SubstrateFileLike } from './read.js';

type JsonRecord = Record<string, unknown>;

// --- Mirrors of parse-session.ts (deliberately byte-identical) ---------------
const TOOL_USE_ID_RE = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/;
const TASK_ID_RE = /<task-id>([\s\S]*?)<\/task-id>/;
const AGENT_FILE_RE = /^agent-([0-9a-f]+)\.jsonl$/;
const AGENT_META_RE = /^agent-([0-9a-f]+)\.meta\.json$/;
const WORKFLOW_DIR_RE = /^wf_/;
const JOURNAL_BASENAME = 'journal.jsonl';
const JSONL_SUFFIX = '.jsonl';
const LEGACY_EXPLORE_AGENT_TYPE = 'Explore';
const TASK_NOTIFICATION_TAG = '<task-notification>';
const PARSER_SOURCE = 'packages/core/src/parser/parse-session.ts';

// --- Template + page constants -----------------------------------------------
const SESSION_TREE_PREFIX = 'session-tree:';
const EDGE_LINE_RE = /^([0-9a-f]{4,64})\s+<-\s+(\S+)\s*(?:#\s*(.*))?$/;
const PREVIEW_CHARS = 200;
const ROOT_LABEL = 'ROOT';

/** Exact stdout line (and exit code 1) when the session tree is not on this machine. */
export const SUBSTRATE_UNAVAILABLE = 'substrate unavailable';

// --- JSON helpers (same semantics as parse-session.ts) ------------------------
function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

// --- Template ----------------------------------------------------------------

/** One `<child> <- <slot>` line of a template, slot still blank or already filled. */
export interface TemplateClaim {
  readonly childAgentId: string;
  /** 1-based line in the template; the same line number in `human/<file>`. */
  readonly line: number;
  /** Whatever sits in the verdict slot: `__________` on a fresh template. */
  readonly slot: string;
  readonly comment: string | null;
  /** The raw line, echoed on the page so the labeler sees exactly what to fill. */
  readonly text: string;
}

export interface ClaimTemplate {
  readonly source: string;
  readonly sessionId: string;
  /** The `session-tree:` directory, as written (repo-relative or absolute). */
  readonly substrateDir: string;
  readonly claims: readonly TemplateClaim[];
}

/**
 * Lenient template reader. `parseAnnotation` rightly rejects an unfilled
 * `__________`, so the renderer - which runs BEFORE labeling - reads the same
 * two sections with its own tolerant scanner: `## meta` as key/value lines,
 * `## edges` as claim lines whose slot may be blank or filled. Prose outside
 * the sections is ignored exactly as the loader ignores it.
 */
export function readClaimTemplate(source: string, text: string): ClaimTemplate {
  const meta = new Map<string, string>();
  const claims: TemplateClaim[] = [];
  let section = '';
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
    } else if (line === '' || line.startsWith('#')) {
      // Blank, prose or comment line - carries no claim.
    } else if (section === 'meta') {
      const colon = line.indexOf(':');
      if (colon !== -1) {
        meta.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
    } else if (section === 'edges') {
      const match = EDGE_LINE_RE.exec(line);
      if (match === null) {
        throw new Error(`${source}:${String(index + 1)}: not a claim line: ${line}`);
      }
      claims.push({
        childAgentId: String(match[1]),
        line: index + 1,
        slot: String(match[2]),
        comment: match[3] ?? null,
        text: line,
      });
    }
  });

  const sessionId = meta.get('session');
  if (sessionId === undefined) {
    throw new Error(`${source}: meta has no 'session:' line`);
  }
  const substrate = meta.get('substrate') ?? '';
  if (!substrate.startsWith(SESSION_TREE_PREFIX)) {
    throw new Error(
      `${source}: substrate must be '${SESSION_TREE_PREFIX}<dir>' (got '${substrate}')`,
    );
  }
  return { source, sessionId, substrateDir: substrate.slice(SESSION_TREE_PREFIX.length), claims };
}

// --- Substrate index (mirrors buildIndices / collectSidecars) -----------------

/** One JSONL record with the file and 1-based line it was read from. */
export interface RecordRef {
  readonly file: string;
  readonly line: number;
  readonly record: JsonRecord;
}

interface OwnedRef extends RecordRef {
  /** Owning transcript: the session id for the main transcript, else the agent hex. */
  readonly owner: string;
}

interface ToolUseBlockRef extends OwnedRef {
  readonly id: string;
  readonly block: JsonRecord;
  readonly name: string;
}

interface AnchorRef extends OwnedRef {
  readonly toolUseId: string;
}

interface AgentEntry {
  readonly hex: string;
  readonly file: string;
  readonly workflowId: string | null;
  readonly firstRecord: RecordRef | null;
}

interface SidecarEntry {
  readonly file: string;
  readonly record: RecordRef | null;
  readonly toolUseId: string | null;
  readonly agentType: string | null;
  readonly isLegacyBareExplore: boolean;
}

export interface SpawnIndex {
  readonly sessionId: string;
  readonly fileCount: number;
  /** `file:line` of every line that is not a JSON object - the parser would refuse the session. */
  readonly unparseableLines: readonly string[];
  readonly agents: ReadonlyMap<string, AgentEntry>;
  readonly sidecars: ReadonlyMap<string, SidecarEntry>;
  /** Every `tool_use` block by id, whatever its name (for the "exists but not indexed" note). */
  readonly toolUseBlocks: ReadonlyMap<string, ToolUseBlockRef>;
  /** The parser's `toolUseOwner`: only `Agent` / `Workflow` blocks. */
  readonly spawnBlocks: ReadonlyMap<string, ToolUseBlockRef>;
  /** `input.workflow_id` -> the `Workflow` block that carried it. */
  readonly workflowDispatchers: ReadonlyMap<string, ToolUseBlockRef>;
  /** `<tool-use-id>` -> the `queue-operation` record that carried it. */
  readonly queueOps: ReadonlyMap<string, OwnedRef>;
  /** `<task-id>` (child hex) -> that record's `<tool-use-id>`. */
  readonly queueChildToToolUse: ReadonlyMap<string, string>;
  /** child hex -> parent-side `type:'user'` record whose `toolUseResult.agentId` names it. */
  readonly toolUseResultByChildHex: ReadonlyMap<string, AnchorRef>;
  /** child hex -> foreign `progress` record naming it by top-level `agentId`. */
  readonly legacyProgressOwner: ReadonlyMap<string, OwnedRef>;
}

interface MutableIndex {
  agents: Map<string, AgentEntry>;
  sidecars: Map<string, SidecarEntry>;
  toolUseBlocks: Map<string, ToolUseBlockRef>;
  spawnBlocks: Map<string, ToolUseBlockRef>;
  workflowDispatchers: Map<string, ToolUseBlockRef>;
  queueOps: Map<string, OwnedRef>;
  queueChildToToolUse: Map<string, string>;
  toolUseResultByChildHex: Map<string, AnchorRef>;
  legacyProgressOwner: Map<string, OwnedRef>;
  unparseableLines: string[];
}

/**
 * The parser's artifact allowlist, mirrored: `agent-<hex>.jsonl`,
 * `agent-<hex>.meta.json` and `journal.jsonl` anywhere under the session
 * subtree. Everything else (`tool-results/*.txt`, stray notes) is not read.
 */
export function isParserArtifact(relativePath: string): boolean {
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return (
    AGENT_META_RE.test(basename) || AGENT_FILE_RE.test(basename) || basename === JOURNAL_BASENAME
  );
}

function parseLines(file: SubstrateFileLike, unparseable: string[]): RecordRef[] {
  const refs: RecordRef[] = [];
  file.lines.forEach((raw, index) => {
    if (raw.trim() === '') {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      unparseable.push(`${file.relativePath}:${String(index + 1)}`);
      return;
    }
    const record = asRecord(value);
    if (record === undefined) {
      unparseable.push(`${file.relativePath}:${String(index + 1)}`);
      return;
    }
    refs.push({ file: file.relativePath, line: index + 1, record });
  });
  return refs;
}

function indexAssistant(ref: RecordRef, owner: string, index: MutableIndex): void {
  const content = asArray(asRecord(ref.record['message'])?.['content']);
  if (content === undefined) {
    return;
  }
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === undefined || asString(block['type']) !== 'tool_use') {
      continue;
    }
    const id = asString(block['id']);
    if (id === undefined) {
      continue;
    }
    const name = asString(block['name']) ?? '';
    const blockRef: ToolUseBlockRef = { ...ref, owner, id, block, name };
    index.toolUseBlocks.set(id, blockRef);
    if (name !== 'Agent' && name !== 'Workflow') {
      continue;
    }
    index.spawnBlocks.set(id, blockRef);
    const workflowId = asString(asRecord(block['input'])?.['workflow_id']);
    if (name === 'Workflow' && workflowId !== undefined) {
      index.workflowDispatchers.set(workflowId, blockRef);
    }
  }
}

function indexQueueOperation(ref: RecordRef, owner: string, index: MutableIndex): void {
  const content = asString(ref.record['content']);
  if (content === undefined) {
    return;
  }
  const toolUseId = TOOL_USE_ID_RE.exec(content)?.[1];
  if (toolUseId === undefined) {
    return;
  }
  index.queueOps.set(toolUseId, { ...ref, owner });
  const childHex = TASK_ID_RE.exec(content)?.[1];
  if (childHex !== undefined) {
    index.queueChildToToolUse.set(childHex, toolUseId);
  }
}

function indexUser(ref: RecordRef, owner: string, index: MutableIndex): void {
  const childHex = asString(asRecord(ref.record['toolUseResult'])?.['agentId']);
  if (childHex === undefined) {
    return;
  }
  const blocks = asArray(asRecord(ref.record['message'])?.['content']);
  if (blocks === undefined) {
    return;
  }
  for (const rawBlock of blocks) {
    const block = asRecord(rawBlock);
    if (block === undefined || asString(block['type']) !== 'tool_result') {
      continue;
    }
    const toolUseId = asString(block['tool_use_id']);
    if (toolUseId !== undefined) {
      index.toolUseResultByChildHex.set(childHex, { ...ref, owner, toolUseId });
      return;
    }
  }
}

function indexProgress(ref: RecordRef, owner: string, index: MutableIndex): void {
  const childHex = asString(ref.record['agentId']);
  if (childHex !== undefined && childHex !== owner) {
    index.legacyProgressOwner.set(childHex, { ...ref, owner });
  }
}

function indexTranscript(refs: readonly RecordRef[], owner: string, index: MutableIndex): void {
  for (const ref of refs) {
    const type = asString(ref.record['type']);
    if (type === 'assistant') {
      indexAssistant(ref, owner, index);
    } else if (type === 'queue-operation') {
      indexQueueOperation(ref, owner, index);
    } else if (type === 'user') {
      indexUser(ref, owner, index);
    } else if (type === 'progress') {
      indexProgress(ref, owner, index);
    }
  }
}

function readSidecar(hex: string, file: SubstrateFileLike, index: MutableIndex): void {
  const first = parseLines(file, index.unparseableLines)[0];
  if (first === undefined) {
    index.sidecars.set(hex, {
      file: file.relativePath,
      record: null,
      toolUseId: null,
      agentType: null,
      isLegacyBareExplore: false,
    });
    return;
  }
  const record = first.record;
  const agentType = asString(record['agentType']) ?? null;
  index.sidecars.set(hex, {
    file: file.relativePath,
    record: first,
    toolUseId: asString(record['toolUseId']) ?? null,
    agentType,
    isLegacyBareExplore:
      agentType === LEGACY_EXPLORE_AGENT_TYPE &&
      !('toolUseId' in record) &&
      !('spawnDepth' in record),
  });
}

/** Scans every transcript once, the way `buildIndices` does, keeping `file:line` on each hit. */
export function buildSpawnIndex(sessionId: string, substrate: SessionSubstrateLike): SpawnIndex {
  const index: MutableIndex = {
    agents: new Map(),
    sidecars: new Map(),
    toolUseBlocks: new Map(),
    spawnBlocks: new Map(),
    workflowDispatchers: new Map(),
    queueOps: new Map(),
    queueChildToToolUse: new Map(),
    toolUseResultByChildHex: new Map(),
    legacyProgressOwner: new Map(),
    unparseableLines: [],
  };

  for (const file of substrate.files) {
    const basename = file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1);
    const metaHex = AGENT_META_RE.exec(basename)?.[1];
    if (metaHex !== undefined) {
      readSidecar(metaHex, file, index);
      continue;
    }
    const agentHex = AGENT_FILE_RE.exec(basename)?.[1];
    if (agentHex !== undefined) {
      const refs = parseLines(file, index.unparseableLines);
      index.agents.set(agentHex, {
        hex: agentHex,
        file: file.relativePath,
        workflowId:
          file.relativePath.split('/').find((segment) => WORKFLOW_DIR_RE.test(segment)) ?? null,
        firstRecord: refs[0] ?? null,
      });
      indexTranscript(refs, agentHex, index);
    } else if (
      basename !== JOURNAL_BASENAME &&
      !file.relativePath.includes('/') &&
      basename.endsWith(JSONL_SUFFIX)
    ) {
      // The main transcript: the parser's `classifyFile` checks journal before main.
      indexTranscript(parseLines(file, index.unparseableLines), sessionId, index);
    }
    // journal.jsonl and anything else: not a transcript, never indexed.
  }

  return { sessionId, fileCount: substrate.files.length, ...index };
}

// --- Resolution (mirrors resolveParent) --------------------------------------

export type JoinKind =
  | 'tool_use'
  | 'directory'
  | 'queue_operation'
  | 'task_notification'
  | 'legacy_explore'
  | 'orphan'
  | 'child_missing';

export interface EvidenceLine {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

export interface ClaimResolution {
  readonly childAgentId: string;
  readonly kind: JoinKind;
  /** `ROOT`, a parent hex, or `null` when the parser emits no edge (or never sees the child). */
  readonly parserParent: string | null;
  readonly anchor: string | null;
  readonly child: RecordRef | null;
  readonly childFile: string | null;
  readonly sidecar: RecordRef | null;
  /** The parent-side record the parser joined on; `null` when the join names no record. */
  readonly parent: RecordRef | null;
  /** The matched `tool_use` block inside `parent`, when the join went through one. */
  readonly parentBlock: JsonRecord | null;
  /** The join, step by step, in the parser's terms. */
  readonly steps: readonly string[];
  readonly evidence: readonly EvidenceLine[];
}

function ownerLabel(index: SpawnIndex, owner: string): string {
  return owner === index.sessionId ? ROOT_LABEL : owner;
}

function describeOwner(index: SpawnIndex, owner: string): string {
  return owner === index.sessionId
    ? `the main transcript (${ROOT_LABEL})`
    : `the transcript of agent ${owner} (a depth-2 parent - write that hex)`;
}

interface Draft {
  kind: JoinKind;
  parserParent: string | null;
  anchor: string | null;
  parent: RecordRef | null;
  parentBlock: JsonRecord | null;
  steps: string[];
  evidence: EvidenceLine[];
}

function resolveWorkflowChild(index: SpawnIndex, workflowId: string, draft: Draft): void {
  draft.kind = 'directory';
  const dispatcher = index.workflowDispatchers.get(workflowId);
  if (dispatcher !== undefined) {
    draft.parserParent = ownerLabel(index, dispatcher.owner);
    draft.parent = dispatcher;
    draft.parentBlock = dispatcher.block;
    draft.steps.push(
      `a Workflow tool_use block carries input.workflow_id = ${workflowId} at ${dispatcher.file}:${String(dispatcher.line)}, owned by ${describeOwner(index, dispatcher.owner)}`,
      "parser edge: source 'directory', parent = that block's owner",
    );
    draft.evidence.push({
      file: dispatcher.file,
      line: dispatcher.line,
      what: `Workflow tool_use block ${dispatcher.id} (dispatcher)`,
    });
    return;
  }
  draft.parserParent = ROOT_LABEL;
  draft.steps.push(
    `no Workflow tool_use block in any transcript carries input.workflow_id = ${workflowId}; the parser falls back to the main session by directory alone`,
    `parser edge: source 'directory', parent = ${ROOT_LABEL} (no parent-side record names this child)`,
  );
  for (const block of index.toolUseBlocks.values()) {
    if (block.name === 'Workflow') {
      draft.evidence.push({
        file: block.file,
        line: block.line,
        what: `Workflow tool_use block ${block.id} owned by ${ownerLabel(index, block.owner)} - a candidate the parser did NOT match (no workflow_id), shown for orientation only`,
      });
    }
  }
}

function resolveAnchoredChild(index: SpawnIndex, anchor: string, draft: Draft): void {
  draft.anchor = anchor;
  const spawn = index.spawnBlocks.get(anchor);
  if (spawn !== undefined) {
    draft.kind = 'tool_use';
    draft.parserParent = ownerLabel(index, spawn.owner);
    draft.parent = spawn;
    draft.parentBlock = spawn.block;
    draft.steps.push(
      `anchor ${anchor} names a ${spawn.name} tool_use block at ${spawn.file}:${String(spawn.line)}, owned by ${describeOwner(index, spawn.owner)}`,
      "parser edge: source 'tool_use', parent = that block's owner",
    );
    draft.evidence.push({
      file: spawn.file,
      line: spawn.line,
      what: `${spawn.name} tool_use block ${anchor} (the parent-side spawn)`,
    });
    return;
  }
  const queue = index.queueOps.get(anchor);
  if (queue !== undefined) {
    draft.kind = 'queue_operation';
    draft.parserParent = ownerLabel(index, queue.owner);
    draft.parent = queue;
    draft.steps.push(
      `anchor ${anchor} names no Agent/Workflow tool_use block, but a queue-operation record at ${queue.file}:${String(queue.line)} carries it as <tool-use-id>, owned by ${describeOwner(index, queue.owner)}`,
      "parser edge: source 'queue_operation', parent = that record's owner",
    );
    draft.evidence.push({
      file: queue.file,
      line: queue.line,
      what: `queue-operation record carrying <tool-use-id>${anchor}</tool-use-id>`,
    });
    return;
  }
  draft.kind = 'task_notification';
  draft.parserParent = ROOT_LABEL;
  draft.steps.push(
    `anchor ${anchor} names no Agent/Workflow tool_use block and no queue-operation record in any transcript (compaction-evicted); the parser re-anchors the edge to the main session`,
    `parser edge: source 'task_notification', parent = ${ROOT_LABEL} (no surviving parent-side record)`,
  );
  const other = index.toolUseBlocks.get(anchor);
  if (other !== undefined) {
    draft.steps.push(
      `note: a tool_use block with id ${anchor} DOES exist at ${other.file}:${String(other.line)} but its name is '${other.name}', which the parser does not index as a spawn`,
    );
    draft.evidence.push({
      file: other.file,
      line: other.line,
      what: `tool_use block ${anchor} named '${other.name}' - NOT a spawn block to the parser`,
    });
  }
}

function extractTaskNotificationToolUseId(first: RecordRef | null): string | undefined {
  const content = asString(asRecord(first?.record['message'])?.['content']);
  if (content === undefined || !content.includes(TASK_NOTIFICATION_TAG)) {
    return undefined;
  }
  return TOOL_USE_ID_RE.exec(content)?.[1];
}

function resolveFlatChild(
  index: SpawnIndex,
  child: AgentEntry,
  sidecar: SidecarEntry | undefined,
  draft: Draft,
): void {
  if (sidecar !== undefined && sidecar.toolUseId !== null) {
    draft.steps.push(
      `sidecar ${sidecar.file} carries toolUseId = ${sidecar.toolUseId} (primary anchor)`,
    );
    resolveAnchoredChild(index, sidecar.toolUseId, draft);
    return;
  }
  draft.steps.push(
    sidecar === undefined
      ? 'no agent-<hex>.meta.json sidecar for this child'
      : `sidecar ${sidecar.file} carries no toolUseId`,
  );

  const result = index.toolUseResultByChildHex.get(child.hex);
  if (result !== undefined) {
    draft.steps.push(
      `a type:'user' record at ${result.file}:${String(result.line)} (owned by ${describeOwner(index, result.owner)}) carries toolUseResult.agentId = ${child.hex}; its sibling tool_result.tool_use_id = ${result.toolUseId} is the anchor`,
    );
    draft.evidence.push({
      file: result.file,
      line: result.line,
      what: `parent-side user record with toolUseResult.agentId = ${child.hex}`,
    });
    resolveAnchoredChild(index, result.toolUseId, draft);
    return;
  }
  draft.steps.push(`no type:'user' record carries toolUseResult.agentId = ${child.hex}`);

  const queued = index.queueChildToToolUse.get(child.hex);
  if (queued !== undefined) {
    draft.steps.push(
      `a queue-operation record carries <task-id>${child.hex}</task-id>; its <tool-use-id> ${queued} is the anchor`,
    );
    resolveAnchoredChild(index, queued, draft);
    return;
  }
  draft.steps.push(`no queue-operation record carries <task-id>${child.hex}</task-id>`);

  const recovered = extractTaskNotificationToolUseId(child.firstRecord);
  if (recovered !== undefined) {
    draft.kind = 'task_notification';
    draft.parserParent = ROOT_LABEL;
    draft.anchor = recovered;
    draft.steps.push(
      `the child's first record carries a <task-notification> with <tool-use-id>${recovered}</tool-use-id> (legacy child-side recovery)`,
      `parser edge: source 'task_notification', parent = ${ROOT_LABEL}`,
    );
    return;
  }
  draft.steps.push("the child's first record carries no <task-notification> tool-use-id");

  if (sidecar?.isLegacyBareExplore === true) {
    const progress = index.legacyProgressOwner.get(child.hex);
    if (progress !== undefined) {
      draft.kind = 'legacy_explore';
      draft.parserParent = ownerLabel(index, progress.owner);
      draft.parent = progress;
      draft.steps.push(
        `sidecar is the bare legacy {agentType: 'Explore'} shape and a progress record at ${progress.file}:${String(progress.line)} owned by ${describeOwner(index, progress.owner)} names ${child.hex} as its top-level agentId`,
        "parser edge: source 'legacy_explore' (inferred, never 'tool_use'), parent = that record's owner",
      );
      draft.evidence.push({
        file: progress.file,
        line: progress.line,
        what: `foreign progress record with top-level agentId = ${child.hex}`,
      });
      return;
    }
    draft.steps.push(
      `sidecar is the bare legacy {agentType: 'Explore'} shape but no foreign progress record names ${child.hex}`,
    );
  }

  draft.kind = 'orphan';
  draft.parserParent = null;
  draft.steps.push(
    'no structural join path - the parser emits NO edge (never fabricates a parent)',
  );
}

/** Resolves one template claim the way the parser would, keeping every record it touched. */
export function resolveClaim(index: SpawnIndex, childAgentId: string): ClaimResolution {
  const child = index.agents.get(childAgentId);
  const draft: Draft = {
    kind: 'child_missing',
    parserParent: null,
    anchor: null,
    parent: null,
    parentBlock: null,
    steps: [],
    evidence: [],
  };

  if (child === undefined) {
    draft.steps.push(
      `no agent-${childAgentId}.jsonl exists anywhere under the session subtree (flat or workflows/wf_*/) - the parser never sees this agent and claims nothing about it`,
    );
    return {
      childAgentId,
      child: null,
      childFile: null,
      sidecar: null,
      ...draft,
    };
  }

  draft.steps.push(
    `child transcript ${child.file} (${child.workflowId === null ? 'flat layout' : `nested layout, workflow dir ${child.workflowId}`})`,
  );
  if (child.firstRecord === null) {
    draft.steps.push('the child transcript holds no JSON record');
  } else {
    draft.evidence.push({
      file: child.firstRecord.file,
      line: child.firstRecord.line,
      what: "the child's first record",
    });
  }

  const sidecar = index.sidecars.get(childAgentId);
  if (sidecar !== undefined && sidecar.record !== null) {
    draft.evidence.push({ file: sidecar.file, line: sidecar.record.line, what: 'the sidecar' });
  }

  if (child.workflowId === null) {
    resolveFlatChild(index, child, sidecar, draft);
  } else {
    resolveWorkflowChild(index, child.workflowId, draft);
  }

  return {
    childAgentId,
    child: child.firstRecord,
    childFile: child.file,
    sidecar: sidecar?.record ?? null,
    ...draft,
  };
}

// --- Rendering ---------------------------------------------------------------

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

function summariseBlock(raw: unknown): string {
  const block = asRecord(raw);
  if (block === undefined) {
    return String(raw);
  }
  const type = asString(block['type']) ?? '?';
  if (type === 'tool_use') {
    return `tool_use ${asString(block['name']) ?? '?'} ${asString(block['id']) ?? '?'}`;
  }
  if (type === 'tool_result') {
    return `tool_result ${asString(block['tool_use_id']) ?? '?'}`;
  }
  if (type === 'text') {
    return `text: ${asString(block['text']) ?? ''}`;
  }
  return type;
}

/** First ~200 chars of a record's content: a string as is, block arrays as `type ...` summaries. */
export function previewContent(content: unknown): string | null {
  const text = asString(content);
  if (text !== undefined) {
    return truncate(text);
  }
  const blocks = asArray(content);
  if (blocks === undefined) {
    return null;
  }
  return truncate(blocks.map(summariseBlock).join(' | '));
}

const IDENTIFYING_KEYS = [
  'uuid',
  'parentUuid',
  'timestamp',
  'type',
  'subtype',
  'operation',
  'agentId',
  'isSidechain',
  'sessionId',
] as const;

/** The identifying fields of a record plus a content preview - never the whole line. */
export function describeRecord(record: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const key of IDENTIFYING_KEYS) {
    if (key in record) {
      out[key] = record[key];
    }
  }
  const toolUseResult = asRecord(record['toolUseResult']);
  if (toolUseResult !== undefined && 'agentId' in toolUseResult) {
    out['toolUseResult.agentId'] = toolUseResult['agentId'];
  }
  const message = asRecord(record['message']);
  const preview = previewContent(message === undefined ? record['content'] : message['content']);
  if (preview !== null) {
    out['contentPreview'] = preview;
  }
  return out;
}

const INPUT_KEYS = ['subagent_type', 'description', 'workflow_id', 'run_in_background'] as const;

/** A `tool_use` block reduced to what identifies the spawn: id, name, the labeled input fields. */
export function describeToolUseBlock(block: JsonRecord): JsonRecord {
  const out: JsonRecord = { type: block['type'], id: block['id'], name: block['name'] };
  const input = asRecord(block['input']);
  if (input === undefined) {
    return out;
  }
  const shown: JsonRecord = {};
  for (const key of INPUT_KEYS) {
    if (key in input) {
      shown[key] = input[key];
    }
  }
  const prompt = asString(input['prompt']);
  if (prompt !== undefined) {
    shown['prompt'] = truncate(prompt);
  }
  out['input'] = shown;
  out['inputKeys'] = Object.keys(input);
  return out;
}

function jsonFence(value: unknown): string[] {
  return ['```json', JSON.stringify(value, null, 2), '```', ''];
}

function ownerOfFile(file: string): string {
  const hex = AGENT_FILE_RE.exec(file.slice(file.lastIndexOf('/') + 1))?.[1];
  return hex === undefined ? ROOT_LABEL : hex;
}

function parentAbsenceReason(kind: JoinKind): string {
  switch (kind) {
    case 'directory':
      return 'workflow subagents are joined by directory alone; no parent-side record names this child (candidates, if any, are listed under evidence and were NOT matched by the parser).';
    case 'task_notification':
      return 'the anchor names no surviving parent-side record; the parser re-anchors to the main session on the strength of the anchor alone.';
    case 'orphan':
      return 'no join path exists; the parser emits no edge, i.e. its answer is ORPHAN.';
    default:
      return 'the child transcript itself was not found, so there is nothing to join.';
  }
}

/** One markdown page for one claim. */
export function renderClaimPage(
  template: ClaimTemplate,
  claim: TemplateClaim,
  resolution: ClaimResolution,
): string {
  const lines: string[] = [
    `# Claim \`${claim.childAgentId}\` - ${template.source} line ${String(claim.line)}`,
    '',
    'Template line:',
    '',
    '```',
    claim.text,
    '```',
    '',
    '## Verdict slot',
    '',
    `Write into \`human/${template.source}\` line ${String(claim.line)}:`,
    '',
    '```',
    `${claim.childAgentId} <- ROOT | <parent hex> | ORPHAN | UNKNOWN`,
    '```',
    '',
    `Parser reading: **${resolution.parserParent ?? 'ORPHAN (no edge)'}** via \`${resolution.kind}\`. Judge the raw records below; the verdict is yours, not the parser's - a disagreement is exactly what this corpus exists to find.`,
    '',
  ];

  lines.push('## Child record', '');
  if (resolution.child === null) {
    lines.push(
      resolution.childFile === null
        ? `**Child transcript not found.** No \`agent-${claim.childAgentId}.jsonl\` exists under the session subtree (flat or \`workflows/wf_*/\`). Nothing on this page can be judged from the render; write \`UNKNOWN\` unless you can locate the transcript by hand.`
        : `**Child transcript \`${resolution.childFile}\` holds no JSON record.**`,
      '',
    );
  } else {
    lines.push(`\`${resolution.child.file}:${String(resolution.child.line)}\``, '');
    lines.push(...jsonFence(describeRecord(resolution.child.record)));
  }

  if (resolution.sidecar !== null) {
    lines.push('## Sidecar', '');
    lines.push(`\`${resolution.sidecar.file}:${String(resolution.sidecar.line)}\``, '');
    lines.push(...jsonFence(resolution.sidecar.record));
  }

  lines.push('## Parent record', '');
  if (resolution.parent === null) {
    lines.push(`_No parent-side record: ${parentAbsenceReason(resolution.kind)}_`, '');
  } else {
    lines.push(
      `\`${resolution.parent.file}:${String(resolution.parent.line)}\` (owner: ${ownerOfFile(resolution.parent.file)})`,
      '',
    );
    lines.push(...jsonFence(describeRecord(resolution.parent.record)));
    if (resolution.parentBlock !== null) {
      lines.push('Matched block:', '');
      lines.push(...jsonFence(describeToolUseBlock(resolution.parentBlock)));
    }
  }

  lines.push(`## Join path (the parser's resolution, mirrored from ${PARSER_SOURCE})`, '');
  resolution.steps.forEach((step, i) => {
    lines.push(`${String(i + 1)}. ${step}`);
  });
  lines.push('');

  lines.push('## Raw evidence lines', '');
  if (resolution.evidence.length === 0) {
    lines.push('_none_');
  }
  for (const item of resolution.evidence) {
    lines.push(`- \`${item.file}:${String(item.line)}\` - ${item.what}`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface ClaimRender {
  readonly claim: TemplateClaim;
  readonly resolution: ClaimResolution;
  readonly page: string;
}

export interface RenderStats {
  readonly claims: number;
  /** Child record AND a parent-side record both located. */
  readonly bothRecordsFound: number;
  readonly childMissing: number;
  /** Child found, but the join names no parent-side record (directory / task_notification / orphan). */
  readonly parentRecordAbsent: number;
}

export interface RenderedTemplate {
  readonly template: ClaimTemplate;
  readonly index: string;
  readonly claims: readonly ClaimRender[];
  readonly stats: RenderStats;
}

function recordsLabel(resolution: ClaimResolution): string {
  if (resolution.child === null && resolution.childFile === null) {
    return 'child missing';
  }
  return resolution.parent === null ? 'child only' : 'both';
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** The index page: one row per claim with a verdict checkbox and a link to its page. */
export function renderIndexPage(
  template: ClaimTemplate,
  claims: readonly ClaimRender[],
  index: SpawnIndex,
  stats: RenderStats,
): string {
  const lines: string[] = [
    `# LABEL-ME claims - ${template.source} (session ${template.sessionId})`,
    '',
    `Substrate: \`${SESSION_TREE_PREFIX}${template.substrateDir}\` - ${String(index.fileCount)} artifact files read, ${String(index.agents.size)} agent transcripts, ${String(index.sidecars.size)} sidecars.`,
    '',
    `Claims: ${String(stats.claims)} - both records found: ${String(stats.bothRecordsFound)} - child transcript missing: ${String(stats.childMissing)} - parent record absent: ${String(stats.parentRecordAbsent)}.`,
    '',
  ];
  if (index.unparseableLines.length > 0) {
    lines.push(
      `**${String(index.unparseableLines.length)} line(s) are not JSON objects and were skipped** (the parser itself would refuse this session with a SubstrateError): ${index.unparseableLines.slice(0, 10).join(', ')}${index.unparseableLines.length > 10 ? ', ...' : ''}`,
      '',
    );
  }
  lines.push(
    'Tick the box once the verdict is written into `human/` - the page tells you which line.',
    '',
    '| verdict | # | claim | line | parser join | parser parent | records | comment | page |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  claims.forEach(({ claim, resolution }, i) => {
    lines.push(
      `| [ ] | ${String(i + 1)} | \`${claim.childAgentId}\` | ${String(claim.line)} | ${resolution.kind} | ${resolution.parserParent ?? 'ORPHAN (no edge)'} | ${recordsLabel(resolution)} | ${escapeCell(claim.comment ?? '')} | [page](claims/${claim.childAgentId}.md) |`,
    );
  });
  lines.push('');
  return lines.join('\n');
}

/** Renders every claim of a template against a substrate. Pure: nothing is written. */
export function renderClaims(
  template: ClaimTemplate,
  substrate: SessionSubstrateLike,
): RenderedTemplate {
  const index = buildSpawnIndex(template.sessionId, substrate);
  const claims: ClaimRender[] = template.claims.map((claim) => {
    const resolution = resolveClaim(index, claim.childAgentId);
    return { claim, resolution, page: renderClaimPage(template, claim, resolution) };
  });
  const stats: RenderStats = {
    claims: claims.length,
    bothRecordsFound: claims.filter((c) => recordsLabel(c.resolution) === 'both').length,
    childMissing: claims.filter((c) => recordsLabel(c.resolution) === 'child missing').length,
    parentRecordAbsent: claims.filter((c) => recordsLabel(c.resolution) === 'child only').length,
  };
  return { template, index: renderIndexPage(template, claims, index, stats), claims, stats };
}

/** Writes `index.md` and `claims/<hex>.md` under `outDir` (created as needed). */
export function writeRender(outDir: string, rendered: RenderedTemplate): void {
  mkdirSync(join(outDir, 'claims'), { recursive: true });
  writeFileSync(join(outDir, 'index.md'), rendered.index, 'utf8');
  for (const { claim, page } of rendered.claims) {
    writeFileSync(join(outDir, 'claims', `${claim.childAgentId}.md`), page, 'utf8');
  }
}

// --- CLI ---------------------------------------------------------------------

export interface RenderIo {
  /** Repo root: `session-tree:` paths in templates are repo-relative, as in the gate. */
  readonly repoRoot: string;
  /** The test-fixtures package dir: templates are read from, and pages written under, `annotations/`. */
  readonly packageDir: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** Relative dir of the rendered pages under the package - listed in `annotations/.gitignore`. */
export const RENDER_DIR = join('annotations', '.render');

/**
 * `render-claims <template-id>`: renders `annotations/templates/<id>.hierarchy.md`
 * into `annotations/.render/<id>/`. Exit codes: 0 rendered, 1 substrate
 * unavailable (stdout is exactly `substrate unavailable`), 2 usage / template
 * error.
 */
export function runRenderClaims(rawArgv: readonly string[], io: RenderIo): number {
  // pnpm forwards a literal '--' to the script, so `pnpm ... render-claims -- <id>`
  // arrives as ['--', '<id>']; drop that separator and nothing else.
  const argv = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv;
  const id = argv[0];
  if (id === undefined || argv.length !== 1) {
    io.stderr(
      'usage: render-claims <template-id>   (e.g. b24be30c, for annotations/templates/b24be30c.hierarchy.md)',
    );
    return 2;
  }
  const source = `${id}.hierarchy.md`;
  const templatePath = join(io.packageDir, 'annotations', 'templates', source);
  if (!existsSync(templatePath)) {
    io.stderr(`template not found: ${templatePath}`);
    return 2;
  }
  const template = readClaimTemplate(source, readFileSync(templatePath, 'utf8'));
  const dir = isAbsolute(template.substrateDir)
    ? template.substrateDir
    : join(io.repoRoot, template.substrateDir);
  const substrate = readSessionTree(dir, template.sessionId, isParserArtifact);
  if (substrate === null) {
    io.stdout(SUBSTRATE_UNAVAILABLE);
    io.stderr(
      `${SUBSTRATE_UNAVAILABLE}: ${join(dir, `${template.sessionId}.jsonl`)} is not on this machine`,
    );
    return 1;
  }

  const rendered = renderClaims(template, substrate);
  const outDir = join(io.packageDir, RENDER_DIR, id);
  writeRender(outDir, rendered);
  const { stats } = rendered;
  io.stdout(`rendered ${String(stats.claims)} claims -> ${outDir}`);
  io.stdout(
    `both records found: ${String(stats.bothRecordsFound)}; child transcript missing: ${String(stats.childMissing)}; parent record absent: ${String(stats.parentRecordAbsent)}`,
  );
  return 0;
}
