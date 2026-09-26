import { describe, expect, it } from 'vitest';
import {
  MIN_TOKEN_LENGTH,
  assertLoopbackHost,
  isAllowedOrigin,
  redactTokenInUrl,
  requireDashboardToken,
  timingSafeTokenEqual,
} from '../src/index';

const VALID_TOKEN = 'a-valid-token-of-16'; // 19 chars

describe('requireDashboardToken', () => {
  it('throws when DASHBOARD_TOKEN is unset', () => {
    expect(() => requireDashboardToken({})).toThrow(/DASHBOARD_TOKEN is not set/);
  });

  it('throws when DASHBOARD_TOKEN is undefined', () => {
    expect(() => requireDashboardToken({ DASHBOARD_TOKEN: undefined })).toThrow(/refuses to start/);
  });

  it('throws when DASHBOARD_TOKEN is empty', () => {
    expect(() => requireDashboardToken({ DASHBOARD_TOKEN: '' })).toThrow(/DASHBOARD_TOKEN/);
  });

  it(`throws when DASHBOARD_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters`, () => {
    const short = 'x'.repeat(MIN_TOKEN_LENGTH - 1);
    expect(() => requireDashboardToken({ DASHBOARD_TOKEN: short })).toThrow(/too short/);
  });

  it('never includes the token value in the error message', () => {
    const secret = 'sekret-value-15'; // 15 chars, below minimum
    try {
      requireDashboardToken({ DASHBOARD_TOKEN: secret });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it(`returns the token when it is exactly ${MIN_TOKEN_LENGTH} characters`, () => {
    const token = 'x'.repeat(MIN_TOKEN_LENGTH);
    expect(requireDashboardToken({ DASHBOARD_TOKEN: token })).toBe(token);
  });

  it('returns longer tokens unchanged', () => {
    expect(requireDashboardToken({ DASHBOARD_TOKEN: VALID_TOKEN })).toBe(VALID_TOKEN);
  });
});

describe('timingSafeTokenEqual', () => {
  it('returns true for identical tokens', () => {
    expect(timingSafeTokenEqual(VALID_TOKEN, VALID_TOKEN)).toBe(true);
  });

  it('returns false for different tokens of the same length', () => {
    expect(timingSafeTokenEqual('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaab')).toBe(false);
  });

  it('returns false for tokens of different lengths (no length precondition crash)', () => {
    expect(timingSafeTokenEqual('short', VALID_TOKEN)).toBe(false);
  });

  it('returns false for empty vs non-empty', () => {
    expect(timingSafeTokenEqual('', VALID_TOKEN)).toBe(false);
  });

  it('handles multi-byte input safely', () => {
    expect(timingSafeTokenEqual('multibyte-tökén-✓', 'multibyte-tökén-✓')).toBe(true);
    expect(timingSafeTokenEqual('multibyte-tökén-✓', 'multibyte-tökén-✗')).toBe(false);
  });
});

describe('assertLoopbackHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('accepts loopback host %s', (host) => {
    expect(() => assertLoopbackHost(host)).not.toThrow();
  });

  it('rejects the all-interfaces bind', () => {
    // Names the wildcard bind only to assert the guard REJECTS it (see marker below).
    expect(() => assertLoopbackHost('0.0.0.0')).toThrow(/non-loopback/); // spawner-gate-allow
  });

  it('rejects the IPv6 all-interfaces bind', () => {
    expect(() => assertLoopbackHost('::')).toThrow(/non-loopback/);
  });

  it('rejects LAN addresses', () => {
    expect(() => assertLoopbackHost('192.168.1.10')).toThrow(/non-loopback/);
  });

  it('rejects hostnames', () => {
    expect(() => assertLoopbackHost('example.com')).toThrow(/non-loopback/);
  });

  it('rejects the empty string', () => {
    expect(() => assertLoopbackHost('')).toThrow(/non-loopback/);
  });
});

describe('redactTokenInUrl', () => {
  const SECRET = 'super-secret-token-value';

  it('replaces the token value with REDACTED', () => {
    const out = redactTokenInUrl(`/api/stream?token=${SECRET}`);
    expect(out).toBe('/api/stream?token=REDACTED');
    expect(out).not.toContain(SECRET);
  });

  it('preserves other query parameters and their order', () => {
    const out = redactTokenInUrl(`/api/stream?lastEventId=42&token=${SECRET}&foo=bar`);
    expect(out).toBe('/api/stream?lastEventId=42&token=REDACTED&foo=bar');
    expect(out).not.toContain(SECRET);
  });

  it('returns a URL without a query string unchanged', () => {
    expect(redactTokenInUrl('/api/health')).toBe('/api/health');
  });

  it('returns a query URL that has no token unchanged', () => {
    expect(redactTokenInUrl('/api/health?foo=bar')).toBe('/api/health?foo=bar');
  });

  it('redacts an empty token value too', () => {
    expect(redactTokenInUrl('/api/stream?token=')).toBe('/api/stream?token=REDACTED');
  });

  it('keeps percent-encoded bytes of other params verbatim (no + re-encoding)', () => {
    expect(redactTokenInUrl(`/api/stream?q=a%20b&token=${SECRET}`)).toBe(
      '/api/stream?q=a%20b&token=REDACTED',
    );
  });

  it('keeps a value-less flag param verbatim (no appended =)', () => {
    expect(redactTokenInUrl(`/api/stream?flag&token=${SECRET}`)).toBe(
      '/api/stream?flag&token=REDACTED',
    );
  });

  it('keeps literal + signs, empty segments and a fragment verbatim', () => {
    expect(redactTokenInUrl(`/api/stream?q=a+b&&token=${SECRET}#frag?token=x`)).toBe(
      '/api/stream?q=a+b&&token=REDACTED#frag?token=x',
    );
  });

  it('redacts every token occurrence', () => {
    const out = redactTokenInUrl(`/api/stream?token=${SECRET}&a=1&token=${SECRET}2`);
    expect(out).toBe('/api/stream?token=REDACTED&a=1&token=REDACTED');
    expect(out).not.toContain(SECRET);
  });

  it('redacts a token whose key name is percent-encoded, keeping the raw key', () => {
    const out = redactTokenInUrl(`/api/stream?%74oken=${SECRET}&%74%6F%6b%65%6E=${SECRET}`);
    expect(out).toBe('/api/stream?%74oken=REDACTED&%74%6F%6b%65%6E=REDACTED');
    expect(out).not.toContain(SECRET);
  });

  it('redacts a bare token key with no = sign', () => {
    expect(redactTokenInUrl('/api/stream?a=1&token')).toBe('/api/stream?a=1&token=REDACTED');
  });

  it('does not throw on malformed percent-escapes and still redacts the token', () => {
    const out = redactTokenInUrl(`/api/stream?bad%ZZ=%E0%A4%A&%=1&token=${SECRET}`);
    expect(out).toBe('/api/stream?bad%ZZ=%E0%A4%A&%=1&token=REDACTED');
    expect(out).not.toContain(SECRET);
  });

  it('does not treat look-alike keys as the token', () => {
    const url = '/api/stream?to+ken=a&Token=b&tokens=c&%74oken%=d&x=token';
    expect(redactTokenInUrl(url)).toBe(url);
  });
});

describe('isAllowedOrigin', () => {
  const PORT = 4319;

  it('allows a missing Origin header (non-browser client; token still gates)', () => {
    expect(isAllowedOrigin(undefined, PORT)).toBe(true);
  });

  it('allows the loopback IP origin on the exact port', () => {
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT)).toBe(true);
  });

  it('allows the localhost origin on the exact port', () => {
    expect(isAllowedOrigin(`http://localhost:${PORT}`, PORT)).toBe(true);
  });

  it('rejects a mismatched port', () => {
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
  });

  it('rejects https scheme (server is plain http on loopback)', () => {
    expect(isAllowedOrigin(`https://127.0.0.1:${PORT}`, PORT)).toBe(false);
  });

  it('rejects foreign origins', () => {
    expect(isAllowedOrigin('http://evil.example.com', PORT)).toBe(false);
  });

  it('rejects the literal "null" origin (sandboxed iframe / file://)', () => {
    expect(isAllowedOrigin('null', PORT)).toBe(false);
  });

  it('rejects the empty string origin', () => {
    expect(isAllowedOrigin('', PORT)).toBe(false);
  });
});
