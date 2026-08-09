/**
 * WP-IN1 - the hook event envelope and its deterministic idempotency key.
 *
 * Every hook delivery is wrapped in a small envelope before it reaches the
 * append-only `events_raw` substrate:
 *
 *   { source: 'hook', hookName, sessionId?, receivedAt, deliveryId?, payload }
 *
 * The idempotency key is a SHA-256 content hash over the CANONICALIZED
 * envelope MINUS `receivedAt`, PLUS the sender's `deliveryId`. Canonicalization
 * sorts object keys recursively, making the key independent of JSON property
 * order on the wire.
 *
 * RECURRENCE vs REDELIVERY (why `deliveryId` exists). Claude Code's `Stop`
 * stdin is byte-identical on every turn of a session - it carries session_id,
 * transcript_path, cwd, hook_event_name and stop_hook_active, and nothing
 * turn-specific. Content alone therefore cannot distinguish "this event
 * happened again" (turn 2) from "this event was delivered twice" (a retry):
 * hashing content only collapses a 50-turn session into a single `Stop` row and
 * guts the WP-D5 liveness timeline. Only the SENDER knows which of the two it
 * is doing, so the sender stamps each FIRING with a fresh id and reuses that id
 * across that firing's own retries (see hooks/install.mjs).
 *
 * Trade-off, stated plainly:
 *  - a client that mints one id per firing gets one row per genuine event and
 *    still dedupes its own retries;
 *  - a client that mints a NEW id per network attempt double-counts a retry;
 *  - a client that supplies NO id keeps the old, conservative behaviour - a
 *    genuine recurrence still collapses into the first delivery. Absent ids are
 *    OMITTED from the key material (not defaulted), so keys already stored in a
 *    production `events_raw` keep matching across this upgrade.
 *
 * `deliveryId` is KEY MATERIAL ONLY: the event store never persists it, no
 * route echoes it, and nothing derived from it touches the DAG - hooks stay
 * liveness only, never structure (CD-1).
 *
 * Hooks are a SECONDARY data source (Phase-0 probe: 0/463 spawn edges were
 * hook-sourced; JSONL transcripts are ground truth). The envelope therefore
 * carries the payload verbatim (post-redaction) and never interprets it.
 */
import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';

/** The storage/wire shape of a hook event envelope (WP-IN1). */
export const HookEnvelopeSchema = Type.Object(
  {
    source: Type.Literal('hook'),
    /** Claude Code hook name as self-reported; `'unknown'` when absent. */
    hookName: Type.String({ minLength: 1 }),
    sessionId: Type.Optional(Type.String({ minLength: 1 })),
    /** ISO-8601 UTC receipt time. Excluded from the idempotency key. */
    receivedAt: Type.String({ minLength: 1 }),
    /**
     * Sender-minted id for THIS delivery attempt-group: one value per genuine
     * firing, reused across that firing's retries. Key material only - never
     * persisted, never echoed. Absent for clients that do not supply one.
     */
    deliveryId: Type.Optional(Type.String({ minLength: 1 })),
    /** The hook body as received (already redacted at the ingest boundary). */
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export type HookEnvelope = Static<typeof HookEnvelopeSchema>;

/** hookName used when the payload does not self-identify. */
export const UNKNOWN_HOOK_NAME = 'unknown';

/**
 * Deterministic JSON canonicalization: object keys sorted recursively,
 * JSON.stringify semantics otherwise (undefined/function/symbol/bigint
 * entries are skipped in objects and become `null` in arrays; non-finite
 * numbers become `null`). Inputs come from `JSON.parse` of a request body,
 * so only plain JSON types occur in practice; the function is total over
 * acyclic values regardless.
 */
export function canonicalJsonStringify(value: unknown): string {
  return stringifyCanonical(value) ?? 'null';
}

function stringifyCanonical(value: unknown): string | undefined {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint - not representable in JSON.
      return undefined;
  }
  if (Array.isArray(value)) {
    const elements = value.map((element) => stringifyCanonical(element) ?? 'null');
    return `[${elements.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = stringifyCanonical(record[key]);
    if (encoded !== undefined) {
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
  }
  return `{${parts.join(',')}}`;
}

/**
 * SHA-256 hash over the canonicalized envelope minus `receivedAt` and plus
 * `deliveryId`. Same firing redelivered -> same key -> zero new rows on the
 * second append (the event-store port is idempotent by key); a different
 * firing of an identical body -> different key -> a second liveness row.
 *
 * `canonicalJsonStringify` SKIPS undefined object entries, so an envelope with
 * no `deliveryId` hashes byte-identically to one built before this field
 * existed - the upgrade is key-stable.
 */
export function computeIdempotencyKey(envelope: HookEnvelope): string {
  const material = {
    source: envelope.source,
    hookName: envelope.hookName,
    sessionId: envelope.sessionId,
    deliveryId: envelope.deliveryId,
    payload: envelope.payload,
  };
  const digest = createHash('sha256')
    .update(canonicalJsonStringify(material), 'utf8')
    .digest('hex');
  return `hook:sha256:${digest}`;
}

export interface BuiltHookEnvelope {
  readonly envelope: HookEnvelope;
  readonly idempotencyKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Build the envelope for an arbitrary hook body (accept-any-event: unknown
 * hook names, extra fields, even non-object bodies are all representable -
 * they are stored, never rejected). `hook_event_name` / `session_id` are the
 * field names Claude Code puts on hook stdin JSON; camelCase variants are
 * accepted as a courtesy.
 *
 * `deliveryId` is the sender's per-firing id (see the module header). An
 * absent or empty value is OMITTED from the envelope, which keeps the key
 * byte-identical to the pre-`deliveryId` behaviour for clients that supply
 * none.
 */
export function buildHookEnvelope(
  payload: unknown,
  receivedAt: string,
  deliveryId?: string,
): BuiltHookEnvelope {
  const record = isRecord(payload) ? payload : undefined;
  const hookName = readStringField(record, ['hook_event_name', 'hookName']) ?? UNKNOWN_HOOK_NAME;
  const sessionId = readStringField(record, ['session_id', 'sessionId']);
  const envelope: HookEnvelope = {
    source: 'hook',
    hookName,
    ...(sessionId === undefined ? {} : { sessionId }),
    receivedAt,
    ...(deliveryId === undefined || deliveryId.length === 0 ? {} : { deliveryId }),
    payload,
  };
  return { envelope, idempotencyKey: computeIdempotencyKey(envelope) };
}
