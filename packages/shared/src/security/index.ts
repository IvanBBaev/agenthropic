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

/**
 * Redact the `token` query parameter in a request URL so the SSE stream's
 * `?token=<secret>` never lands in a request log. Any other query parameters
 * and the path are preserved verbatim. A URL with no `token` param is returned
 * unchanged. This is the one place a token can appear in a URL (EventSource
 * cannot set an Authorization header), so it is the one place logging must
 * scrub.
 */
export function redactTokenInUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }
  const path = url.slice(0, queryStart);
  const params = new URLSearchParams(url.slice(queryStart + 1));
  if (!params.has('token')) {
    return url;
  }
  params.set('token', 'REDACTED');
  return `${path}?${params.toString()}`;
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
