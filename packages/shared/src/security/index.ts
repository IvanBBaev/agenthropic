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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MIN_TOKEN_LENGTH = 16;

/**
 * SEC-6: the fewest distinct characters a token may use. A random token of
 * the minimum length clears it by a wide margin (16 random hex digits fall
 * below 6 distinct values about 3 times in 100 000), while `aaaa...`,
 * `abababab...` and other hand-typed filler does not.
 */
export const MIN_TOKEN_DISTINCT_CHARACTERS = 6;

/** How every token error tells the operator to make a good one. */
const GENERATE_HINT =
  'Generate one with `pnpm --filter @agenthropic/server token:generate` or `openssl rand -hex 32`.';

/** Random bytes behind a generated token: 256 bits, the strength of `openssl rand -hex 32`. */
const GENERATED_TOKEN_BYTES = 32;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Read the mandatory dashboard auth token from the environment. Throws when
 * `DASHBOARD_TOKEN` is unset, empty, shorter than {@link MIN_TOKEN_LENGTH}
 * characters, padded with whitespace / carrying a control character (a
 * value no HTTP header could ever match), or hand-typed filler (SEC-6: one
 * repeated unit, or fewer than {@link MIN_TOKEN_DISTINCT_CHARACTERS} distinct
 * characters) - a token that silently no-ops when
 * unset is the exact field-wide mistake this project walks away from.
 */
export function requireDashboardToken(env: Record<string, string | undefined>): string {
  const token = env['DASHBOARD_TOKEN'];
  if (token === undefined || token.length === 0) {
    throw new Error(
      'DASHBOARD_TOKEN is not set. The dashboard refuses to start without an auth token: ' +
        `set DASHBOARD_TOKEN to a secret of at least ${MIN_TOKEN_LENGTH} characters. ` +
        GENERATE_HINT,
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `DASHBOARD_TOKEN is too short (${token.length} characters). ` +
        `It must be at least ${MIN_TOKEN_LENGTH} characters. ${GENERATE_HINT}`,
    );
  }
  // SEC-1: a padded or control-bearing value can never arrive in an HTTP
  // header byte-for-byte (clients trim, Node refuses the bytes), so the
  // server would start and then refuse every request. Fail at startup
  // instead - and, as above, never echo the value.
  if (/^\s|\s$/.test(token) || hasControlCharacter(token)) {
    throw new Error(
      'DASHBOARD_TOKEN contains leading/trailing whitespace or a control character. ' +
        'No HTTP header can carry such a value, so no request could ever authenticate: ' +
        'set a plain token without padding.',
    );
  }
  // SEC-6: length alone admits `passwordpassword`. Refuse a token that is one
  // short unit repeated, or that uses too few distinct characters - shapes a
  // generator never produces and a guesser tries first.
  if (isRepeatedUnit(token) || new Set(token).size < MIN_TOKEN_DISTINCT_CHARACTERS) {
    throw new Error(
      'DASHBOARD_TOKEN looks hand-typed: it repeats one short unit or uses fewer than ' +
        `${MIN_TOKEN_DISTINCT_CHARACTERS} distinct characters. ${GENERATE_HINT}`,
    );
  }
  return token;
}

/**
 * SEC-6: a fresh dashboard token - 32 random bytes as base64url (43
 * characters, no padding, header-safe). Nothing is logged or stored here;
 * the caller decides where the secret goes.
 */
export function generateDashboardToken(): string {
  return randomBytes(GENERATED_TOKEN_BYTES).toString('base64url');
}

/** `true` when `value` is a shorter unit repeated at least twice (`abcabc`). */
function isRepeatedUnit(value: string): boolean {
  for (let unit = 1; unit <= value.length / 2; unit += 1) {
    if (value.length % unit === 0 && value.slice(0, unit).repeat(value.length / unit) === value) {
      return true;
    }
  }
  return false;
}

/** `true` when any UTF-16 unit is a C0 control (U+0000-U+001F) or DEL (U+007F). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
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
 * exactly the loopback origin of this server, or exactly one of the
 * operator's `allowedOrigins` (C-2: a tunnel or `tailscale serve` front end
 * whose browser-visible origin is not the socket's loopback port); anything
 * else is rejected (403 at the caller). The list is validated at startup and
 * matched verbatim - no wildcard CORS, no prefix or case leniency, ever.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  port: number,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (origin === undefined) {
    return true;
  }
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    allowedOrigins.includes(origin)
  );
}

/** Hostnames that always name this server: it binds 127.0.0.1 and nothing else. */
const LOOPBACK_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost'];

/**
 * `host[:port]` as a browser sends it in a Host header: a registered name or
 * IPv4 literal, or a bracketed IPv6 literal, then an optional numeric port.
 * Anything else (userinfo, a path, whitespace, an empty name) fails to match.
 */
const HOST_HEADER = /^([^\s:/@[\]]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * Host-header allowlist (SEC-4, DNS rebinding). A rebinding page reaches this
 * loopback server under ITS OWN name - `evil.example` re-pointed at 127.0.0.1 -
 * and the browser sends that name as Host, so refusing every name that is not
 * one of ours closes rebinding for the whole surface, static SPA included.
 *
 * Only the HOSTNAME is compared, never the port: the port is not what a
 * rebinding attacker controls, and an SSH tunnel legitimately arrives as
 * `localhost:<any local port>`. Allowed: `127.0.0.1`, `localhost`, and the
 * hostname of each operator `allowedOrigins` entry (C-2: the `tailscale serve`
 * or reverse-proxy name the browser actually uses). Matching is
 * case-insensitive, as DNS names are; a missing or malformed Host is refused.
 */
export function isAllowedHost(
  host: string | undefined,
  allowedOrigins: readonly string[] = [],
): boolean {
  const match = host === undefined ? null : HOST_HEADER.exec(host);
  if (match === null) {
    return false;
  }
  const hostname = (match[1] as string).toLowerCase();
  return (
    LOOPBACK_HOSTNAMES.includes(hostname) ||
    allowedOrigins.some((origin) => new URL(origin).hostname.toLowerCase() === hostname)
  );
}
