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
import { applyAgentStatus, reconcileAgentStatus } from '../db/agents';
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

/**
 * M-13 — replay stored SubagentStop verdicts for agents that JUST got their
 * first row.
 *
 * A subagent that finishes within one poll interval fires its SubagentStop
 * hook BEFORE ingest has ever parsed its transcript. CD-1 makes the live path
 * store that hook as raw liveness and change no row — correct, but without
 * this replay the verdict is lost forever: the watchdog eventually ages the
 * agent to 'unknown' even though a hook genuinely observed it complete.
 *
 * Scope is deliberately narrow:
 *  - only agents FIRST INSERTED by the current projection (`newAgentIds`) —
 *    an agent that already had a row received its live delivery normally, and
 *    re-applying old stops to it would be a second, unaccountable writer;
 *  - only SubagentStop. `Stop` recurs on every turn and maps to the
 *    non-terminal 'waiting', so replaying a stale one would overwrite fresher
 *    liveness with an old idle verdict;
 *  - through {@link reconcileAgentStatus}, which refuses to move a row that is
 *    already terminal — replayed evidence never outranks a later verdict, and
 *    a repeat reconcile of the same stored rows is a no-op.
 *
 * The lookup goes through the `events` hook projection (indexed by
 * session_id) rather than scanning `events_raw`. A stored payload that does
 * not parse or names no agent is SKIPPED, never thrown on: reconciliation is
 * best-effort recovery and must not be able to fail an ingest tick. A payload
 * that never carried a session_id is invisible to the session-scoped query —
 * accepted, because real Claude Code hook stdin always carries one.
 */
export function reconcilePendingSubagentStops(
  db: SqliteDatabase,
  sessionId: string,
  newAgentIds: ReadonlySet<string>,
): AgentStatusChangedEvent[] {
  if (newAgentIds.size === 0) {
    // The common ingest tick: nothing new, nothing to replay, no query.
    return [];
  }
  const rows = db
    .prepare(
      `SELECT r.payload AS payload
         FROM events e
         JOIN events_raw r ON r.id = e.raw_event_id
        WHERE e.session_id = ? AND e.event_type = ?
        ORDER BY e.id`,
    )
    .all(sessionId, SUBAGENT_STOP_HOOK) as { payload: string }[];
  // One transaction around the whole replay, for the same reason as the live
  // path: an agent row and its session mirror must never diverge. Nested
  // inside the projection transaction this is a savepoint, so a reconcile
  // commits or rolls back with the rows that triggered it.
  return db.transaction((): AgentStatusChangedEvent[] => {
    const transitions: AgentStatusChangedEvent[] = [];
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // A raw payload that is not valid JSON cannot arrive through the
        // append port (it stringifies), but events_raw makes no such CHECK —
        // a damaged row must not be able to sink the whole ingest tick.
        continue;
      }
      const target = resolveHookStatusTarget(SUBAGENT_STOP_HOOK, payload);
      if (target === null || !newAgentIds.has(target.agentId)) {
        continue;
      }
      const transition = reconcileAgentStatus(db, target.agentId, target.status);
      if (transition === null) {
        // Duplicate stored stops for the same agent: the first one already
        // moved the row to its terminal, the rest are no-ops by design.
        continue;
      }
      // Parity with the live path: a main-agent target mirrors onto its
      // session row; for a subagent this is a guarded no-op.
      mirrorMainAgentStatus(db, target.agentId, target.status);
      transitions.push(transition);
    }
    return transitions;
  })();
}
