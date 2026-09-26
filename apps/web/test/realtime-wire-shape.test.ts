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
import type { IngestFailedEvent } from '../src/dto';
import { toIngestFailureNotice } from '../src/views/LiveView';

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
