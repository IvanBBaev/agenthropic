/**
 * WP-IN12 - the hook half of the status lifecycle: turning an observed hook
 * firing into a LIVENESS transition on an agent that already exists.
 *
 * Why this module exists at all. Ingest can only prove that activity happened
 * (see LIVENESS_STATUS in ingest/ingest-session.ts), and the watchdog can only
 * prove that activity went stale. Neither can observe an ENDING. Hooks can:
 * `SubagentStop` fires when an identified subagent terminates, and `Stop` fires
 * when the main agent goes idle. That is the entire terminal signal the system
 * has, which is why "no hooks installed" honestly means "nothing ever reports
 * 'completed'".
 *
 * CD-1 - HOOKS ARE LIVENESS ONLY, NEVER STRUCTURE. Everything here goes through
 * `applyAgentStatus`, an UPDATE-only primitive: a hook can move the `status`
 * column of a row the JSONL parser already created and NOTHING else. It cannot
 * create an agent, delete one, re-parent one, add an edge or touch token usage.
 * A hook naming an agent this server has never parsed is stored as raw liveness
 * and changes no row — the transcript remains the sole structural authority.
 *
 * `Stop` MAPS TO 'waiting', NOT 'completed'. Claude Code fires `Stop` at the end
 * of every TURN with a byte-identical body (hooks/README.md, and the reason the
 * WP-IN1 envelope needs a sender-minted deliveryId at all), so treating it as a
 * session ending would re-introduce exactly the confident lie this lifecycle
 * removes. 'waiting' is the honest reading: the main agent is idle right now.
 * If it never comes back, the watchdog ages it to 'unknown' — and 'unknown' is
 * shown as 'unknown', never softened into something friendlier.
 */
import type { AgentStatus } from '@agenthropic/shared';
import { applyAgentStatus } from '../db/agents';
import type { SqliteDatabase } from '../db/connection';
import { mirrorMainAgentStatus } from '../db/sessions';
import { extractLivenessIds } from '../db/event-store';
import type { AgentStatusChangedEvent } from '../ingest/ingest-events';

/** Claude Code hook names that carry a liveness verdict. */
export const STOP_HOOK = 'Stop';
export const SUBAGENT_STOP_HOOK = 'SubagentStop';

/**
 * Subagent transcript filename -> agent id. Mirrors the parser's own rule
 * (parse-session.ts AGENT_FILE_RE): a subagent's id IS the hex in
 * `agent-<hex>.jsonl`, so the basename is a legitimate identity, not a guess.
 * Anchored to a path separator (or the whole string) so `not-agent-ff.jsonl`
 * does not match.
 */
const SUBAGENT_TRANSCRIPT_RE = /(?:^|[\\/])agent-[0-9a-f]+\.jsonl$/;
const AGENT_FILE_PREFIX = 'agent-';
const AGENT_FILE_SUFFIX = '.jsonl';

export interface HookStatusTarget {
  readonly agentId: string;
  readonly status: AgentStatus;
}

function readTranscriptPath(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['transcript_path', 'transcriptPath']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Recover a subagent id from its transcript path. Deliberately tolerant about
 * the separator (a hook payload is not a filesystem operation and is never used
 * as one — the value is only ever matched against a regex, never opened) and
 * strict about the shape: anything that is not exactly `agent-<hex>.jsonl`
 * yields null rather than a half-guessed id.
 */
export function agentIdFromTranscriptPath(path: string): string | null {
  const match = SUBAGENT_TRANSCRIPT_RE.exec(path);
  if (match === null) {
    return null;
  }
  // match[0] is `[<separator>]agent-<hex>.jsonl` — the id is the hex between the
  // two known literals. Sliced rather than captured so there is no
  // "capture group might be undefined" arm that no input can ever reach.
  const filename = match[0];
  return filename.slice(
    filename.lastIndexOf(AGENT_FILE_PREFIX) + AGENT_FILE_PREFIX.length,
    -AGENT_FILE_SUFFIX.length,
  );
}

/**
 * Which agent (if any) this hook firing speaks for, and what it says.
 *
 * Returns null — meaning "stored as liveness, no status change" — whenever the
 * evidence is incomplete. NEVER GUESS A TARGET: attributing a `SubagentStop` to
 * the wrong agent would mark a running agent finished, the same class of bug
 * this lifecycle exists to remove.
 */
export function resolveHookStatusTarget(
  hookName: string,
  payload: unknown,
): HookStatusTarget | null {
  const ids = extractLivenessIds(payload);
  if (hookName === STOP_HOOK) {
    // The main agent's id IS the session uuid (parse-session.ts), so the
    // session id in the payload identifies it directly.
    return ids.sessionId === null ? null : { agentId: ids.sessionId, status: 'waiting' };
  }
  if (hookName === SUBAGENT_STOP_HOOK) {
    const transcriptPath = readTranscriptPath(payload);
    const agentId =
      ids.agentId ?? (transcriptPath === null ? null : agentIdFromTranscriptPath(transcriptPath));
    return agentId === null ? null : { agentId, status: 'completed' };
  }
  return null;
}

/**
 * Apply one hook firing's liveness verdict. Returns the transitions it caused
 * (zero or one) for the caller to publish on the realtime stream.
 *
 * Not registered inside the event store on purpose: the store is the
 * append-only substrate port and must stay structure-free (the P0 DAG-rebuild
 * proof appends hook envelopes straight through it and asserts the DAG is
 * byte-identical afterwards). The status seam lives one level up, in the route
 * composition.
 */
export function applyHookLiveness(
  db: SqliteDatabase,
  hookName: string,
  payload: unknown,
): AgentStatusChangedEvent[] {
  const target = resolveHookStatusTarget(hookName, payload);
  if (target === null) {
    return [];
  }
  // One transaction around the pair: the agent row and its session mirror must
  // never diverge across a crash between the two UPDATEs.
  return db.transaction((): AgentStatusChangedEvent[] => {
    const transition = applyAgentStatus(db, target.agentId, target.status);
    if (transition === null) {
      return [];
    }
    // No-op unless the target is a main agent — a subagent stopping says
    // nothing about whether its parent session is still working.
    mirrorMainAgentStatus(db, target.agentId, target.status);
    return [transition];
  })();
}
