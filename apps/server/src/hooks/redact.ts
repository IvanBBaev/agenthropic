/**
 * WP-IN14 - redaction at the ingest boundary.
 *
 * Hook payloads are scrubbed BEFORE persistence (and before the idempotency
 * key is computed, so a redelivered event redacts identically and still
 * dedupes). Two independent rules:
 *
 *  1. Key-based: any object field whose (normalized) name matches a secret
 *     pattern - token, authorization, api_key, secret, password, bearer,
 *     credential, private_key, access_key, cookie... - is replaced with
 *     `[REDACTED]`, whatever its value type. An explicit allowlist keeps
 *     token-COUNT fields (`input_tokens`, `output_tokens`, ...) intact:
 *     token counts are observability data, not credentials.
 *  2. Value-based: string values are scanned for obvious credential shapes
 *     (sk-/ghp_/xox/AKIA-style API keys, JWTs, `Bearer <...>` fragments, PEM
 *     private-key blocks) and each match is masked in place.
 *  3. Assignment-based (HK-1, 2026-10-10): inside string values, a shell / env /
 *     config assignment `NAME=value` whose NAME rule 1 would call secret-bearing
 *     keeps its name and loses its value (`export DASHBOARD_TOKEN=[REDACTED]`).
 *     The value of such an assignment is a random string no shape in rule 2
 *     recognises, and `export X=...` in a prompt or a Bash tool input is the
 *     commonest way a credential reaches a hook payload at all.
 *
 * POLICY STATUS: this implements the RECOMMENDED resolution of OPEN-3
 * (redaction from Phase 1, at the ingest boundary - see
 * docs/analysis/open-decisions.md) as the default. WP-D10 is closed (retention
 * values signed as D3, 2026-09-08), but the OPEN-3 field list below is still
 * PENDING Ivan's ratification and may be tightened or extended. Nothing here relaxes on sign-off - it can only grow.
 */

/** Replacement marker for masked keys and matched value fragments. */
export const REDACTED = '[REDACTED]';

/**
 * Normalized-name fragments that mark a field as secret-bearing. Matching is
 * on the lowercased key with `-`, `_` and spaces stripped, so `api_key`,
 * `Api-Key` and `apiKey` all normalize to `apikey`.
 */
const SECRET_KEY_FRAGMENTS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  // SEC-5 (2026-10-10): the key-file idiom - `passphrase`, `ssh_pass_phrase`.
  'passphrase',
  'credential',
  'apikey',
  'authorization',
  'bearer',
  'privatekey',
  'accesskey',
  'sessionkey',
  'cookie',
];

/**
 * Exact normalized names that CONTAIN a secret fragment but are known-benign
 * token-count fields (ground-truth usage numbers, never credentials).
 */
const TOKEN_COUNT_ALLOWLIST: ReadonlySet<string> = new Set([
  'tokens',
  'inputtokens',
  'outputtokens',
  'cachereadinputtokens',
  'cachecreationinputtokens',
  'totaltokens',
  'tokencount',
  'maxtokens',
  'maxoutputtokens',
  'tokenusage',
]);

/**
 * Obvious credential shapes masked inside string values, each with its
 * replacement (`$1` re-emits a context prefix the match had to consume - see
 * the JWT shape).
 *
 * AMENDED 2026-10-31 (R3 / SEC-1): every pattern here and {@link ENV_ASSIGNMENT}
 * must run in time LINEAR in the input. This is the ingest boundary: the route
 * scans every string of an attacker-shapeable hook body (up to Fastify's 1 MiB
 * default `bodyLimit`) synchronously on the event loop, so one superlinear
 * pattern is a single-request denial of service. Two were quadratic: the JWT
 * shape and HK-1's assignment pattern both open with `\b` + a character class
 * that a long run of class characters satisfies at almost every position, and
 * each attempt rescanned the run to its end before failing (`'a.'` x 40k chars
 * took 35 s; `'eyJ-'` x 256 KiB, minutes). Both are rewritten below to attempt
 * at most once per run, with byte-identical output - a differential test pins
 * the rewrites to the original patterns, and a time-budget test runs every
 * pattern against 256 KiB adversarial inputs. A per-string length cap (the SEC-1
 * fallback) is deliberately NOT applied: once every pattern is linear it buys
 * nothing, and cutting a string would break the idempotency the dedupe key
 * relies on and drop evidence from the stored payload.
 */
const CREDENTIAL_SHAPES: readonly (readonly [RegExp, string])[] = [
  // Anthropic / OpenAI style secret keys (sk-ant-..., sk-proj-..., sk-...).
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // GitHub tokens (classic and fine-grained).
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // Slack tokens.
  [/\bxox[a-z]-[A-Za-z0-9-]{8,}/g, REDACTED],
  // AWS access key ids.
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // JWTs (three base64url segments, first decoding to a {"alg"... header).
  // Semantically `\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, made
  // linear (SEC-1): the lookbehind admits only the START of a `[A-Za-z0-9_-]`
  // run; a lazy lookahead captures the run's prefix up to its leftmost
  // `\beyJ` (the start the original pattern would pick - every later start in
  // the same run shares its first segment's end, so it fails or succeeds
  // alike); `(?=(...))\2` then takes the whole run atomically. The prefix is
  // put back by the `$1` replacement.
  [
    /(?<![A-Za-z0-9_-])(?=([A-Za-z0-9_-]*?)\beyJ[A-Za-z0-9_-])(?=([A-Za-z0-9_-]+))\2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    `$1${REDACTED}`,
  ],
  // Inline bearer credentials inside header-ish strings.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, REDACTED],
  // SEC-5 (2026-10-10): PEM private-key blocks (RSA, EC, OPENSSH, PKCS#8 ...),
  // body included. The armour lines are the signature - the base64 body
  // matches no prefix shape above. A block whose END line is missing (a
  // truncated paste) is masked to the end of the string rather than left in
  // the clear. PUBLIC KEY / CERTIFICATE blocks carry no secret and stay.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
];

/**
 * HK-1: `NAME=value` (optional spaces around `=`; the value bare, double- or
 * single-quoted). Only a single `=` counts - `==` / `===` are comparisons and a
 * name followed by `!=` never reaches the `=` - and a bare value stops at
 * whitespace, `&` or `;` so a query string or a `;`-chained shell line keeps
 * everything after the credential. Whether NAME is secret-bearing is decided
 * by {@link isSecretKeyName}, the same rule the object-key pass uses.
 *
 * AMENDED 2026-10-31 (R3 / SEC-1): semantically still
 * `\b([A-Za-z_][A-Za-z0-9_.-]*)\s*=(?!=)\s*("[^"]*"|'[^']*'|[^\s&;]+)`, which
 * was quadratic (see {@link CREDENTIAL_SHAPES}). NAME is greedy over
 * `[A-Za-z0-9_.-]`, so it always ends where its run ends, and every start in
 * one run shares the same `=` test: only the leftmost `\b[A-Za-z_]` start
 * matters. The pattern now attempts once per run (lookbehind), captures the
 * run's prefix before that start (group 1, lazy lookahead) and the whole run
 * atomically (group 2, `(?=(...))\2`); the name is the run minus the prefix,
 * and the prefix is kept verbatim in the output.
 */
const ENV_ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])(?=([A-Za-z0-9_.-]*?)\b[A-Za-z_])(?=([A-Za-z0-9_.-]+))\2\s*=(?!=)\s*(?:"[^"]*"|'[^']*'|[^\s&;]+)/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_ ]/g, '');
}

/** True when a field name marks its value as secret-bearing. */
export function isSecretKeyName(key: string): boolean {
  const normalized = normalizeKey(key);
  if (TOKEN_COUNT_ALLOWLIST.has(normalized)) {
    return false;
  }
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Mask every credential-shaped fragment inside a string value. */
export function maskCredentialShapes(text: string): string {
  let masked = text;
  for (const [shape, replacement] of CREDENTIAL_SHAPES) {
    masked = masked.replace(shape, replacement);
  }
  // Idempotent by construction: `NAME=[REDACTED]` re-masks to itself.
  return masked.replace(ENV_ASSIGNMENT, (match: string, prefix: string, run: string) => {
    const name = run.slice(prefix.length);
    return isSecretKeyName(name) ? `${prefix}${name}=${REDACTED}` : match;
  });
}

/**
 * Pure, recursive scrub of an arbitrary JSON-ish value. Never mutates the
 * input; returns a new structure with secret-named fields replaced by
 * `[REDACTED]` and credential-shaped string fragments masked.
 *
 * AMENDED 2026-09-23 (lane-Q). The claim above is now TOTAL over the own
 * enumerable keys of the input, which it was not before: fields were copied
 * with `scrubbed[key] = ...`, and `__proto__` names an ACCESSOR on
 * Object.prototype, so a `{"__proto__": {...}}` field was never copied at all.
 * It vanished from the returned structure and its object value became that
 * structure's PROTOTYPE instead. Nothing downstream disclosed the loss, and
 * every id reader on this path (`readStringField` in hooks/envelope.ts,
 * `extractLivenessIds` in db/event-store.ts) uses `record[key]`, which walks
 * the prototype chain - so the envelope's `hookName` and the `events`
 * projection's `session_id` / `agent_id` could be lifted from evidence that
 * appears nowhere in the payload persisted to `events_raw`, leaving a liveness
 * row and a status transition that no stored bytes can account for.
 *
 * Fastify's secure-json-parse proto-poisoning guard (`onProtoPoisoning:
 * 'error'`, the framework default that `buildServer` inherits rather than
 * sets) rejects such a body with 400, so the HTTP route could not reach this.
 * The function is an exported part of the hooks surface with a documented
 * totality claim, and a framework default is not a place to keep an
 * invariant - `Object.defineProperty` makes the copy mean what it says.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskCredentialShapes(value);
  }
  if (Array.isArray(value)) {
    return value.map((element) => redactSecrets(element));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      // defineProperty, not assignment: assignment would route `__proto__`
      // through Object.prototype's setter and silently lose the field.
      Object.defineProperty(scrubbed, key, {
        value: isSecretKeyName(key) ? REDACTED : redactSecrets(entry),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return scrubbed;
  }
  return value;
}
