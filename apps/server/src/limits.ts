/**
 * SEC-7 (2026-11-19) - the input bounds the HTTP surface enforces, in one place
 * so they are visible, documented and tested rather than inherited.
 *
 * Every caller is authenticated, so none of these defends a trust boundary on
 * its own; they keep one hostile or buggy local client from turning a request
 * into a stack overflow (a generic 500) or an oversized indexed column.
 */

/**
 * Fastify's `bodyLimit`, set explicitly. 1 MiB is the framework default; a
 * hook body is a few KiB, and the largest real ones (a long `tool_response`)
 * stay well under it. Past the limit Fastify answers 413 before any handler.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * The longest id-like string the server takes from a client: route params
 * (`/api/sessions/:id`), the `topTierModel` query, and the session / agent ids
 * lifted out of a hook payload. Real values are UUIDs (36 characters), short
 * agent hex ids and model names well under 64, so 256 never refuses a real one.
 * It is also Fastify's `maxParamLength`: the router answers a longer path
 * parameter with 414 before the route schema runs.
 */
export const MAX_ID_LENGTH = 256;

/**
 * The deepest container nesting a hook payload may have: at most this many
 * arrays/objects inside one another. Redaction and canonicalisation recurse
 * once per level, and a 1 MiB body can nest about 500,000 levels - enough to
 * overflow the stack, which surfaced as a generic 500. Real hook payloads nest
 * a handful of levels; 64 leaves ample room for deep tool output.
 */
export const MAX_PAYLOAD_DEPTH = 64;

/**
 * Thrown when a value nests deeper than {@link MAX_PAYLOAD_DEPTH}. It carries
 * `statusCode = 400`, so the root error handler answers with this message in
 * the uniform `{ error }` shape instead of a 500.
 */
export class PayloadTooDeepError extends Error {
  readonly statusCode = 400;

  constructor() {
    super(`Hook payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels.`);
    this.name = 'PayloadTooDeepError';
  }
}

/**
 * Guard for a recursive walk: `depth` is the number of containers that
 * enclose the one about to be entered (0 for a top-level array or object).
 */
export function assertDepthWithinLimit(depth: number): void {
  if (depth >= MAX_PAYLOAD_DEPTH) {
    throw new PayloadTooDeepError();
  }
}
