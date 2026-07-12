import { describe, expect, it } from 'vitest';
import { buildLoggerOptions, redactedRequestSerializer } from '../src/server';

describe('request log redaction (WP-U0)', () => {
  const SECRET = 'test-token-0123456789abcdef';

  it('redactedRequestSerializer scrubs the token from the stream URL', () => {
    const out = redactedRequestSerializer({
      method: 'GET',
      url: `/api/stream?token=${SECRET}`,
    });
    expect(out).toEqual({ method: 'GET', url: '/api/stream?token=REDACTED' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('redactedRequestSerializer leaves token-free URLs intact', () => {
    expect(redactedRequestSerializer({ method: 'GET', url: '/api/health' })).toEqual({
      method: 'GET',
      url: '/api/health',
    });
  });

  it('buildLoggerOptions(false) disables logging entirely', () => {
    expect(buildLoggerOptions(false)).toBe(false);
  });

  it('buildLoggerOptions(true) installs the redacting req serializer', () => {
    const options = buildLoggerOptions(true);
    expect(options).not.toBe(false);
    // The serializer is wired and redacts, so an enabled logger can never leak.
    const serializer = (options as { serializers: { req: typeof redactedRequestSerializer } })
      .serializers.req;
    expect(serializer({ method: 'GET', url: `/api/stream?token=${SECRET}` }).url).toBe(
      '/api/stream?token=REDACTED',
    );
  });
});
