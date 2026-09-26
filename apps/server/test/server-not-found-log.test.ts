/**
 * An unrouted request never writes its URL into a log line.
 *
 * Fastify's default 404 handler logs `Route <METHOD>:<url> not found` as a
 * plain message string, which never passes through the redacting `req`
 * serializer. A `POST /api/stream?token=...` (or any path when no web root is
 * served) therefore put the dashboard token into the log verbatim. The root
 * not-found handler answers with the same `{ error }` body and logs nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';

const TOKEN = 'test-token-0123456789abcdef';
const SECRET = 'SECRETLEAK1234567';

describe('unrouted requests', () => {
  let app: ReturnType<typeof buildServer> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers 404 without logging the URL or its token', async () => {
    app = buildServer({ token: TOKEN, schemaVersion: 1 });
    const lines: string[] = [];
    app.addHook('onRequest', (request, _reply, done) => {
      for (const level of ['info', 'warn', 'error', 'debug'] as const) {
        const original = request.log[level].bind(request.log);
        request.log[level] = ((...args: unknown[]) => {
          lines.push(JSON.stringify(args));
          return (original as (...a: unknown[]) => void)(...args);
        }) as typeof request.log.info;
      }
      done();
    });

    const response = await app.inject({ method: 'POST', url: `/api/stream?token=${SECRET}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Not found.' });
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
