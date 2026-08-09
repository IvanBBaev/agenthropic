/**
 * WP-IN12 missing-Stop watchdog. An agent whose transcript shows no terminal
 * state and no new activity for the configured window is honestly marked
 * 'unknown' — NEVER guessed as 'completed' (the design honesty rule; the
 * migration-4 comment and OPEN-2 in docs/analysis/open-decisions.md both
 * reserve 'unknown' for exactly this sweep).
 *
 * This is the ONLY producer of 'unknown', and it is live code on every poll
 * tick: ingest asserts 'working' (activity, never termination), hooks supply
 * the observed terminals, and staleness — measured against the injected clock
 * with the DASHBOARD_WATCHDOG_MINUTES window — resolves everything neither one
 * has spoken for.
 *
 * Split for testability: {@link decideWatchdogVerdict} is a pure function
 * (timestamps in, verdict out); {@link runWatchdogSweep} applies it over the
 * db's non-terminal candidate set and persists each transition. The sweep runs
 * on the corpus watcher's poll tick.
 */
import type { AgentStatus } from '@agenthropic/shared';
import { listWatchdogCandidates, setAgentStatus, type WatchdogCandidate } from '../db/agents';
import type { SqliteDatabase } from '../db/connection';
import { mirrorMainAgentStatus } from '../db/sessions';
import type { AgentStatusChangedEvent } from './ingest-events';

/** 'completed' / 'error' / 'unknown' need no watchdog; the rest (and NULL) do. */
export function isTerminalAgentStatus(status: AgentStatus | null): boolean {
  return status === 'completed' || status === 'error' || status === 'unknown';
}

/**
 * Pure staleness verdict for one candidate. Returns 'unknown' when the agent
 * must transition, `null` when it is left alone.
 *
 * The activity anchor is `lastSeenAt`, falling back to `firstSeenAt`. Honesty
 * over optimism on degenerate rows: an agent with NO parseable timestamp at
 * all cannot prove recent activity, so it is 'unknown' immediately rather
 * than 'working' forever. The threshold comparison is `>=` — an agent exactly
 * at the window boundary is already stale.
 */
export function decideWatchdogVerdict(
  candidate: Pick<WatchdogCandidate, 'status' | 'firstSeenAt' | 'lastSeenAt'>,
  nowEpochMs: number,
  thresholdMs: number,
): 'unknown' | null {
  if (isTerminalAgentStatus(candidate.status)) {
    return null; // defence in depth — listWatchdogCandidates already excludes these
  }
  const anchor = candidate.lastSeenAt ?? candidate.firstSeenAt;
  if (anchor === null) {
    return 'unknown';
  }
  const anchorMs = Date.parse(anchor);
  if (Number.isNaN(anchorMs)) {
    return 'unknown'; // corrupt stamp: cannot prove activity → honest 'unknown'
  }
  return nowEpochMs - anchorMs >= thresholdMs ? 'unknown' : null;
}

/**
 * Apply the watchdog over every non-terminal agent, persisting each verdict
 * and returning the transitions (the caller bridges them to `onIngestEvent`).
 * Synchronous end-to-end — better-sqlite3 keeps the sweep atomic per row.
 */
export function runWatchdogSweep(
  db: SqliteDatabase,
  nowEpochMs: number,
  thresholdMs: number,
): AgentStatusChangedEvent[] {
  const transitions: AgentStatusChangedEvent[] = [];
  for (const candidate of listWatchdogCandidates(db)) {
    if (decideWatchdogVerdict(candidate, nowEpochMs, thresholdMs) === null) {
      continue;
    }
    // One transaction per candidate: the agent row and its session mirror must
    // never diverge across a crash between the two UPDATEs. (A stale MAIN
    // agent means a stale session; a stale subagent says nothing about its
    // parent, and the guarded mirror UPDATE is a no-op for it.)
    db.transaction(() => {
      setAgentStatus(db, candidate.id, 'unknown');
      mirrorMainAgentStatus(db, candidate.id, 'unknown');
    })();
    transitions.push({
      type: 'agent-status-changed',
      agentId: candidate.id,
      sessionId: candidate.sessionId,
      oldStatus: candidate.status,
      newStatus: 'unknown',
    });
  }
  return transitions;
}
