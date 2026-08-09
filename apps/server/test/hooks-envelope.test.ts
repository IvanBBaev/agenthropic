/**
 * WP-IN1 - envelope construction, canonicalization and idempotency-key
 * determinism: same hook event -> same key regardless of receipt time and
 * JSON property order; different payload -> different key.
 */
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  HookEnvelopeSchema,
  UNKNOWN_HOOK_NAME,
  buildHookEnvelope,
  canonicalJsonStringify,
  computeIdempotencyKey,
} from '../src/hooks/envelope';

const RECEIVED_AT = '2026-07-18T10:00:00.000Z';

describe('canonicalJsonStringify (WP-IN1)', () => {
  it('is independent of object key order, recursively', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('preserves array element order', () => {
    expect(canonicalJsonStringify([1, 2])).not.toBe(canonicalJsonStringify([2, 1]));
  });

  it('encodes primitives with JSON semantics', () => {
    expect(canonicalJsonStringify('x')).toBe('"x"');
    expect(canonicalJsonStringify(3)).toBe('3');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify(null)).toBe('null');
  });

  it('maps non-JSON values like JSON.stringify does', () => {
    expect(canonicalJsonStringify(undefined)).toBe('null');
    expect(canonicalJsonStringify(Number.NaN)).toBe('null');
    expect(canonicalJsonStringify(Number.POSITIVE_INFINITY)).toBe('null');
    // undefined entries: skipped in objects, null in arrays.
    expect(canonicalJsonStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJsonStringify([undefined, 1])).toBe('[null,1]');
  });
});

describe('buildHookEnvelope + computeIdempotencyKey (WP-IN1)', () => {
  const body = {
    hook_event_name: 'SubagentStop',
    session_id: 'session-1',
    transcript_path: '/tmp/t.jsonl',
  };

  it('builds a schema-valid envelope from a Claude Code hook body', () => {
    const { envelope } = buildHookEnvelope(body, RECEIVED_AT);
    expect(envelope).toEqual({
      source: 'hook',
      hookName: 'SubagentStop',
      sessionId: 'session-1',
      receivedAt: RECEIVED_AT,
      payload: body,
    });
    expect(Value.Check(HookEnvelopeSchema, envelope)).toBe(true);
  });

  it('produces a stable, well-formed key', () => {
    const { idempotencyKey } = buildHookEnvelope(body, RECEIVED_AT);
    expect(idempotencyKey).toMatch(/^hook:sha256:[0-9a-f]{64}$/);
  });

  it('same event delivered twice (different receivedAt) -> same key', () => {
    const first = buildHookEnvelope(body, RECEIVED_AT);
    const second = buildHookEnvelope(body, '2026-07-18T10:00:05.000Z');
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('key is independent of payload property order', () => {
    const reordered = {
      transcript_path: '/tmp/t.jsonl',
      session_id: 'session-1',
      hook_event_name: 'SubagentStop',
    };
    expect(buildHookEnvelope(reordered, RECEIVED_AT).idempotencyKey).toBe(
      buildHookEnvelope(body, RECEIVED_AT).idempotencyKey,
    );
  });

  it('differing payload -> different key', () => {
    const other = { ...body, transcript_path: '/tmp/other.jsonl' };
    expect(buildHookEnvelope(other, RECEIVED_AT).idempotencyKey).not.toBe(
      buildHookEnvelope(body, RECEIVED_AT).idempotencyKey,
    );
  });

  it('differing hook name or session -> different key', () => {
    const base = buildHookEnvelope(body, RECEIVED_AT).idempotencyKey;
    expect(
      buildHookEnvelope({ ...body, hook_event_name: 'Stop' }, RECEIVED_AT).idempotencyKey,
    ).not.toBe(base);
    expect(
      buildHookEnvelope({ ...body, session_id: 'session-2' }, RECEIVED_AT).idempotencyKey,
    ).not.toBe(base);
  });

  it('accepts camelCase field variants', () => {
    const { envelope } = buildHookEnvelope({ hookName: 'Stop', sessionId: 's-9' }, RECEIVED_AT);
    expect(envelope.hookName).toBe('Stop');
    expect(envelope.sessionId).toBe('s-9');
  });

  it('falls back to "unknown" and omits sessionId when unidentifiable', () => {
    const fromArray = buildHookEnvelope([1, 2, 3], RECEIVED_AT);
    expect(fromArray.envelope.hookName).toBe(UNKNOWN_HOOK_NAME);
    expect(fromArray.envelope.sessionId).toBeUndefined();
    expect(fromArray.envelope.payload).toEqual([1, 2, 3]);

    const fromEmpty = buildHookEnvelope({ foo: 'bar' }, RECEIVED_AT);
    expect(fromEmpty.envelope.hookName).toBe(UNKNOWN_HOOK_NAME);

    const fromNonString = buildHookEnvelope({ hook_event_name: 42 }, RECEIVED_AT);
    expect(fromNonString.envelope.hookName).toBe(UNKNOWN_HOOK_NAME);
  });

  it('computeIdempotencyKey ignores receivedAt directly', () => {
    const { envelope } = buildHookEnvelope(body, RECEIVED_AT);
    const shifted = { ...envelope, receivedAt: '2027-01-01T00:00:00.000Z' };
    expect(computeIdempotencyKey(shifted)).toBe(computeIdempotencyKey(envelope));
  });
});

/**
 * RECURRENCE vs REDELIVERY. Claude Code's `Stop` hook stdin is byte-identical
 * on every turn of a session (session_id, transcript_path, cwd,
 * hook_event_name, stop_hook_active - nothing turn-specific). Content hashing
 * alone therefore cannot tell "this event happened again" from "this event was
 * delivered twice": turn 2 hashes to turn 1's key and the liveness timeline
 * silently collapses to a single row.
 *
 * Only the SENDER knows which of the two it is doing, so the sender identifies
 * its delivery (the WP-X8 hook command mints a fresh id per firing and curl
 * reuses it across its own retries). The delivery id is KEY MATERIAL ONLY - it
 * is never persisted, never logged, never echoed. CD-1 is untouched: this
 * changes how many liveness rows land, never the agent/edge topology.
 */
describe('delivery identity (WP-IN1 recurrence vs redelivery)', () => {
  /** Verbatim shape of Claude Code `Stop` hook stdin - identical every turn. */
  const stopBody = {
    session_id: 'session-1',
    transcript_path: '/tmp/session-1.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };

  it('two genuine firings of a byte-identical body get DIFFERENT keys', () => {
    const turnOne = buildHookEnvelope(stopBody, RECEIVED_AT, 'delivery-1');
    const turnTwo = buildHookEnvelope(stopBody, '2026-07-18T10:05:00.000Z', 'delivery-2');
    expect(turnTwo.idempotencyKey).not.toBe(turnOne.idempotencyKey);
  });

  it('a retry that REUSES its delivery id keeps the same key (redelivery still dedupes)', () => {
    const sent = buildHookEnvelope(stopBody, RECEIVED_AT, 'delivery-1');
    const retried = buildHookEnvelope(stopBody, '2026-07-18T10:00:02.000Z', 'delivery-1');
    expect(retried.idempotencyKey).toBe(sent.idempotencyKey);
  });

  it('carries the delivery id on the envelope and stays schema-valid', () => {
    const { envelope } = buildHookEnvelope(stopBody, RECEIVED_AT, 'delivery-1');
    expect(envelope).toEqual({
      source: 'hook',
      hookName: 'Stop',
      sessionId: 'session-1',
      receivedAt: RECEIVED_AT,
      deliveryId: 'delivery-1',
      payload: stopBody,
    });
    expect(Value.Check(HookEnvelopeSchema, envelope)).toBe(true);
  });

  it('an UNIDENTIFIED delivery keeps the conservative collapse (trade-off, stated)', () => {
    // A client that supplies no delivery id cannot be told apart from itself:
    // identical payloads still hash to one key, exactly as before this change.
    const first = buildHookEnvelope(stopBody, RECEIVED_AT);
    const second = buildHookEnvelope(stopBody, '2026-07-18T10:05:00.000Z');
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.envelope.deliveryId).toBeUndefined();
  });

  it('keys of unidentified deliveries are UNCHANGED by this feature (stable across upgrade)', () => {
    // The material omits the field entirely when absent, so keys already in a
    // production events_raw keep matching after the upgrade.
    const { envelope } = buildHookEnvelope(stopBody, RECEIVED_AT);
    expect(computeIdempotencyKey(envelope)).toBe(
      computeIdempotencyKey({ ...envelope, deliveryId: undefined }),
    );
  });
});
