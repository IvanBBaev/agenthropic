/**
 * Compile-time pin between the wire shape the server publishes for
 * `ingest-failed` and the shape `toIngestFailureNotice` narrows by hand
 * (L4, 2026-09-09).
 *
 * `apps/web` carries no TypeBox and validates nothing at runtime against the
 * shared schemas (see `src/dto.ts`), so a server-side change to this event
 * cannot by itself fail any check in this package. The narrowing would simply
 * start returning null for every frame, and the live board would render a
 * count of unreadable failures instead of naming the sessions that failed:
 * bad news kept, but stripped of the one field that makes it actionable. That
 * is the drift class that once left this event published but unheard.
 *
 * The pin is the type annotation, not the assertion. `frame` is declared as
 * the shared `IngestFailedEvent`, so the day that type loses its `payload`
 * envelope - or renames a field inside it - this file stops compiling and
 * `tsc -b apps/web` goes red. The assertions then say what a type cannot: that
 * the hand-written narrowing actually accepts the shape the type describes.
 */
import { describe, expect, it } from 'vitest';
import type { AgentStatusChangedEvent, IngestFailedEvent, SessionIngestedEvent } from '../src/dto';
import { ingestedSessionId, toIngestFailureNotice } from '../src/views/LiveView';
import { isAgentStatusChangedEvent } from '../src/views/live-model';

describe('ingest-failed wire shape', () => {
  it('narrows a frame typed by the shared schema', () => {
    const frame: IngestFailedEvent = {
      type: 'ingest-failed',
      payload: {
        sessionId: 'sess-quarantined',
        reason: 'substrate unreadable after 3 attempts',
        attempt: 3,
        willRetry: false,
        occurredAt: '2026-09-09T10:00:00.000Z',
      },
    };

    // `occurredAt` is absent from the notice on purpose: a failure row renders
    // no time at all, and the narrowing carries only what the board shows.
    expect(toIngestFailureNotice(frame)).toEqual({
      sessionId: 'sess-quarantined',
      reason: 'substrate unreadable after 3 attempts',
      attempt: 3,
      willRetry: false,
    });
  });

  it('refuses the flat shape the typed arm deliberately did not adopt', () => {
    // Deliberately untyped: this is what `ingest-failed` would look like had it
    // been flattened to match its two sibling arms when it was typed. Every
    // field is present and correct and the narrowing still refuses it, which is
    // the whole reason the envelope was kept.
    const flat = {
      type: 'ingest-failed',
      sessionId: 'sess-quarantined',
      reason: 'substrate unreadable after 3 attempts',
      attempt: 3,
      willRetry: false,
      occurredAt: '2026-09-09T10:00:00.000Z',
    };

    expect(toIngestFailureNotice(flat)).toBeNull();
  });
});

/**
 * The same pin for the two sibling arms, which `live-model.ts` and `LiveView.tsx`
 * also narrow by hand (follow-up to L4, found-not-taken 2026-09-09).
 *
 * `isAgentStatusChangedEvent` is declared as a type predicate over the shared
 * `AgentStatusChangedEvent`, but a predicate is a promise the compiler takes on
 * trust: it never checks that the body reads the fields the type names. A field
 * renamed or added on the server would leave the guard checking the old shape
 * while still certifying frames as the new one.
 *
 * `GUARDED_STATUS_FIELDS` closes that. `satisfies Record<keyof …, true>` makes
 * the list exhaustive in both directions at compile time - a field added to the
 * shared type is a missing key, a field removed or renamed is an excess one - and
 * the drop-one-field sweep below proves at run time that the guard refuses a
 * frame missing any listed field, i.e. that it really reads every one of them.
 */
const GUARDED_STATUS_FIELDS = {
  type: true,
  sessionId: true,
  agentId: true,
  status: true,
  previousStatus: true,
  occurredAt: true,
} as const satisfies Record<keyof AgentStatusChangedEvent, true>;

describe('agent-status-changed wire shape', () => {
  const frame: AgentStatusChangedEvent = {
    type: 'agent-status-changed',
    sessionId: 'sess-live',
    agentId: 'agent-1',
    status: 'completed',
    previousStatus: 'working',
    occurredAt: '2026-09-26T10:00:00.000Z',
  };

  it('accepts a frame typed by the shared schema', () => {
    expect(isAgentStatusChangedEvent(frame)).toBe(true);
  });

  it('accepts the first-sighting frame, whose previousStatus is null', () => {
    const firstSighting: AgentStatusChangedEvent = { ...frame, previousStatus: null };
    expect(isAgentStatusChangedEvent(firstSighting)).toBe(true);
  });

  it.each(Object.keys(GUARDED_STATUS_FIELDS))('refuses a frame missing `%s`', (field) => {
    const partial: Record<string, unknown> = { ...frame };
    delete partial[field];
    expect(isAgentStatusChangedEvent(partial)).toBe(false);
  });
});

describe('session-ingested wire shape', () => {
  it('reads the session id from a frame typed by the shared schema', () => {
    // The board reads one field of this frame - the rest only triggers a
    // refetch - so the typed literal is the pin: renaming `sessionId` in the
    // shared schema makes this object stop compiling.
    const frame: SessionIngestedEvent = {
      type: 'session-ingested',
      sessionId: 'sess-ingested',
      projectSlug: null,
      agentCount: 3,
      edgesInserted: 2,
      usageRowsInserted: 7,
      costUsd: null,
      occurredAt: '2026-09-26T10:00:00.000Z',
    };

    expect(ingestedSessionId(frame)).toBe('sess-ingested');
  });
});
