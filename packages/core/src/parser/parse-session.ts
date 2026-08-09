/**
 * Pure read-side reconstruction parser (WP-IN8 core) — parser-spec sections
 * 3-6. Data-in / data-out: it receives already-read file contents
 * ({@link SessionSubstrate}) and returns an in-memory {@link ParsedSession} of
 * agents, spawn edges and message-deduped usage. It performs NO filesystem or
 * network I/O (reading `~/.claude/projects` is the WP-IN5 adapter's job) and
 * imports only the standard library and `@agenthropic/shared` — the moat IP.
 *
 * Resolution branches on layout (gate #2): a `workflows/wf_<id>/` file is joined
 * by directory; a flat `subagents/agent-<hex>` file is joined by anchoring its
 * hex to a parent spawn-block id — from the `agent-<hex>.meta.json` sidecar
 * (primary), a parent-side async `toolUseResult`, or a queue-operation
 * `<task-id>` — then classified tool_use -> queue_operation -> task_notification
 * -> orphan. Ids are matched by structural POSITION, never substring (gate #5):
 * a `tool_use.id` mentioned in prose text must never forge an edge.
 *
 * Loud vs tolerant (a MUST distinction):
 * - THROW {@link SubstrateError} on structurally malformed / contradictory
 *   substrate: a non-JSON line, an `agent-<hex>.jsonl` whose inline `agentId`
 *   disagrees with the filename hex, two agent files sharing a hex, a
 *   `sessionId` contradiction across records, or a transcript with no
 *   timestamped record.
 * - Let {@link dedupeUsageByMessageId} throw `UsageConflictError` when rows
 *   sharing a `message.id` disagree on `model` or `agentId` — a colliding, not
 *   streamed, substrate (never caught here). Streamed usage partials collapse
 *   to the per-bucket maximum, they do not throw.
 * - TOLERATE records of an unknown/unrecognized `type` (stored, not crashed):
 *   the parser simply ignores record types it has no rule for.
 */
import type { OrchestrationEdgeSource } from '@agenthropic/shared';
import type { DedupedUsage, TokenBuckets, UsageRow } from '../types';
import { dedupeUsageByMessageId } from '../usage/dedupe';
import type { ParsedAgent, ParsedEdge, ParsedSession } from './types';
import type { SessionSubstrate } from './substrate';

/** Structurally malformed or self-contradictory substrate — a loud failure. */
export class SubstrateError extends Error {
  override readonly name = 'SubstrateError';
}

// --- Narrowing helpers over schemaless JSONL records -----------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

const TOOL_USE_ID_RE = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/;
const TASK_ID_RE = /<task-id>([\s\S]*?)<\/task-id>/;
const AGENT_FILE_RE = /^agent-[0-9a-f]+\.jsonl$/;
const AGENT_META_RE = /^agent-([0-9a-f]+)\.meta\.json$/;
const AGENT_FILE_PREFIX = 'agent-';
const JSONL_SUFFIX = '.jsonl';
const WORKFLOW_DIR_RE = /^wf_/;

// --- File classification ----------------------------------------------------

type FileClassification =
  | { kind: 'main' | 'journal' | 'other' }
  | { kind: 'meta'; hex: string | undefined }
  | { kind: 'agent'; hex: string; workflowId: string | undefined };

function classifyFile(relativePath: string): FileClassification {
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1);

  if (basename.endsWith('.meta.json')) {
    // Carry the hex of an `agent-<hex>.meta.json` sidecar so its parent anchor
    // (`toolUseId`) can be joined to the child transcript by hex.
    return { kind: 'meta', hex: AGENT_META_RE.exec(basename)?.[1] };
  }

  if (AGENT_FILE_RE.test(basename)) {
    const hex = basename.slice(AGENT_FILE_PREFIX.length, -JSONL_SUFFIX.length);
    const workflowId = relativePath.split('/').find((segment) => WORKFLOW_DIR_RE.test(segment));
    return { kind: 'agent', hex, workflowId };
  }

  if (basename === 'journal.jsonl') {
    return { kind: 'journal' };
  }

  if (!relativePath.includes('/') && basename.endsWith(JSONL_SUFFIX)) {
    return { kind: 'main' };
  }

  return { kind: 'other' };
}

/**
 * Kind-only view of {@link classifyFile} — the ONE classifier the WP-IN5 disk
 * adapter reuses to decide whether an on-disk file is one of the four
 * parser-spec section-2 artifact types. Exposing this (rather than letting the
 * adapter re-implement the allowlist) is the anti-drift linchpin: "artifact"
 * means byte-for-byte what {@link parseSession} means, so the reader and the
 * parser can never disagree about what counts. Returns only the discriminant,
 * never the internal hex / workflowId. Total (never throws); case-sensitive;
 * keyed on the basename plus the no-slash test that distinguishes a
 * project-root `<uuid>.jsonl` main from a nested subagent artifact.
 */
export function classifyRelativePath(
  relativePath: string,
): 'main' | 'agent' | 'meta' | 'journal' | 'other' {
  return classifyFile(relativePath).kind;
}

// --- Line parsing -----------------------------------------------------------

interface ParsedFile {
  relativePath: string;
  classification: FileClassification;
  records: unknown[];
}

/** Parses one file's lines to JSON, throwing loudly (with file + line) on any non-JSON line. */
function parseFile(relativePath: string, lines: readonly string[]): unknown[] {
  const records: unknown[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      return; // Tolerate blank lines (e.g. a trailing newline from the disk adapter).
    }
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new SubstrateError(
        `${relativePath}:${index + 1}: line is not valid JSON (${String(error)})`,
      );
    }
  });
  return records;
}

// --- Transcript model -------------------------------------------------------

interface Transcript {
  /** Owner agent id: `sessionId` for the main transcript, the hex for an agent transcript. */
  owner: string;
  isMain: boolean;
  records: unknown[];
}

interface AgentFile {
  hex: string;
  /** The enclosing `wf_*` directory segment when the file is under a `workflows/wf_*` tree, else undefined. */
  workflowId: string | undefined;
  records: unknown[];
  firstRecord: JsonRecord | undefined;
}

/**
 * The single-record `agent-<hex>.meta.json` sidecar the CLI writes beside each
 * subagent transcript. Its `toolUseId` is the primary child->parent anchor on
 * real data (workflow subagents omit it and are joined by directory instead).
 */
interface AgentSidecar {
  toolUseId: string | undefined;
  /** Dispatched subagent type (`general-purpose`, `Explore`, `Plan`, …). */
  agentType: string | undefined;
  spawnDepth: number | undefined;
}

// --- sessionId derivation ---------------------------------------------------

/** Derives the one session id, requiring every record's `sessionId` to agree (parser-spec: key on session-uuid). */
function deriveSessionId(files: readonly ParsedFile[]): string {
  let sessionId: string | undefined;
  for (const file of files) {
    file.records.forEach((rawRecord, index) => {
      const record = asRecord(rawRecord);
      const value = asString(record?.['sessionId']);
      if (value === undefined) {
        return;
      }
      if (sessionId === undefined) {
        sessionId = value;
      } else if (sessionId !== value) {
        throw new SubstrateError(
          `${file.relativePath}:${index + 1}: sessionId contradiction ("${sessionId}" vs "${value}") — a session must key on one session-uuid`,
        );
      }
    });
  }
  if (sessionId === undefined) {
    throw new SubstrateError('substrate carries no sessionId on any record');
  }
  return sessionId;
}

// --- Agent-file collection (hex uniqueness + inline agentId agreement) -------

function firstObjectRecord(records: readonly unknown[]): JsonRecord | undefined {
  for (const rawRecord of records) {
    const record = asRecord(rawRecord);
    if (record !== undefined) {
      return record;
    }
  }
  return undefined;
}

function collectAgentFiles(files: readonly ParsedFile[]): AgentFile[] {
  const pathByHex = new Map<string, string>();
  const agentFiles: AgentFile[] = [];

  for (const file of files) {
    if (file.classification.kind !== 'agent') {
      continue;
    }
    const { hex, workflowId } = file.classification;

    const previousPath = pathByHex.get(hex);
    if (previousPath !== undefined) {
      throw new SubstrateError(
        `two agent files share hex "${hex}" ("${previousPath}" and "${file.relativePath}")`,
      );
    }
    pathByHex.set(hex, file.relativePath);

    // Every inline agentId must agree with the filename hex (parser-spec 5.1:
    // attribution is a hard field-read, not a heuristic).
    file.records.forEach((rawRecord, index) => {
      const inline = asString(asRecord(rawRecord)?.['agentId']);
      if (inline !== undefined && inline !== hex) {
        throw new SubstrateError(
          `${file.relativePath}:${index + 1}: inline agentId "${inline}" does not equal filename hex "${hex}"`,
        );
      }
    });

    agentFiles.push({
      hex,
      workflowId,
      records: file.records,
      firstRecord: firstObjectRecord(file.records),
    });
  }

  return agentFiles;
}

/**
 * Reads every `agent-<hex>.meta.json` sidecar into a by-hex map. The sidecar's
 * `toolUseId` is the parser's primary parent anchor (parser-spec 4, path 1);
 * `agentType` recovers the subagent type when the parent block is gone.
 */
function collectSidecars(files: readonly ParsedFile[]): Map<string, AgentSidecar> {
  const sidecars = new Map<string, AgentSidecar>();
  for (const file of files) {
    if (file.classification.kind !== 'meta' || file.classification.hex === undefined) {
      continue;
    }
    const record = firstObjectRecord(file.records);
    if (record === undefined) {
      continue;
    }
    sidecars.set(file.classification.hex, {
      toolUseId: asString(record['toolUseId']),
      agentType: asString(record['agentType']),
      spawnDepth: asNumber(record['spawnDepth']),
    });
  }
  return sidecars;
}

// --- Structural indices (scanned across EVERY transcript) -------------------

interface ToolUseOwner {
  owner: string;
  subagentType: string | null;
}

interface SpawnIndices {
  /** `tool_use.id` -> owning agent (main = sessionId), from `Agent`/`Workflow` blocks. */
  toolUseOwner: Map<string, ToolUseOwner>;
  /** `workflow_id` -> owning agent, from `Workflow` blocks (nested-directory fallback source). */
  workflowDispatcher: Map<string, string>;
  /** `tool-use-id` (from a `queue-operation` record) -> owning agent. */
  queueOps: Map<string, string>;
  /** child hex -> parent block id, from a parent-side `type:'user'` `toolUseResult.agentId` (async spawns). */
  toolUseResultByChildHex: Map<string, string>;
  /** child hex (a `queue-operation` `<task-id>`) -> that record's `<tool-use-id>`. */
  queueChildToToolUse: Map<string, string>;
}

/**
 * Scans main AND agent transcripts (a depth-2 parent's `tool_use` block lives
 * inside a depth-1 agent transcript — gate #4), attributing every spawn anchor
 * to the agent id of the transcript that CONTAINS it.
 */
function buildIndices(transcripts: readonly Transcript[]): SpawnIndices {
  const toolUseOwner = new Map<string, ToolUseOwner>();
  const workflowDispatcher = new Map<string, string>();
  const queueOps = new Map<string, string>();
  const toolUseResultByChildHex = new Map<string, string>();
  const queueChildToToolUse = new Map<string, string>();

  for (const transcript of transcripts) {
    for (const rawRecord of transcript.records) {
      const record = asRecord(rawRecord);
      const type = asString(record?.['type']);

      if (type === 'assistant') {
        const content = asArray(asRecord(record?.['message'])?.['content']);
        if (content === undefined) {
          continue;
        }
        for (const rawBlock of content) {
          const block = asRecord(rawBlock);
          if (block === undefined || asString(block['type']) !== 'tool_use') {
            continue;
          }
          const name = asString(block['name']);
          if (name !== 'Agent' && name !== 'Workflow') {
            continue;
          }
          const id = asString(block['id']);
          if (id === undefined) {
            continue;
          }
          const input = asRecord(block['input']);
          toolUseOwner.set(id, {
            owner: transcript.owner,
            subagentType: asString(input?.['subagent_type']) ?? null,
          });
          if (name === 'Workflow') {
            const workflowId = asString(input?.['workflow_id']);
            if (workflowId !== undefined) {
              workflowDispatcher.set(workflowId, transcript.owner);
            }
          }
        }
      } else if (type === 'queue-operation') {
        // Guard the string content ONCE so both tag scans below read a narrowed
        // `content` — a re-check per scan would be an unreachable dead branch.
        const content = asString(record?.['content']);
        if (content !== undefined) {
          const toolUseId = TOOL_USE_ID_RE.exec(content)?.[1];
          if (toolUseId !== undefined) {
            queueOps.set(toolUseId, transcript.owner);
            // The record's `<task-id>` is the queued child's hex — the join key a
            // run_in_background child needs to reach this parent tool-use-id.
            const childHex = TASK_ID_RE.exec(content)?.[1];
            if (childHex !== undefined) {
              queueChildToToolUse.set(childHex, toolUseId);
            }
          }
        }
      } else if (type === 'user') {
        // Parent-side async spawn record: `toolUseResult.agentId` names the child
        // hex and the sibling `tool_result` block's `tool_use_id` is the parent
        // spawn block (the join for a child whose sidecar carries no toolUseId).
        const childHex = asString(asRecord(record?.['toolUseResult'])?.['agentId']);
        if (childHex !== undefined) {
          const blocks = asArray(asRecord(record?.['message'])?.['content']);
          if (blocks !== undefined) {
            for (const rawBlock of blocks) {
              const block = asRecord(rawBlock);
              if (block === undefined || asString(block['type']) !== 'tool_result') {
                continue;
              }
              const parentBlockId = asString(block['tool_use_id']);
              if (parentBlockId !== undefined) {
                toolUseResultByChildHex.set(childHex, parentBlockId);
                break;
              }
            }
          }
        }
      }
    }
  }

  return {
    toolUseOwner,
    workflowDispatcher,
    queueOps,
    toolUseResultByChildHex,
    queueChildToToolUse,
  };
}

// --- Parent resolution (the four join paths, in priority order) -------------

interface Resolution {
  parentAgentId: string | null;
  subagentType: string | null;
  edge: ParsedEdge | undefined;
}

function makeEdge(
  sessionId: string,
  parentAgentId: string,
  childAgentId: string,
  source: OrchestrationEdgeSource,
  toolUseId: string | null,
): ParsedEdge {
  return { sessionId, parentAgentId, childAgentId, source, toolUseId };
}

/**
 * Legacy child-side fallback: extracts a `<task-notification>`'s `<tool-use-id>`
 * from a child's first-record message content. On current CLI layouts the
 * task-notification is parent-side; this covers older transcripts only.
 */
function extractTaskNotificationToolUseId(firstRecord: JsonRecord | undefined): string | undefined {
  const content = asString(asRecord(firstRecord?.['message'])?.['content']);
  if (content === undefined || !content.includes('<task-notification>')) {
    return undefined;
  }
  return TOOL_USE_ID_RE.exec(content)?.[1];
}

function resolveParent(
  agentFile: AgentFile,
  sessionId: string,
  indices: SpawnIndices,
  sidecar: AgentSidecar | undefined,
): Resolution {
  // Nested layout (gate #2): a `workflows/wf_<id>/` file is anchored by directory
  // alone — workflow subagents carry no parent block id, so no tool_use anchor
  // exists. Parent is the dispatcher when known, else the main agent.
  if (agentFile.workflowId !== undefined) {
    const parent = indices.workflowDispatcher.get(agentFile.workflowId) ?? sessionId;
    return {
      parentAgentId: parent,
      subagentType: sidecar?.agentType ?? null,
      edge: makeEdge(sessionId, parent, agentFile.hex, 'directory', null),
    };
  }

  // Flat layout: anchor the child hex to a parent spawn-block id from the
  // strongest available source — the `.meta.json` sidecar (universal on real
  // data), else a parent-side async `toolUseResult`, else a queue `<task-id>`.
  const anchor =
    sidecar?.toolUseId ??
    indices.toolUseResultByChildHex.get(agentFile.hex) ??
    indices.queueChildToToolUse.get(agentFile.hex);

  if (anchor !== undefined) {
    // 1. tool_use: the anchor names a materialized `Agent`/`Workflow` block; its
    //    owning transcript is the parent (a depth-2 parent block lives inside a
    //    depth-1 agent transcript — gate #4).
    const owner = indices.toolUseOwner.get(anchor);
    if (owner !== undefined) {
      return {
        parentAgentId: owner.owner,
        subagentType: owner.subagentType ?? sidecar?.agentType ?? null,
        edge: makeEdge(sessionId, owner.owner, agentFile.hex, 'tool_use', anchor),
      };
    }

    // 3. queue_operation: a run_in_background spawn whose parent block was never
    //    materialized as a tool_use; joined via the queue-operation record.
    const queueOwner = indices.queueOps.get(anchor);
    if (queueOwner !== undefined) {
      return {
        parentAgentId: queueOwner,
        subagentType: sidecar?.agentType ?? null,
        edge: makeEdge(sessionId, queueOwner, agentFile.hex, 'queue_operation', anchor),
      };
    }

    // 4. task_notification: the anchor is known but its parent block is gone
    //    (compaction evicted it) — re-anchor the edge to the main agent.
    return {
      parentAgentId: sessionId,
      subagentType: sidecar?.agentType ?? null,
      edge: makeEdge(sessionId, sessionId, agentFile.hex, 'task_notification', anchor),
    };
  }

  // 4 (legacy): no sidecar/parent-side anchor, but the child's first record
  //    carries a `<task-notification>` tool-use-id — recover the edge to main.
  const recoveredToolUseId = extractTaskNotificationToolUseId(agentFile.firstRecord);
  if (recoveredToolUseId !== undefined) {
    return {
      parentAgentId: sessionId,
      subagentType: sidecar?.agentType ?? null,
      edge: makeEdge(sessionId, sessionId, agentFile.hex, 'task_notification', recoveredToolUseId),
    };
  }

  // 5. orphan: no structural join path — never fabricate a parent, emit no edge.
  //    The subagent type is still recoverable from the sidecar when present.
  return { parentAgentId: null, subagentType: sidecar?.agentType ?? null, edge: undefined };
}

// --- Timespans --------------------------------------------------------------

interface Timespan {
  startedAt: string;
  endedAt: string;
}

/** First/last timestamped record of a transcript (parser-spec: started/ended = first/last record ts). */
function transcriptTimespan(records: readonly unknown[], context: string): Timespan {
  const timestamps: string[] = [];
  for (const rawRecord of records) {
    const timestamp = asString(asRecord(rawRecord)?.['timestamp']);
    if (timestamp !== undefined) {
      timestamps.push(timestamp);
    }
  }
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  if (first === undefined || last === undefined) {
    throw new SubstrateError(`${context}: transcript has no timestamped record`);
  }
  return { startedAt: first, endedAt: last };
}

// --- Usage extraction -------------------------------------------------------

function mapUsageBuckets(usage: JsonRecord): TokenBuckets {
  const cacheCreation = asRecord(usage['cache_creation']);
  return {
    input: asNumber(usage['input_tokens']) ?? 0,
    output: asNumber(usage['output_tokens']) ?? 0,
    cacheRead: asNumber(usage['cache_read_input_tokens']) ?? 0,
    cacheWrite5m:
      cacheCreation !== undefined
        ? (asNumber(cacheCreation['ephemeral_5m_input_tokens']) ?? 0)
        : (asNumber(usage['cache_creation_input_tokens']) ?? 0),
    cacheWrite1h:
      cacheCreation !== undefined ? (asNumber(cacheCreation['ephemeral_1h_input_tokens']) ?? 0) : 0,
  };
}

/** One UsageRow per assistant message carrying a `usage` block, across every transcript. */
function extractUsageRows(transcripts: readonly Transcript[]): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const transcript of transcripts) {
    const agentId = transcript.isMain ? null : transcript.owner;
    for (const rawRecord of transcript.records) {
      const record = asRecord(rawRecord);
      if (asString(record?.['type']) !== 'assistant') {
        continue;
      }
      const message = asRecord(record?.['message']);
      const usage = asRecord(message?.['usage']);
      const messageId = asString(message?.['id']);
      if (usage === undefined || messageId === undefined) {
        continue;
      }
      rows.push({
        messageId,
        model: asString(message?.['model']) ?? '',
        timestamp: asString(record?.['timestamp']) ?? '',
        usage: mapUsageBuckets(usage),
        agentId,
      });
    }
  }
  return rows;
}

// --- Public entry point -----------------------------------------------------

/**
 * Reconstructs one session's agents, spawn edges and message-deduped usage
 * from already-read file contents. Pure: no I/O, no mutation of the input.
 *
 * @throws {SubstrateError} on a non-JSON line, an inline-agentId / filename-hex
 *   disagreement, a duplicated agent hex, a `sessionId` contradiction, or a
 *   transcript with no timestamped record.
 * @throws {UsageConflictError} (from {@link dedupeUsageByMessageId}) when two
 *   rows share a `message.id` but disagree on `model` or `agentId` — never
 *   swallowed. Streamed usage partials collapse to the per-bucket maximum.
 */
export function parseSession(substrate: SessionSubstrate): ParsedSession {
  const files: ParsedFile[] = substrate.files.map((file) => ({
    relativePath: file.relativePath,
    classification: classifyFile(file.relativePath),
    records: parseFile(file.relativePath, file.lines),
  }));

  const sessionId = deriveSessionId(files);
  const agentFiles = collectAgentFiles(files);
  const sidecars = collectSidecars(files);

  const mainRecords = files
    .filter((file) => file.classification.kind === 'main')
    .flatMap((file) => file.records);
  const hasMain = mainRecords.length > 0;

  const transcripts: Transcript[] = [];
  if (hasMain) {
    transcripts.push({ owner: sessionId, isMain: true, records: mainRecords });
  }
  for (const agentFile of agentFiles) {
    transcripts.push({ owner: agentFile.hex, isMain: false, records: agentFile.records });
  }

  const indices = buildIndices(transcripts);

  const agents: ParsedAgent[] = [];
  const edges: ParsedEdge[] = [];

  if (hasMain) {
    const span = transcriptTimespan(mainRecords, `main transcript (session "${sessionId}")`);
    agents.push({
      id: sessionId,
      type: 'main',
      subagentType: null,
      parentAgentId: null,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
    });
  }

  for (const agentFile of agentFiles) {
    const resolution = resolveParent(agentFile, sessionId, indices, sidecars.get(agentFile.hex));
    const span = transcriptTimespan(agentFile.records, `agent "${agentFile.hex}"`);
    agents.push({
      id: agentFile.hex,
      type: 'subagent',
      subagentType: resolution.subagentType,
      parentAgentId: resolution.parentAgentId,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
    });
    if (resolution.edge !== undefined) {
      edges.push(resolution.edge);
    }
  }

  const usage: DedupedUsage[] = dedupeUsageByMessageId(extractUsageRows(transcripts));

  return { sessionId, agents, edges, usage };
}
