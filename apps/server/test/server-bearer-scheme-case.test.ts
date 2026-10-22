/**
 * Audit C-1: the `Bearer` auth-scheme name is case-insensitive (RFC 7235
 * section 2.1). Only the scheme folds - the token is still compared exactly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { TEST_TOKEN } from './helpers';

describe('Authorization scheme case (C-1)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function health(authorization: string): Promise<number> {
    app ??= buildServer({ token: TEST_TOKEN, schemaVersion: 7 });
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization },
    });
    return response.statusCode;
  }

  it.each(['Bearer', 'bearer', 'BEARER', 'bEaReR'])(
    'accepts the %s scheme spelling',
    async (scheme) => {
      expect(await health(`${scheme} ${TEST_TOKEN}`)).toBe(200);
    },
  );

  it('still compares the token itself case-sensitively', async () => {
    expect(await health(`bearer ${TEST_TOKEN.toUpperCase()}`)).toBe(401);
  });

  it('still rejects other schemes and a missing separator', async () => {
    expect(await health(`Basic ${TEST_TOKEN}`)).toBe(401);
    expect(await health(`bearer${TEST_TOKEN}`)).toBe(401);
  });
});
