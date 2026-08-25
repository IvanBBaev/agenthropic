/**
 * Same-origin API helpers (WP-U5, extended for WP-U6..U9). The SPA talks
 * ONLY to its own origin; the token travels as `Authorization: Bearer` on
 * every fetch (the `?token=` query form is reserved for the EventSource URL -
 * see sse.ts). The token is never logged and never appears in any error
 * message.
 */
import type {
  AggregateDelegationSavingsDto,
  CostAnalysisDto,
  CostSummaryDto,
  GlobalDagDto,
  SessionListDto,
  SessionTreeDto,
} from './dto';

export type HealthResult =
  | { readonly kind: 'ok'; readonly schemaVersion: number }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unreachable'; readonly message: string };

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
      message: error instanceof Error ? error.message : 'network error',
    };
  }
  if (response.status === 401) {
    return { kind: 'unauthorized' };
  }
  if (!response.ok) {
    return { kind: 'unreachable', message: `health check failed (HTTP ${response.status})` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'unreachable', message: 'malformed health response' };
  }
  if (typeof body !== 'object' || body === null) {
    return { kind: 'unreachable', message: 'malformed health response' };
  }
  const schemaVersion = (body as Record<string, unknown>)['schemaVersion'];
  if (typeof schemaVersion !== 'number') {
    return { kind: 'unreachable', message: 'malformed health response' };
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
 */
export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'error'; readonly message: string; readonly status: number | null };

/**
 * One GET against the same origin. 401 -> `unauthorized`; other non-2xx ->
 * `error` carrying the server's uniform `{error}` message when parseable
 * (never the token); network/parse failures -> `error`. Callers pass an
 * AbortSignal and check `signal.aborted` before applying the result.
 */
async function getJson<T>(
  path: string,
  token: string,
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
      message: error instanceof Error ? error.message : 'network error',
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
      if (typeof serverError === 'string') message = serverError;
    } catch {
      // Keep the status-only message; the body is not required to be JSON.
    }
    return { kind: 'error', message, status: response.status };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'error', message: 'malformed response body', status: response.status };
  }
  if (typeof body !== 'object' || body === null) {
    return { kind: 'error', message: 'malformed response body', status: response.status };
  }
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
  return getJson<SessionListDto>(`/api/sessions${query}`, token, signal);
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
  return getJson<GlobalDagDto>(`/api/dag/global${query}`, token, signal);
}

/** GET /api/cost/summary - totals, per-model, per-day and top-N sessions. */
export function fetchCostSummary(
  token: string,
  topN?: number,
  signal?: AbortSignal,
): Promise<ApiResult<CostSummaryDto>> {
  const query = topN !== undefined ? `?topN=${String(topN)}` : '';
  return getJson<CostSummaryDto>(`/api/cost/summary${query}`, token, signal);
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
  return getJson<AggregateDelegationSavingsDto>('/api/cost/delegation-savings', token, signal);
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
    signal,
  );
}
