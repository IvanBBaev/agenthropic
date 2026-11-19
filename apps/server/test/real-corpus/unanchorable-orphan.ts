/**
 * The independent proof behind the real-corpus "0 anchorable orphans" invariant
 * (parser-spec section 4.1, contract amendment 2026-11-19).
 *
 * A subagent the parser leaves without a parent is acceptable ONLY when the raw
 * bytes prove that no join path of section 4.1 could ever reach it. The proof is
 * read here from the files themselves, never from the parser's indices, and every
 * test is a plain substring search: an accidental mention anywhere in a foreign
 * transcript disqualifies the orphan, so the check can only err towards failing.
 *
 * The orphan is unanchorable when ALL of these hold:
 *  1. its transcript sits flat in `<session>/subagents/` — no directory parent;
 *  2. its sidecar names no `toolUseId` — no tool_use / queue / notification anchor;
 *  3. its first record carries no `<task-notification>` — no legacy re-anchor;
 *  4. no foreign transcript of its session mentions its hex — no async
 *     `toolUseResult.agentId`, no queue `<task-id>`, no legacy progress record;
 *  5. its first record carries a `promptId`, and no foreign transcript of its
 *     session mentions that id — the prompt_id last resort has no candidate.
 *
 * Anything else is an orphan the parser should have joined, and fails the suite.
 */

/** What one orphan's proof is read from. */
export interface OrphanEvidence {
  /** The child hex: the agent id of the orphan. */
  readonly hex: string;
  /** The orphan's own transcript content. */
  readonly transcript: string;
  /** The `agent-<hex>.meta.json` sidecar content, or undefined when there is none. */
  readonly sidecar: string | undefined;
  /** Whether the transcript sits flat in `<session>/subagents/`. */
  readonly flat: boolean;
  /** The content of every OTHER transcript of the same session. */
  readonly foreign: readonly string[];
}

export type OrphanVerdict =
  { readonly unanchorable: true } | { readonly unanchorable: false; readonly reason: string };

/** The first complete line that parses to a JSON object (parser-spec section 3). */
function firstObjectRecord(content: string): Record<string, unknown> | undefined {
  const lines = content.split('\n');
  lines.pop(); // an unterminated tail is a live append, never a complete record
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // a malformed line is skipped, never fatal
    }
  }
  return undefined;
}

function sidecarNamesAnchor(sidecar: string | undefined): boolean {
  if (sidecar === undefined) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(sidecar);
    return typeof parsed === 'object' && parsed !== null && 'toolUseId' in parsed;
  } catch {
    // An unreadable sidecar proves nothing, so it cannot prove absence either.
    return true;
  }
}

function refuse(reason: string): OrphanVerdict {
  return { unanchorable: false, reason };
}

export function classifyOrphan(evidence: OrphanEvidence): OrphanVerdict {
  if (!evidence.flat) {
    return refuse('nested transcript: a directory parent exists');
  }
  if (sidecarNamesAnchor(evidence.sidecar)) {
    return refuse('the sidecar names a spawn anchor');
  }
  const first = firstObjectRecord(evidence.transcript);
  if (first === undefined) {
    return refuse('no complete first record');
  }
  if (JSON.stringify(first).includes('<task-notification>')) {
    return refuse('the first record carries a task notification');
  }
  if (evidence.foreign.some((content) => content.includes(evidence.hex))) {
    return refuse('a foreign transcript names the child hex');
  }
  const promptId = first['promptId'];
  if (typeof promptId !== 'string' || promptId === '') {
    return refuse('the first record carries no promptId');
  }
  if (evidence.foreign.some((content) => content.includes(promptId))) {
    return refuse('a foreign transcript carries the same promptId');
  }
  return { unanchorable: true };
}
