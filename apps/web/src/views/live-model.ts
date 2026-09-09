/**
 * Pure state transitions for the live status board (WP-U6). The board's
 * ground truth is GET /api/sessions; between refetches the SSE stream patches
 * that snapshot: an `agent-status-changed` event moves one agent between a
 * session's status buckets in place, and anything the snapshot cannot absorb
 * honestly (an unknown session, a fresh ingest) makes the caller refetch
 * persisted truth instead of guessing.
 *
 * AMENDED 2026-09-03 (LV-7): refetching is no longer the only answer. A frame
 * the board has ALREADY applied is absorbed in place - the row is right, so
 * there is nothing to refetch, and a redelivering stream must not be answered
 * with one refetch per redelivery. See applyAgentStatusChange.
 */
import type {
  AgentStatus,
  AgentStatusChangedEvent,
  SessionStatusCountsDto,
  SessionSummaryDto,
} from '../dto';
import { AGENT_STATUSES, isAgentStatus } from './status';

/**
 * Read one status bucket, tolerating a bucket the server did not send. The
 * schema promises all five, so `undefined` means the snapshot is not the
 * shape this build expects - callers must show/handle that gap rather than
 * treat it as a zero.
 */
export function bucketCount(
  counts: SessionStatusCountsDto,
  status: AgentStatus,
): number | undefined {
  return (counts as Partial<Record<AgentStatus, number>>)[status];
}

/**
 * Structural guard for the SSE payload - the stream delivers parsed-but-
 * untyped JSON, so the board only applies frames that carry the full
 * agent-status-changed shape (see @agenthropic/shared realtime schema).
 */
export function isAgentStatusChangedEvent(data: unknown): data is AgentStatusChangedEvent {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    record['type'] === 'agent-status-changed' &&
    typeof record['sessionId'] === 'string' &&
    typeof record['agentId'] === 'string' &&
    isAgentStatus(record['status']) &&
    (record['previousStatus'] === null || isAgentStatus(record['previousStatus'])) &&
    typeof record['occurredAt'] === 'string'
  );
}

/**
 * A board row: the server's summary plus what has happened to it SINCE it was
 * fetched.
 *
 * The patch below writes two of a summary's fields and carries the other seven
 * across untouched, so a patched row is a mixture of two ages. That was
 * invisible, and the invisible half was the dangerous half: the patch advances
 * `lastActivityAt`, which is the only freshness cue the card has, so thirty
 * frames over twenty minutes drove a card's label back to "just now" while its
 * dollars, tokens, agent count and session-status chip all stayed at the value
 * read twenty minutes earlier. The stale figures were not merely left alone -
 * they were re-certified as current by the very events that made them stale.
 *
 * Counting the patches is what lets the card say which half is which. It is a
 * count and not a flag because "patched once" and "patched thirty times" are
 * different amounts of drift, and the reader can judge that better than a
 * threshold picked here.
 */
export interface BoardSession extends SessionSummaryDto {
  /**
   * Live status frames folded into this row since the snapshot was fetched.
   *
   * Optional, and absent rather than zero on a row that came straight off the
   * wire: the server's summary genuinely does not carry this field, and a row
   * that has never been patched is exactly a summary. Read it through
   * `livePatchCount` so the two spellings of "never patched" cannot diverge.
   */
  readonly livePatches?: number;
  /**
   * Where this board has already put each of the session's agents.
   *
   * Added 2026-09-03 (LV-7). Keyed by agentId, it records the status a move
   * this board APPLIED moved that agent INTO - nothing about agents it has not
   * moved, and nothing about a move it refused.
   *
   * It rides the row, and that is the whole of its authority: it is a claim
   * about the snapshot those moves were folded into, so when a refetch replaces
   * the row the claim goes with it. A memory that outlived its row would speak
   * for counts it never touched.
   *
   * Optional and absent on a row straight off the wire, like `livePatches`: the
   * server sends no such field, and a row that has never been patched has put
   * nobody anywhere.
   *
   * AMENDED 2026-09-08 (LV-8): also read as evidence AGAINST a frame. A
   * previousStatus that is not the status recorded here contradicts a move this
   * board actually applied, and is refused rather than aimed at whichever agent
   * occupies the bucket it names.
   */
  readonly appliedAgentStatuses?: Readonly<Record<string, AgentStatus>>;
}

/** Patches folded into a row; a row that has none never had the field. */
export function livePatchCount(session: BoardSession): number {
  return session.livePatches ?? 0;
}

/**
 * The later of a row's recorded activity and an event's observation time.
 *
 * Added 2026-09-03 (LV-1). The stream offers no ordering or uniqueness
 * guarantee - the hub keeps no replay buffer, and EventSource redelivers on
 * reconnect at the server's discretion - so a frame can arrive after a newer
 * one, or arrive twice. Writing its occurredAt through unconditionally made the
 * card's only freshness cue move BACKWARDS on such a frame, and the board then
 * demoted the card through sortSessionsByRecency: a session active five minutes
 * ago was presented as quiet for half an hour. An occurredAt that is a string
 * but not a readable date (all the event guard can promise) erased the
 * timestamp outright and the card fell back to `no timestamp`.
 *
 * A timestamp is evidence that something happened AT LEAST that recently, so
 * the honest merge is the maximum of the two - never a downgrade. An unreadable
 * value on either side is not evidence at all: an unreadable event time leaves
 * the row alone, and a row whose own value cannot be read has nothing to lose.
 */
function laterActivityAt(current: string | null, occurredAt: string): string | null {
  const eventMs = Date.parse(occurredAt);
  if (Number.isNaN(eventMs)) return current;
  if (current === null) return occurredAt;
  const currentMs = Date.parse(current);
  if (!Number.isNaN(currentMs) && currentMs > eventMs) return current;
  return occurredAt;
}

/**
 * The status a move this board applied put `agentId` into on this row, or
 * undefined for an agent whose moves it has not applied (LV-7).
 */
function appliedStatusOf(session: BoardSession, agentId: string): AgentStatus | undefined {
  return session.appliedAgentStatuses?.[agentId];
}

/**
 * Agents this snapshot has already placed in a status bucket.
 *
 * Added 2026-09-03 (LV-4). A bucket the server did not send counts as no
 * agents here: the gap is already rendered on the card, and treating it as a
 * reason to refuse an otherwise-supportable move would trade a visible gap for
 * an invisible refusal.
 */
function placedAgentCount(counts: SessionStatusCountsDto): number {
  let total = 0;
  for (const status of AGENT_STATUSES) total += bucketCount(counts, status) ?? 0;
  return total;
}

export interface StatusChangeResult {
  readonly sessions: readonly BoardSession[];
  /**
   * False when the event references a session this snapshot does not know -
   * the honest reaction is a refetch, never inventing a summary row.
   *
   * AMENDED 2026-09-03 (LV-7): read it as "this board needs no refetch to be
   * right about this frame". True now covers two outcomes - a move that was
   * applied, and a redelivered frame that was absorbed because the row already
   * carries that move. False stays reserved for the snapshot DISAGREEING with
   * the event, which is the only case a refetch can settle.
   */
  readonly matched: boolean;
}

/**
 * Move one agent between status buckets of its session. The move is applied
 * only when the snapshot can absorb it honestly: the target bucket must be
 * present, and the bucket the agent leaves must be present and non-empty (a
 * null previousStatus means the agent had no persisted status, so it sat in
 * no bucket). Anything else means this snapshot disagrees with the server -
 * incrementing anyway would invent an agent that was never counted, so the
 * caller is told to refetch persisted truth instead. Counts other than the
 * two touched buckets - and every other session - stay untouched;
 * `lastActivityAt` advances to the event's occurredAt (a real observation).
 *
 * `livePatches` increments on every applied move, so the card can name which of
 * its figures are live and which are as-of-fetch. Without that the row's two
 * ages are indistinguishable on screen - see BoardSession.
 *
 * AMENDED 2026-09-03 (LV-1, LV-4): two more ways a frame could write something
 * the snapshot cannot support, both from the stream's lack of an ordering or
 * uniqueness guarantee.
 *
 * - The sentence above about `lastActivityAt` advancing "to the event's
 *   occurredAt" now reads: it advances to the LATER of the row's value and the
 *   event's, and never to an unreadable one (see laterActivityAt). A late or
 *   redelivered frame used to move the card's freshness label backwards.
 * - A `previousStatus: null` move grows the bucket total, so it is now refused
 *   when the total would exceed the session's own agentCount - a redelivered
 *   first-sighting frame could otherwise show four working agents in a
 *   three-agent session. Refusing is the module's existing remedy: the caller
 *   refetches persisted truth rather than rendering an impossibility.
 *
 * AMENDED 2026-09-03 (LV-7): the third consequence of that missing uniqueness
 * guarantee, and the one the ceiling above cannot see. A redelivered ORDINARY
 * transition breaks no ceiling - `working -> completed` decrements one bucket
 * and increments another, so the totals stay legal however often it is applied
 * - and it therefore moved a SECOND agent every time it arrived twice, for as
 * long as the bucket the agent left was still non-empty, which it is exactly
 * when other agents are working. One agent finishing was rendered as two.
 *
 * The frame names its agent, so the row now remembers which status each move it
 * applied put that agent into (`appliedAgentStatuses`), and a frame moving that
 * agent into the status it is already in is absorbed rather than applied - it
 * cannot be a move, whether it is a literal redelivery or a frame that
 * contradicts what this board already did.
 *
 * A repeat is answered with `matched: true`, unlike every refusal above,
 * because a REPEAT is not a DISAGREEMENT: the row already carries the move, so
 * a refetch has nothing to add, and answering false would make a redelivering
 * stream refetch the whole board once per redelivered frame - trading a
 * miscount for a request storm. Absorbing rewrites nothing at all: the same
 * array comes back, so `livePatches` does not tick and `lastActivityAt` does
 * not advance on a frame that is evidence of nothing new. The check runs before
 * the refusals for the same reason - the last working agent's second
 * `working -> completed` finds an empty `working` bucket, and refusing there
 * would refetch for a board that is already right.
 *
 * The memory reaches exactly as far as the row it rides, and no further. A
 * refetch replaces the row with a plain server summary, which carries counts
 * and never which agent sits in which bucket - so a frame redelivered across a
 * refetch is indistinguishable from a real transition that followed it, and is
 * applied. That is the deliberate half of the boundary: a stale frame
 * re-applied is repaired by the next refetch, while a real transition
 * suppressed by a memory that outlived its row would leave an agent frozen in
 * the wrong bucket with nothing left to correct it.
 *
 * AMENDED 2026-09-08 (LV-8): that memory is evidence in both directions, and
 * only one of them was read. A frame agreeing with it was absorbed; a frame
 * CONTRADICTING it - one whose previousStatus is not the status this board
 * moved that agent into - was applied like any other. The buckets carry counts
 * and no names, so it was applied to whichever agent happened to sit in the
 * bucket it named: one agent's stale transition was rendered as a different,
 * unrelated agent's, in a session where nothing else was wrong.
 *
 * The missing ordering guarantee reaches this on two paths, and neither is a
 * repeat that LV-7 can absorb. A frame LOST between two that arrived leaves the
 * row behind, so the next frame's previousStatus names a status this board
 * never applied. And a redelivered FIRST SIGHTING arriving after its agent has
 * moved on clears the LV-4 ceiling whenever the session still has an unplaced
 * agent, so it added a placed agent that does not exist. Both are
 * DISAGREEMENTS, which is exactly the case a refetch settles, so both now take
 * the refusal path.
 */
export function applyAgentStatusChange(
  sessions: readonly BoardSession[],
  event: AgentStatusChangedEvent,
): StatusChangeResult {
  const index = sessions.findIndex((session) => session.id === event.sessionId);
  if (index === -1) return { sessions, matched: false };
  const session = sessions[index]!;
  const applied = appliedStatusOf(session, event.agentId);
  // LV-7: a frame moving an agent into the status this board already moved it
  // into is not a move. Absorbed, not refused - see the note above.
  if (applied === event.status) {
    return { sessions, matched: true };
  }
  // LV-8: the frame's account of where the agent WAS is not where this board
  // put it. Buckets carry counts and no names, so applying it would decrement
  // the bucket whichever OTHER agent happens to occupy - see the note above.
  if (applied !== undefined && event.previousStatus !== applied) {
    return { sessions, matched: false };
  }
  const target = bucketCount(session.statusCounts, event.status);
  const leaving =
    event.previousStatus === null ? null : bucketCount(session.statusCounts, event.previousStatus);
  if (target === undefined || leaving === undefined || leaving === 0) {
    return { sessions, matched: false };
  }
  // LV-4: a first sighting adds an agent to the buckets rather than moving one,
  // so it is the only move that can overrun the session's agent count.
  if (leaving === null && placedAgentCount(session.statusCounts) >= session.agentCount) {
    return { sessions, matched: false };
  }
  const counts = { ...session.statusCounts };
  counts[event.status] = target + 1;
  if (event.previousStatus !== null) counts[event.previousStatus] -= 1;
  const next = [...sessions];
  next[index] = {
    ...session,
    statusCounts: counts,
    lastActivityAt: laterActivityAt(session.lastActivityAt, event.occurredAt),
    livePatches: livePatchCount(session) + 1,
    appliedAgentStatuses: { ...session.appliedAgentStatuses, [event.agentId]: event.status },
  };
  return { sessions: next, matched: true };
}

/**
 * Board order: most recent activity first; sessions with no recorded
 * activity timestamp sink to the end (never invented); ties keep input
 * order (stable sort keyed by index).
 */
export function sortSessionsByRecency<T extends Pick<SessionSummaryDto, 'lastActivityAt'>>(
  sessions: readonly T[],
): readonly T[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const aTime = a.session.lastActivityAt !== null ? Date.parse(a.session.lastActivityAt) : NaN;
      const bTime = b.session.lastActivityAt !== null ? Date.parse(b.session.lastActivityAt) : NaN;
      const aValid = !Number.isNaN(aTime);
      const bValid = !Number.isNaN(bTime);
      if (aValid && bValid && aTime !== bTime) return bTime - aTime;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.session);
}
