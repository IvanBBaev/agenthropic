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
 *
 * Clock jumps (OPS-21). Staleness is wall clock minus transcript stamps, so a
 * Mac waking from sleep (or an NTP step forward) makes every silent agent look
 * stale at once, although nothing could have been written while the machine
 * slept. {@link detectClockJump} compares the wall-clock advance between two
 * ticks with the monotonic advance; when they diverge by more than
 * {@link CLOCK_JUMP_TOLERANCE_MS} the watcher raises an activity floor at the
 * wall time of detection, and the verdict measures silence from that floor at
 * the earliest. A woken agent therefore gets one full window to speak again
 * before it is called 'unknown'. A backward step needs no floor: it only makes
 * agents look fresher, which delays a verdict and never invents one.
 */
import type { AgentStatus } from '@agenthropic/shared';
import { listWatchdogCandidates, setAgentStatus, type WatchdogCandidate } from '../db/agents';
import type { SqliteDatabase } from '../db/connection';
import { mirrorMainAgentStatus } from '../db/sessions';
import type { AgentStatusChangedEvent } from './ingest-events';

/**
 * Wall-vs-monotonic divergence (ms) between two ticks that counts as a clock
 * jump. An event-loop stall delays both clocks alike, so ordinary scheduling
 * jitter stays near zero; 30 s is far above it and far below any sleep or NTP
 * step worth guarding.
 */
export const CLOCK_JUMP_TOLERANCE_MS = 30_000;

/** One tick's reading of both clocks, kept by the watcher between ticks. */
export interface ClockReading {
  readonly wallMs: number;
  readonly monoMs: number;
}

/**
 * Signed clock jump between two readings: wall advance minus monotonic
 * advance, or 0 while the two agree within {@link CLOCK_JUMP_TOLERANCE_MS}.
 * Positive means the wall clock ran ahead (sleep, NTP step forward). The
 * suspend is visible only because the monotonic clock excludes it (macOS
 * uptime clocks and Linux CLOCK_MONOTONIC both do); an NTP step is visible
 * on every platform.
 */
export function detectClockJump(previous: ClockReading, current: ClockReading): number {
  const skewMs = current.wallMs - previous.wallMs - (current.monoMs - previous.monoMs);
  return Math.abs(skewMs) > CLOCK_JUMP_TOLERANCE_MS ? skewMs : 0;
}

/** 'completed' / 'error' / 'unknown' need no watchdog; the rest (and NULL) do. */
export function isTerminalAgentStatus(status: AgentStatus | null): boolean {
  return status === 'completed' || status === 'error' || status === 'unknown';
}

/**
 * Pure staleness verdict for one candidate. Returns 'unknown' when the agent
 * must transition, `null` when it is left alone.
 *
 * The activity anchor is the first PARSEABLE stamp of `lastSeenAt`, then
 * `firstSeenAt`. A stamp that is absent OR corrupt falls through to the next
 * one: a corrupt `lastSeenAt` is absence of evidence, not evidence of
 * staleness, so a parseable `firstSeenAt` is still consulted before any
 * verdict. (Previously a corrupt `lastSeenAt` returned 'unknown' without the
 * `firstSeenAt` ever being checked - a staleness claim nothing had computed.)
 * Honesty over optimism on degenerate rows: an agent with NO parseable
 * timestamp at all cannot prove recent activity, so it is 'unknown'
 * immediately rather than 'working' forever. The threshold comparison is `>=`
 * — an agent exactly at the window boundary is already stale.
 *
 * `activityFloorMs` (OPS-21) lifts a parseable anchor to at least that epoch:
 * silence before a detected clock jump is not counted. It never rescues an
 * agent with no parseable stamp — that one had no evidence before the jump
 * either.
 */
export function decideWatchdogVerdict(
  candidate: Pick<WatchdogCandidate, 'status' | 'firstSeenAt' | 'lastSeenAt'>,
  nowEpochMs: number,
  thresholdMs: number,
  activityFloorMs = Number.NEGATIVE_INFINITY,
): 'unknown' | null {
  if (isTerminalAgentStatus(candidate.status)) {
    return null; // defence in depth — listWatchdogCandidates already excludes these
  }
  const anchorMs = [candidate.lastSeenAt, candidate.firstSeenAt]
    .map((stamp) => (stamp === null ? Number.NaN : Date.parse(stamp)))
    .find((ms) => !Number.isNaN(ms));
  if (anchorMs === undefined) {
    return 'unknown'; // no parseable stamp: cannot prove activity → honest 'unknown'
  }
  return nowEpochMs - Math.max(anchorMs, activityFloorMs) >= thresholdMs ? 'unknown' : null;
}

/**
 * Apply the watchdog over every non-terminal agent, persisting each verdict
 * and returning the transitions (the caller bridges them to `onIngestEvent`).
 * Synchronous end-to-end — better-sqlite3 keeps the sweep atomic per row.
 * `activityFloorMs` is forwarded to {@link decideWatchdogVerdict}.
 */
export function runWatchdogSweep(
  db: SqliteDatabase,
  nowEpochMs: number,
  thresholdMs: number,
  activityFloorMs = Number.NEGATIVE_INFINITY,
): AgentStatusChangedEvent[] {
  const transitions: AgentStatusChangedEvent[] = [];
  for (const candidate of listWatchdogCandidates(db)) {
    if (decideWatchdogVerdict(candidate, nowEpochMs, thresholdMs, activityFloorMs) === null) {
      continue;
    }
    // One transaction per candidate: the agent row and its session mirror must
    // never diverge across a crash between the two UPDATEs. (A stale MAIN
    // agent means a stale session; a stale subagent says nothing about its
    // parent, and the guarded mirror UPDATE is a no-op for it.) The id-only
    // setAgentStatus is correct here: the id was just read from the agents
    // table itself, not from a payload - see its doc comment in db/agents.ts.
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
