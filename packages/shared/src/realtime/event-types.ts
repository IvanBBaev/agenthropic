/**
 * The single authoritative list of typed SSE event names the server publishes
 * on `/api/stream`. EventSource silently drops a named event that has no
 * registered listener, so both ends MUST agree on this list: the server's
 * realtime bridge pins every published `type` literal to it (`satisfies
 * ServerEventType`), and the web client registers one EventSource listener
 * per entry. The list used to be hand-copied per package and drifted once -
 * `ingest-failed` was published but never heard, so a quarantined session
 * produced nothing in the UI - which is why it now lives here and nowhere
 * else.
 *
 * This module stays import-free on purpose: the web bundle pulls it in by a
 * deep relative path precisely because it carries no TypeBox (see
 * apps/web/src/dto.ts for why the web package has no runtime dependency on
 * this package's index).
 */
export const SERVER_EVENT_TYPES = [
  'session-ingested',
  'agent-status-changed',
  'ingest-failed',
] as const;

/** One of the typed SSE event names in {@link SERVER_EVENT_TYPES}. */
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
