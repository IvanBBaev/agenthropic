/**
 * SEC-7 - the input bounds in src/limits.ts, each proven where it bites:
 * nesting depth (redaction, canonicalisation, the hook route), id length
 * (route params, the topTierModel query, ids lifted from a hook payload) and
 * the explicit request body limit.
 *
 * The finding this closes: a body of 5,000 nested `[` fits easily under the
 * 1 MiB limit and overflowed the recursive redaction, which the error handler
 * reported as a generic 500. It is now a 400 that names the limit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryEventStore } from '@agenthropic/shared/testing';
import {
  MAX_ID_LENGTH,
  MAX_PAYLOAD_DEPTH,
  MAX_REQUEST_BODY_BYTES,
  PayloadTooDeepError,
  assertDepthWithinLimit,
} from '../src/limits';
import { redactSecrets } from '../src/hooks/redact';
import { buildHookEnvelope, canonicalJsonStringify } from '../src/hooks/envelope';
import { extractLivenessIds } from '../src/db/event-store';
import { HOOK_EVENT_PATH, registerHookRoutes } from '../src/hooks/routes';
import { buildServer } from '../src/server';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };
const DEPTH_MESSAGE = `Hook payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels.`;

/** `levels` arrays nested inside one another, the innermost holding `leaf`. */
function nestedArrays(levels: number, leaf: unknown = 'leaf'): unknown {
  let value: unknown = leaf;
  for (let i = 0; i < levels; i += 1) value = [value];
  return value;
}

/** `levels` objects nested inside one another under the key `k`. */
function nestedObjects(levels: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < levels; i += 1) value = { k: value };
  return value;
}

describe('assertDepthWithinLimit / PayloadTooDeepError (SEC-7)', () => {
  it('admits depths below the limit and refuses the limit itself', () => {
    expect(() => assertDepthWithinLimit(0)).not.toThrow();
    expect(() => assertDepthWithinLimit(MAX_PAYLOAD_DEPTH - 1)).not.toThrow();
    expect(() => assertDepthWithinLimit(MAX_PAYLOAD_DEPTH)).toThrow(PayloadTooDeepError);
  });

  it('carries a 400 and a message that names the limit', () => {
    const error = new PayloadTooDeepError();
    expect(error.statusCode).toBe(400);
    expect(error.name).toBe('PayloadTooDeepError');
    expect(error.message).toBe(DEPTH_MESSAGE);
  });
});

describe('redactSecrets depth limit (SEC-7)', () => {
  it(`redacts a payload exactly ${MAX_PAYLOAD_DEPTH} containers deep`, () => {
    expect(redactSecrets(nestedArrays(MAX_PAYLOAD_DEPTH))).toEqual(nestedArrays(MAX_PAYLOAD_DEPTH));
    expect(redactSecrets(nestedObjects(MAX_PAYLOAD_DEPTH))).toEqual(
      nestedObjects(MAX_PAYLOAD_DEPTH),
    );
  });

  it('does not count a primitive leaf as a level', () => {
    expect(redactSecrets(nestedArrays(MAX_PAYLOAD_DEPTH, null))).toEqual(
      nestedArrays(MAX_PAYLOAD_DEPTH, null),
    );
  });

  it('throws PayloadTooDeepError one container past the limit, arrays and objects alike', () => {
    expect(() => redactSecrets(nestedArrays(MAX_PAYLOAD_DEPTH + 1))).toThrow(PayloadTooDeepError);
    expect(() => redactSecrets(nestedObjects(MAX_PAYLOAD_DEPTH + 1))).toThrow(PayloadTooDeepError);
  });

  it('throws PayloadTooDeepError, not RangeError, far past the limit', () => {
    expect(() => redactSecrets(nestedArrays(100_000))).toThrow(PayloadTooDeepError);
  });

  it('still masks secrets at the deepest admitted level', () => {
    const deep = nestedObjects(MAX_PAYLOAD_DEPTH - 1);
    let cursor = deep as Record<string, unknown>;
    while (typeof cursor.k === 'object') cursor = cursor.k as Record<string, unknown>;
    cursor.k = { api_key: 'sk-not-a-real-key' };
    expect(JSON.stringify(redactSecrets(deep))).toContain('"api_key":"[REDACTED]"');
  });
});

describe('canonicalJsonStringify depth limit (SEC-7)', () => {
  it(`canonicalises a value exactly ${MAX_PAYLOAD_DEPTH} containers deep`, () => {
    const value = nestedObjects(MAX_PAYLOAD_DEPTH);
    expect(canonicalJsonStringify(value)).toBe(JSON.stringify(value));
    expect(canonicalJsonStringify(nestedArrays(MAX_PAYLOAD_DEPTH))).toBe(
      JSON.stringify(nestedArrays(MAX_PAYLOAD_DEPTH)),
    );
  });

  it('throws PayloadTooDeepError one container past the limit', () => {
    expect(() => canonicalJsonStringify(nestedArrays(MAX_PAYLOAD_DEPTH + 1))).toThrow(
      PayloadTooDeepError,
    );
    expect(() => canonicalJsonStringify(nestedObjects(MAX_PAYLOAD_DEPTH + 1))).toThrow(
      PayloadTooDeepError,
    );
  });
});

describe('id length cap on hook payload ids (SEC-7)', () => {
  const atCap = 's'.repeat(MAX_ID_LENGTH);
  const overCap = 's'.repeat(MAX_ID_LENGTH + 1);

  it('the envelope keeps a session id at the cap and omits a longer one', () => {
    const kept = buildHookEnvelope({ session_id: atCap }, '2026-11-19T00:00:00.000Z');
    expect(kept.envelope.sessionId).toBe(atCap);
    const omitted = buildHookEnvelope({ session_id: overCap }, '2026-11-19T00:00:00.000Z');
    expect(omitted.envelope).not.toHaveProperty('sessionId');
    // The body itself is still carried verbatim.
    expect(omitted.envelope.payload).toEqual({ session_id: overCap });
  });

  it('the liveness projection keeps ids at the cap and nulls longer ones', () => {
    expect(extractLivenessIds({ session_id: atCap, agent_id: atCap })).toEqual({
      sessionId: atCap,
      agentId: atCap,
    });
    expect(extractLivenessIds({ session_id: overCap, agent_id: overCap })).toEqual({
      sessionId: null,
      agentId: null,
    });
  });
});

describe('hook route under the input bounds (SEC-7)', () => {
  let app: FastifyInstance;
  let store: InMemoryEventStore;

  beforeEach(async () => {
    store = new InMemoryEventStore();
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
    await registerHookRoutes(app, { eventStore: store });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: string) =>
    app.inject({ method: 'POST', url: HOOK_EVENT_PATH, headers: JSON_AUTH, payload });

  it(`stores a body nested exactly ${MAX_PAYLOAD_DEPTH} levels deep`, async () => {
    const depth = MAX_PAYLOAD_DEPTH;
    const response = await post('['.repeat(depth) + ']'.repeat(depth));
    expect(response.statusCode).toBe(202);
    expect(store.readAll()).toHaveLength(1);
  });

  it('answers a deeply nested body with 400 naming the limit, not 500, and stores nothing', async () => {
    for (const depth of [MAX_PAYLOAD_DEPTH + 1, 5_000, 100_000]) {
      const response = await post('['.repeat(depth) + ']'.repeat(depth));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: DEPTH_MESSAGE });
    }
    expect(store.readAll()).toHaveLength(0);
  });

  it('sets the body limit explicitly and answers a larger body with 413', async () => {
    expect(app.initialConfig.bodyLimit).toBe(MAX_REQUEST_BODY_BYTES);
    expect(app.initialConfig.routerOptions?.maxParamLength).toBe(MAX_ID_LENGTH);
    const response = await post(JSON.stringify({ blob: 'x'.repeat(MAX_REQUEST_BODY_BYTES) }));
    expect(response.statusCode).toBe(413);
    expect(store.readAll()).toHaveLength(0);
  });
});

describe('id length cap on API inputs (SEC-7)', () => {
  let temp: TempDb;
  let app: FastifyInstance;

  beforeEach(async () => {
    temp = createMigratedTempDb();
    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, db: temp.db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    temp.cleanup();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: AUTH });

  it('a session id at the cap is a normal lookup (404); one past it is refused by the router (414)', async () => {
    expect((await get(`/api/sessions/${'s'.repeat(MAX_ID_LENGTH)}`)).statusCode).toBe(404);
    expect((await get(`/api/sessions/${'s'.repeat(MAX_ID_LENGTH + 1)}`)).statusCode).toBe(414);
  });

  it('a topTierModel past the cap is a 400', async () => {
    const response = await get(
      `/api/cost/delegation-savings?topTierModel=${'m'.repeat(MAX_ID_LENGTH + 1)}`,
    );
    expect(response.statusCode).toBe(400);
  });
});
