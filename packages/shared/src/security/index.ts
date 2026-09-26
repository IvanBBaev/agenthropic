/**
 * WP-F7 - security primitives. These encode the project's non-negotiable
 * invariants; WP-U0 (server bootstrap) wires them and the contract tests
 * only go green through them.
 *
 * - Auth token is MANDATORY: the server refuses to start without it.
 * - Token comparison is timing-safe.
 * - Bind host is loopback only - never all interfaces.
 * - SSE stream is same-origin only (loopback origins), no wildcard CORS.
 *
 * Secrets are never included in error messages, logs, or persisted data.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_TOKEN_LENGTH = 16;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Read the mandatory dashboard auth token from the environment. Throws when
 * `DASHBOARD_TOKEN` is unset, empty, or shorter than {@link MIN_TOKEN_LENGTH}
 * characters - a token that silently no-ops when unset is the exact
 * field-wide mistake this project walks away from.
 */
export function requireDashboardToken(env: Record<string, string | undefined>): string {
  const token = env['DASHBOARD_TOKEN'];
  if (token === undefined || token.length === 0) {
    throw new Error(
      'DASHBOARD_TOKEN is not set. The dashboard refuses to start without an auth token: ' +
        `set DASHBOARD_TOKEN to a secret of at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `DASHBOARD_TOKEN is too short (${token.length} characters). ` +
        `It must be at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }
  return token;
}

/**
 * Timing-safe token comparison. Both inputs are hashed to fixed-length
 * SHA-256 digests before `timingSafeEqual`, so differing input lengths do
 * not leak through timing or through `timingSafeEqual`'s length precondition.
 */
export function timingSafeTokenEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Assert that a bind host is loopback. There is intentionally no
 * configuration path that widens this - accepting anything else here would
 * reopen the exposure this project exists to close.
 */
export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to bind to non-loopback host "${host}". ` +
        "Allowed hosts: '127.0.0.1', '::1', 'localhost'. Use an SSH/Tailscale tunnel for remote access.",
    );
  }
}

const TOKEN_PARAM = 'token';

/**
 * Decode a raw query key the way `URLSearchParams` would for the purpose of
 * comparing it to an ASCII name: `+` becomes a space and each well-formed
 * `%XX` escape becomes its byte. It never throws - a malformed escape is left
 * as literal text (as `URLSearchParams` does), so it can never decode to the
 * name. Non-ASCII bytes map to non-ASCII characters, which likewise cannot
 * match an ASCII name, so byte-wise decoding is exact for this comparison.
 */
function decodeQueryKeyForMatch(rawKey: string): string {
  return rawKey
    .replace(/\+/g, ' ')
    .replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Redact the `token` query parameter in a request URL so the SSE stream's
 * `?token=<secret>` never lands in a request log. Redaction is done in place:
 * the query is split on `&` and only a segment whose decoded key is exactly
 * `token` (including a percent-encoded key name such as `%74oken`) has its
 * value replaced with `REDACTED`, keeping its raw key. Every occurrence is
 * redacted. Every other byte - the path, the other segments and any fragment -
 * is preserved verbatim. A URL with no `token` param is returned unchanged.
 * This is the one place a token can appear in a URL (EventSource cannot set an
 * Authorization header), so it is the one place logging must scrub.
 */
export function redactTokenInUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }
  const fragmentStart = url.indexOf('#', queryStart);
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  let redacted = false;
  const segments = url
    .slice(queryStart + 1, queryEnd)
    .split('&')
    .map((segment) => {
      const equalsAt = segment.indexOf('=');
      const rawKey = equalsAt === -1 ? segment : segment.slice(0, equalsAt);
      if (decodeQueryKeyForMatch(rawKey) !== TOKEN_PARAM) {
        return segment;
      }
      redacted = true;
      return `${rawKey}=REDACTED`;
    });
  if (!redacted) {
    return url;
  }
  return `${url.slice(0, queryStart + 1)}${segments.join('&')}${url.slice(queryEnd)}`;
}

/**
 * Same-origin check for the SSE stream. `undefined` means no Origin header -
 * a non-browser client (curl, EventSource polyfill in Node) - and is allowed
 * because the auth token still gates the request. A present Origin must be
 * exactly the loopback origin of this server; anything else is rejected (403
 * at the caller). No wildcard CORS, ever.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) {
    return true;
  }
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
