/**
 * Same-origin API helpers (WP-U5, extended for WP-U6..U9). The SPA talks
 * ONLY to its own origin; the token travels as `Authorization: Bearer` on
 * every fetch (the `?token=` query form is reserved for the EventSource URL -
 * see sse.ts). The token is never logged and never appears in any error
 * message.
 *
 * AMENDED 2026-09-03 (AU-1): that last sentence held only by inspection of the
 * two strings this module copies out of somewhere else - `error.message` from a
 * rejected fetch, and the server's `{error}` body. Neither is written here, and
 * both are rendered into the DOM by the views, so a rejection that quotes the
 * request line (a wrapped fetch, a service worker, a proxy) or a server that
 * echoes the credential it just refused would have published the token into the
 * page. Every message leaving this module now passes through `redact`, so the
 * promise holds by construction rather than by the current wording of the two
 * producers.
 *
 * AMENDED 2026-09-03 (CA-8/AU-10): every read used to end in `body as T`, an
 * assertion about a shape nobody had checked. The views dereference containers
 * and print leaves straight off that cast, so a body that parsed as JSON but did
 * not hold the promised shape became either a crashed panel or - quieter and
 * worse - a withdrawn honesty disclosure, because every one of them is gated on
 * `x > 0` and `undefined > 0` is `false`. Each fetcher now names a predicate
 * from `dto-guards.ts` and a body that fails it is refused whole. See that
 * module for why the checks are hand-written (no runtime dependency on
 * `@agenthropic/shared`, hence no TypeBox in the browser bundle) and for exactly
 * where the strictness line sits.
 */
import type {
  AggregateDelegationSavingsDto,
  CostAnalysisDto,
  CostSummaryDto,
  GlobalDagDto,
  SessionListDto,
  SessionTreeDto,
} from './dto';
import {
  isAggregateSavings,
  isCostAnalysis,
  isCostSummary,
  isGlobalDag,
  isSessionList,
  isSessionTree,
} from './dto-guards';

/** Stands in for the token wherever a message would otherwise have quoted it. */
const REDACTED = '[redacted]';

/**
 * Remove the presented token from a string that is about to become a
 * user-visible message (AU-1). Split/join rather than a pattern: the token is
 * arbitrary input, so a pattern would need escaping, and escaping is one more
 * thing to get wrong on the one path a secret must not travel.
 *
 * An empty token would match at every position, so it passes through untouched;
 * shredding a message into `[redacted]` between every character helps nobody.
 */
function redact(message: string, token: string): string {
  return token === '' ? message : message.split(token).join(REDACTED);
}

/**
 * Why an unreachable health probe is not one fact (AU-2).
 *
 * - `no-response`: nothing answered. The server is down, or the browser is
 *   offline. The token was not judged.
 * - `server-error`: something answered with a non-401 status. The server IS
 *   running - telling the user it is unreachable sends them to restart a live
 *   process - and the token was still not judged.
 * - `malformed`: 200 arrived and the body could not be read. Every route is
 *   auth-gated, so a 200 is proof the token was ACCEPTED; the disagreement is
 *   between this build and the server's payload shape, not about the token.
 */
export type HealthUnreachableReason = 'no-response' | 'server-error' | 'malformed';

export type HealthResult =
  | { readonly kind: 'ok'; readonly schemaVersion: number }
  | { readonly kind: 'unauthorized' }
  | {
      readonly kind: 'unreachable';
      readonly message: string;
      readonly reason: HealthUnreachableReason;
      /** The HTTP status when a response existed at all, else `null`. */
      readonly status: number | null;
    };

/**
 * Validate a token by probing GET /api/health.
 *
 * - 200 with a well-formed body -> `ok` (+ the integer schemaVersion);
 * - 401 -> `unauthorized` (bad token);
 * - any network failure, non-401 error status, or malformed body ->
 *   `unreachable` with a token-free message.
 */
export async function checkHealth(token: string, signal?: AbortSignal): Promise<HealthResult> {
  let response: Response;
  try {
    response = await fetch('/api/health', {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal ?? null,
    });
  } catch (error) {
    return {
      kind: 'unreachable',
      message: redact(error instanceof Error ? error.message : 'network error', token),
      reason: 'no-response',
      status: null,
    };
  }
  if (response.status === 401) {
    return { kind: 'unauthorized' };
  }
  if (!response.ok) {
    return {
      kind: 'unreachable',
      message: `health check failed (HTTP ${response.status})`,
      reason: 'server-error',
      status: response.status,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: 'unreachable',
      message: 'malformed health response',
      reason: 'malformed',
      status: response.status,
    };
  }
  if (typeof body !== 'object' || body === null) {
    return {
      kind: 'unreachable',
      message: 'malformed health response',
      reason: 'malformed',
      status: response.status,
    };
  }
  const schemaVersion = (body as Record<string, unknown>)['schemaVersion'];
  if (typeof schemaVersion !== 'number') {
    return {
      kind: 'unreachable',
      message: 'malformed health response',
      reason: 'malformed',
      status: response.status,
    };
  }
  return { kind: 'ok', schemaVersion };
}

/**
 * Result union shared by every data fetch (WP-U6..U9). `unauthorized` is a
 * distinct arm because the shell reacts to it by dropping the token and
 * returning to the entry screen; every other failure is a view-local,
 * token-free error message.
 *
 * The `error` arm carries the HTTP `status` alongside the message because the
 * failures are NOT interchangeable and must not be collapsed into one "could
 * not load" sentence: 503 means the feature is switched off on this server,
 * 404 means the corpus has no such session, 422 means the data itself cannot
 * be priced or parsed, and 500 is a deliberately detail-free server fault.
 * `status` is `null` only when no HTTP response existed at all (network or
 * abort failure), which is again a different fact from any of the above.
 *
 * AMENDED 2026-09-03 (CA-8/AU-10): `reason` is new and OPTIONAL, added the same
 * additive way `HealthResult` gained one in AU-2 and for the same reason - an
 * arm was carrying two unrelated facts. Optional rather than required so that
 * nothing which builds an `error` result today has to change; a caller that only
 * renders `message` keeps working untouched.
 */
export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthorized' }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly status: number | null;
      readonly reason?: ApiErrorReason;
    };

/**
 * Why a data fetch failed, where the status alone cannot say.
 *
 * `'malformed-body'` marks the THIRD kind of failure, the one that has no HTTP
 * status of its own: the request was made, the transport worked, the auth gate
 * passed (every route is gated, so a 2xx is proof the token was accepted) - and
 * the payload still cannot be trusted. It is neither "the server is down" nor
 * "your token is wrong", and a UI that renders it as either sends the reader to
 * fix a thing that is not broken. Absent on every other failure, where `status`
 * already carries the distinction.
 */
export type ApiErrorReason = 'malformed-body';

/**
 * What the reader is told when a body arrives intact and unreadable.
 *
 * Views render this as `Could not load <thing>: <message>` (and
 * `SessionCostAnalysis` renders it bare), so it has to complete that sentence
 * while correcting the two wrong conclusions it invites. It states the two facts
 * the reader would otherwise guess away - the server answered, the token was
 * accepted - then says plainly that nothing is shown BECAUSE the alternative was
 * a number this page cannot stand behind.
 */
export const UNREADABLE_BODY_MESSAGE =
  'the server answered and the token was accepted, but this page cannot read the response body - ' +
  'a required field is missing, or a figure is not a number. Nothing is shown rather than a wrong ' +
  'number; this page and the server are probably different versions.';

/**
 * One GET against the same origin. 401 -> `unauthorized`; other non-2xx ->
 * `error` carrying the server's uniform `{error}` message when parseable
 * (never the token); network/parse failures -> `error`. Callers pass an
 * AbortSignal and check `signal.aborted` before applying the result.
 *
 * AMENDED 2026-09-03 (AU-1): "never the token" is now enforced by `redact` on
 * both strings that arrive from outside this function, rather than assumed of
 * the server and of whatever rejected the fetch.
 *
 * AMENDED 2026-09-03 (CA-8/AU-10): `isValid` is new and mandatory - every caller
 * names the predicate that certifies its own body, so no route can be added that
 * silently reverts to a bare cast. `T` is still asserted at the end, but the
 * assertion is now preceded by a check of exactly the fields the views
 * dereference or print; it is NOT a proof of the full contract, and
 * `dto-guards.ts` documents which parts are deliberately left unchecked.
 */
async function getJson<T>(
  path: string,
  token: string,
  isValid: (body: Record<string, unknown>) => boolean,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal ?? null,
    });
  } catch (error) {
    return {
      kind: 'error',
      message: redact(error instanceof Error ? error.message : 'network error', token),
      status: null,
    };
  }
  if (response.status === 401) {
    return { kind: 'unauthorized' };
  }
  if (!response.ok) {
    let message = `request failed (HTTP ${response.status})`;
    try {
      const body: unknown = await response.json();
      const serverError = (body as Record<string, unknown> | null)?.['error'];
      if (typeof serverError === 'string') message = redact(serverError, token);
    } catch {
      // Keep the status-only message; the body is not required to be JSON.
    }
    return { kind: 'error', message, status: response.status };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: 'error',
      message: UNREADABLE_BODY_MESSAGE,
      // The transport succeeded; it is the payload that is wrong, so the status
      // stays as it arrived rather than being laundered into a fake 5xx.
      status: response.status,
      reason: 'malformed-body',
    };
  }
  if (typeof body !== 'object' || body === null) {
    return {
      kind: 'error',
      message: UNREADABLE_BODY_MESSAGE,
      status: response.status,
      reason: 'malformed-body',
    };
  }
  // An array reaches here (`typeof [] === 'object'`) and is refused a line below
  // by the predicate, which finds none of its keys - no separate arm needed.
  if (!isValid(body as Record<string, unknown>)) {
    return {
      kind: 'error',
      message: UNREADABLE_BODY_MESSAGE,
      status: response.status,
      reason: 'malformed-body',
    };
  }
  // The cast is now the LAST step rather than the only one: `isValid` has just
  // certified every container the views dereference and every leaf they print.
  return { kind: 'ok', data: body as T };
}

/** GET /api/sessions - the summaries backing the live board and session list. */
export function fetchSessions(
  token: string,
  options: { readonly limit?: number; readonly offset?: number } = {},
  signal?: AbortSignal,
): Promise<ApiResult<SessionListDto>> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return getJson<SessionListDto>(`/api/sessions${query}`, token, isSessionList, signal);
}

/** GET /api/sessions/:id/tree - the PERSISTED agent tree for one session. */
export function fetchSessionTree(
  token: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ApiResult<SessionTreeDto>> {
  return getJson<SessionTreeDto>(
    `/api/sessions/${encodeURIComponent(sessionId)}/tree`,
    token,
    isSessionTree,
    signal,
  );
}

/** GET /api/dag/global - the cross-session orchestration DAG (node-limited). */
export function fetchGlobalDag(
  token: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<ApiResult<GlobalDagDto>> {
  const query = limit !== undefined ? `?limit=${String(limit)}` : '';
  return getJson<GlobalDagDto>(`/api/dag/global${query}`, token, isGlobalDag, signal);
}

/** GET /api/cost/summary - totals, per-model, per-day and top-N sessions. */
export function fetchCostSummary(
  token: string,
  topN?: number,
  signal?: AbortSignal,
): Promise<ApiResult<CostSummaryDto>> {
  const query = topN !== undefined ? `?topN=${String(topN)}` : '';
  return getJson<CostSummaryDto>(`/api/cost/summary${query}`, token, isCostSummary, signal);
}

/**
 * GET /api/cost/delegation-savings (M-9) - the corpus-wide delegation-savings
 * estimate. Database-backed like the summary above, so its failure surface is
 * the narrow one (400/500); an unpriceable session does NOT fail the request,
 * it is reported inside the payload's scope counters.
 */
export function fetchAggregateSavings(
  token: string,
  signal?: AbortSignal,
): Promise<ApiResult<AggregateDelegationSavingsDto>> {
  return getJson<AggregateDelegationSavingsDto>(
    '/api/cost/delegation-savings',
    token,
    isAggregateSavings,
    signal,
  );
}

/**
 * GET /api/sessions/:id/cost-analysis (WP-C4 + WP-C5) - compaction repricing
 * and the delegation-savings counterfactual for ONE session.
 *
 * This route reads the raw transcripts, so it has a wider failure surface than
 * the database-backed reads: 503 when the server has no corpus configured, 404
 * when the corpus holds no transcript for the id, 422 when the transcript
 * cannot be parsed or a model cannot be priced, 500 (detail-free) otherwise.
 * The caller must tell those apart - see `ApiResult`'s `status`.
 */
export function fetchCostAnalysis(
  token: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ApiResult<CostAnalysisDto>> {
  return getJson<CostAnalysisDto>(
    `/api/sessions/${encodeURIComponent(sessionId)}/cost-analysis`,
    token,
    isCostAnalysis,
    signal,
  );
}
