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
 *     (sk-/ghp_/xox/AKIA-style API keys, JWTs, `Bearer <...>` fragments) and
 *     each match is masked in place.
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

/** Obvious credential shapes masked inside string values. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  // Anthropic / OpenAI style secret keys (sk-ant-..., sk-proj-..., sk-...).
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // GitHub tokens (classic and fine-grained).
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens.
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWTs (three base64url segments, first decoding to a {"alg"... header).
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Inline bearer credentials inside header-ish strings.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
];

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
  for (const shape of CREDENTIAL_SHAPES) {
    masked = masked.replace(shape, REDACTED);
  }
  return masked;
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
