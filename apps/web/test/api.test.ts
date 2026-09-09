import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNREADABLE_BODY_MESSAGE,
  checkHealth,
  fetchAggregateSavings,
  fetchCostAnalysis,
  fetchCostSummary,
  fetchGlobalDag,
  fetchSessions,
  fetchSessionTree,
} from '../src/api';
import {
  aggregateSavings,
  agentNode,
  compactionSegment,
  costAnalysis,
  costSummary,
  globalDag,
  jsonResponse,
  sessionList,
  sessionSummary,
  sessionTree,
  textResponse,
} from './fixtures';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/**
 * AMENDED 2026-09-03 (AU-2): the `unreachable` expectations below gained
 * `reason` and `status`. Nothing about what these cases mean has changed - the
 * arm simply stopped being one word for three different facts, so an exact
 * `toEqual` now has two more fields to state. The `message` strings are
 * untouched, because callers that only render `message` (the shell's
 * connection chip) must keep working unchanged. See the AU-2 block at the end
 * of this file for why the distinction had to exist.
 */
describe('checkHealth', () => {
  it('sends the token as an Authorization: Bearer header only', async () => {
    fetchMock.mockResolvedValue(response(200, { status: 'ok', schemaVersion: 3 }));
    await checkHealth('secret');
    expect(fetchMock).toHaveBeenCalledWith('/api/health', {
      headers: { Authorization: 'Bearer secret' },
      signal: null,
    });
  });

  it('returns ok with the schemaVersion on 200', async () => {
    fetchMock.mockResolvedValue(response(200, { status: 'ok', schemaVersion: 3 }));
    expect(await checkHealth('secret')).toEqual({ kind: 'ok', schemaVersion: 3 });
  });

  it('returns unauthorized on 401', async () => {
    fetchMock.mockResolvedValue(response(401, { error: 'Unauthorized.' }));
    expect(await checkHealth('bad')).toEqual({ kind: 'unauthorized' });
  });

  it('returns unreachable on a non-401 error status', async () => {
    fetchMock.mockResolvedValue(response(500, { error: 'boom' }));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'health check failed (HTTP 500)',
      reason: 'server-error',
      status: 500,
    });
  });

  it('returns unreachable when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'Failed to fetch',
      reason: 'no-response',
      status: null,
    });
  });

  it('returns unreachable when fetch rejects with a non-Error value', async () => {
    fetchMock.mockRejectedValue('offline');
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'network error',
      reason: 'no-response',
      status: null,
    });
  });

  it('returns unreachable when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('bad json')),
    } as unknown as Response);
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'malformed health response',
      reason: 'malformed',
      status: 200,
    });
  });

  it('returns unreachable when the body is not an object', async () => {
    fetchMock.mockResolvedValue(response(200, 'ok'));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'malformed health response',
      reason: 'malformed',
      status: 200,
    });
  });

  it('returns unreachable when schemaVersion is missing or not a number', async () => {
    fetchMock.mockResolvedValue(response(200, { status: 'ok', schemaVersion: '3' }));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'malformed health response',
      reason: 'malformed',
      status: 200,
    });
  });
});

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('fetch was not called');
  return { url: call[0] as string, init: call[1] as RequestInit };
}

describe('fetchSessions', () => {
  it('sends the Bearer header and no query without options; token never in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList()));
    const result = await fetchSessions('secret-token');

    const { url, init } = lastRequest();
    expect(url).toBe('/api/sessions');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });
    expect(url.includes('secret-token')).toBe(false);
    expect(result).toEqual({ kind: 'ok', data: sessionList() });
  });

  it('builds limit and offset query params', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList()));
    await fetchSessions('secret-token', { limit: 25, offset: 50 });
    expect(lastRequest().url).toBe('/api/sessions?limit=25&offset=50');
  });

  it('maps 401 to the unauthorized arm', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized.' }));
    expect(await fetchSessions('secret-token')).toEqual({ kind: 'unauthorized' });
  });

  it('carries the server {error} message on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal server error.' }));
    expect(await fetchSessions('secret-token')).toEqual({
      kind: 'error',
      message: 'Internal server error.',
      status: 500,
    });
  });

  it('falls back to a status-only message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(textResponse(502));
    expect(await fetchSessions('secret-token')).toEqual({
      kind: 'error',
      message: 'request failed (HTTP 502)',
      status: 502,
    });
  });

  it('maps a network failure to a token-free error message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await fetchSessions('secret-token');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message.includes('secret-token')).toBe(false);
  });

  it('maps a non-Error rejection to a generic message', async () => {
    fetchMock.mockRejectedValue('offline');
    expect(await fetchSessions('secret-token')).toEqual({
      kind: 'error',
      message: 'network error',
      // No HTTP response ever existed - a different fact from any status.
      status: null,
    });
  });

  /*
    AMENDED 2026-09-03 (CA-8/AU-10). The two expectations below used to name the
    message 'malformed response body' and to carry no `reason`. Neither the
    scenario nor the verdict has changed - a body that is not an object is still
    refused, and the status is still the 200 that actually arrived. What changed
    is that the same verdict is now reached by three paths instead of one (an
    unparseable body, a non-object body, and a body that parses but fails its
    shape check), so they were unified onto one sentence a reader can act on and
    tagged with `reason: 'malformed-body'` to keep them out of the "server is
    down" and "your token is wrong" buckets. The assertions are otherwise
    untouched, and still fail on a payload that is let through.
  */
  it('rejects a malformed (non-object or unparseable) success body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, 'nope'));
    expect(await fetchSessions('secret-token')).toEqual({
      kind: 'error',
      message: UNREADABLE_BODY_MESSAGE,
      // The transport succeeded; it is the payload that is wrong, so the
      // status stays 200 rather than being laundered into a fake 5xx.
      status: 200,
      reason: 'malformed-body',
    });

    fetchMock.mockResolvedValue(textResponse(200));
    expect(await fetchSessions('secret-token')).toEqual({
      kind: 'error',
      message: UNREADABLE_BODY_MESSAGE,
      status: 200,
      reason: 'malformed-body',
    });
  });

  it('passes the abort signal through to fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList()));
    const controller = new AbortController();
    await fetchSessions('secret-token', {}, controller.signal);
    expect(lastRequest().init.signal).toBe(controller.signal);
  });
});

describe('fetchSessionTree', () => {
  it('URL-encodes the session id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionTree()));
    const result = await fetchSessionTree('secret-token', 'weird/id?x');
    expect(lastRequest().url).toBe('/api/sessions/weird%2Fid%3Fx/tree');
    expect(result.kind).toBe('ok');
  });

  it('surfaces the 404 message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Session not found.' }));
    expect(await fetchSessionTree('secret-token', 'missing')).toEqual({
      kind: 'error',
      message: 'Session not found.',
      status: 404,
    });
  });
});

describe('fetchGlobalDag', () => {
  it('appends the limit param only when given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, globalDag()));
    await fetchGlobalDag('secret-token');
    expect(lastRequest().url).toBe('/api/dag/global');

    await fetchGlobalDag('secret-token', 1000);
    expect(lastRequest().url).toBe('/api/dag/global?limit=1000');
  });
});

describe('fetchCostSummary', () => {
  it('appends the topN param only when given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, costSummary()));
    await fetchCostSummary('secret-token');
    expect(lastRequest().url).toBe('/api/cost/summary');

    await fetchCostSummary('secret-token', 5);
    expect(lastRequest().url).toBe('/api/cost/summary?topN=5');
  });
});

describe('fetchCostAnalysis', () => {
  it('URL-encodes the session id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, costAnalysis()));
    const result = await fetchCostAnalysis('secret-token', 'weird/id?x');
    expect(lastRequest().url).toBe('/api/sessions/weird%2Fid%3Fx/cost-analysis');
    expect(result.kind).toBe('ok');
  });

  it('returns the analysis body unchanged, estimate label included', async () => {
    const body = costAnalysis({
      delegationSavings: {
        actualUsd: 1.5,
        hypotheticalUsd: 4,
        savingsUsd: 2.5,
        perAgent: [],
        skippedAgentIds: ['agent-with-no-top-tier-model'],
        isEstimate: true,
      },
    });
    fetchMock.mockResolvedValue(jsonResponse(200, body));

    const result = await fetchCostAnalysis('secret-token', 'session-1');

    // The client is a transport, not an interpreter: it must not drop
    // `isEstimate` or fold `skippedAgentIds` away, because both are how the UI
    // is able to avoid presenting a counterfactual as a measured amount.
    expect(result).toEqual({ kind: 'ok', data: body });
  });

  it('keeps this route`s four failure modes distinguishable', async () => {
    // The whole reason `status` exists on the error arm. 503 (corpus not
    // configured), 404 (no such transcript), 422 (unparseable/unpriceable) and
    // 500 (detail-free fault) are different facts and the UI reacts to each
    // differently; collapsing them into one "could not load" would be the same
    // class of lie as a silent $0.
    for (const status of [503, 404, 422, 500]) {
      fetchMock.mockResolvedValue(jsonResponse(status, { error: `failed with ${status}` }));
      expect(await fetchCostAnalysis('secret-token', 'session-1')).toEqual({
        kind: 'error',
        message: `failed with ${status}`,
        status,
      });
    }
  });

  it('maps 401 to unauthorized rather than to an error', async () => {
    // The shell drops the token on this arm; an `error` would leave a dead
    // token in sessionStorage and a view stuck on a message.
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized.' }));
    expect(await fetchCostAnalysis('secret-token', 'session-1')).toEqual({
      kind: 'unauthorized',
    });
  });

  it('passes the abort signal through to fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, costAnalysis()));
    const controller = new AbortController();
    await fetchCostAnalysis('secret-token', 'session-1', controller.signal);
    expect(lastRequest().init.signal).toBe(controller.signal);
  });

  it('never puts the token in a failure message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await fetchCostAnalysis('secret-token', 'session-1');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).not.toContain('secret-token');
      expect(result.status).toBeNull();
    }
  });
});

/**
 * AU-1 (2026-09-03, red-team pass on the auth plumbing). This module's header
 * promises the token "never appears in any error message". Two of the strings
 * it returns are not written here, they are written elsewhere and copied out
 * verbatim:
 *
 *   1. `error.message` from a rejected fetch. A rejection is free to describe
 *      the request that failed, and a wrapped/instrumented fetch, a service
 *      worker, or a future proxy layer routinely puts the request line - the
 *      `Authorization` header included - into that message.
 *   2. The server's `{error}` body. The dashboard server is trusted, but the
 *      string is still attacker-influenceable input from the browser's point
 *      of view, and a server that ever echoes the presented credential (a
 *      "token X is not permitted" style message is the ordinary way to write
 *      one) has just published it.
 *
 * Both land in a `message` that views render into the DOM, so the secret ends
 * up in the page, in any screenshot of it, and in whatever the user pastes
 * into a bug report. The promise has to hold by construction, not by the
 * current wording of the two producers.
 */
const LEAK_TOKEN = 'super-secret-dashboard-token';

const LEAKY_FAILURES: ReadonlyArray<readonly [string, () => void]> = [
  [
    'fetch rejects with a message that quotes the request',
    () => {
      fetchMock.mockRejectedValue(
        new TypeError(
          `Failed to fetch /api/sessions - headers: Authorization: Bearer ${LEAK_TOKEN}`,
        ),
      );
    },
  ],
  [
    'the server echoes the presented token in its {error} body',
    () => {
      fetchMock.mockResolvedValue(
        jsonResponse(403, { error: `token ${LEAK_TOKEN} is not permitted on this route` }),
      );
    },
  ],
];

const TOKEN_CARRYING_CALLS: ReadonlyArray<readonly [string, (token: string) => Promise<unknown>]> =
  [
    ['fetchSessions', (token) => fetchSessions(token, { limit: 10, offset: 5 })],
    ['fetchSessionTree', (token) => fetchSessionTree(token, 'session-1')],
    ['fetchGlobalDag', (token) => fetchGlobalDag(token, 100)],
    ['fetchCostSummary', (token) => fetchCostSummary(token, 5)],
    ['fetchAggregateSavings', (token) => fetchAggregateSavings(token)],
    ['fetchCostAnalysis', (token) => fetchCostAnalysis(token, 'session-1')],
    ['checkHealth', (token) => checkHealth(token)],
  ];

describe('no exported fetcher can put the token into a user-visible string (AU-1)', () => {
  for (const [name, call] of TOKEN_CARRYING_CALLS) {
    for (const [scenario, arrange] of LEAKY_FAILURES) {
      it(`${name}: ${scenario}`, async () => {
        arrange();
        const result = await call(LEAK_TOKEN);

        // Everything the caller can read, in one string. A future arm added to
        // either result union is covered by this without touching the test.
        expect(JSON.stringify(result)).not.toContain(LEAK_TOKEN);

        // And the token stayed out of the URL: it belongs in the header, and
        // only the EventSource URL (which cannot carry headers) is allowed the
        // query form.
        for (const call of fetchMock.mock.calls) {
          expect(String(call[0])).not.toContain(LEAK_TOKEN);
        }
      });
    }
  }

  it('still sends the real token in the Authorization header', async () => {
    // The redaction must not be achieved by weakening the request.
    fetchMock.mockResolvedValue(jsonResponse(200, sessionList()));
    await fetchSessions(LEAK_TOKEN);
    expect(lastRequest().init.headers).toEqual({ Authorization: `Bearer ${LEAK_TOKEN}` });
  });

  it('leaves an unrelated message alone and does not choke on an empty token', async () => {
    // Redacting the empty string would blank out every message ever produced.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await fetchSessions('')).toEqual({
      kind: 'error',
      message: 'Failed to fetch',
      status: null,
    });
  });
});

/**
 * AU-2 (2026-09-03, red-team pass on the auth plumbing). `unreachable` was one
 * arm covering three unrelated facts, and the entry screen rendered all three
 * as "Server unreachable: <message>":
 *
 *   - nothing answered at all (server down, or the browser is offline);
 *   - something answered with a non-401 status (the server is up and broken,
 *     and the token was neither accepted nor rejected);
 *   - 200 arrived and the body could not be read (the token WAS accepted -
 *     the auth gate is in front of every route, so a 200 is proof of it - and
 *     it is the page and the server that disagree about the payload).
 *
 * The third told the user to go restart a server that had just authenticated
 * them, and told them nothing about the token they were holding, which was
 * good. `reason` and `status` are additive fields on the existing arm, so
 * `message` keeps working for callers that only render it.
 */
describe('checkHealth keeps its three unreachable truths apart (AU-2)', () => {
  it('no response at all -> reason no-response, no status', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'Failed to fetch',
      reason: 'no-response',
      status: null,
    });
  });

  it('a non-401 error status -> reason server-error, carrying the status', async () => {
    fetchMock.mockResolvedValue(response(503, { error: 'down for maintenance' }));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'health check failed (HTTP 503)',
      reason: 'server-error',
      status: 503,
    });
  });

  it('an unreadable 200 body -> reason malformed, status 200', async () => {
    fetchMock.mockResolvedValue(textResponse(200));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'malformed health response',
      reason: 'malformed',
      status: 200,
    });
  });
});

/**
 * AU-7 (2026-09-03). An aborted request is not a failure of anything: the
 * caller cancelled it, usually because a view unmounted or a route changed.
 * Two properties have to hold, and only the second is a security property:
 *
 *   1. it is never a `401`-equivalent. An abort that reached the shell's
 *      `unauthorized` arm would clear the stored token and eject the user for
 *      the crime of navigating;
 *   2. it carries `status: null` / no status, because no HTTP response ever
 *      existed - the same fact as an offline browser, and a different one from
 *      any status the server could have sent.
 *
 * Suppression itself belongs to the call sites (every one of them checks
 * `signal.aborted` before applying a result); this pins the shape they rely on.
 */
describe('an abort is not an authentication failure (AU-7)', () => {
  function abortError(): DOMException {
    return new DOMException('The operation was aborted.', 'AbortError');
  }

  it('never reports an aborted data fetch as unauthorized', async () => {
    fetchMock.mockRejectedValue(abortError());
    const controller = new AbortController();
    controller.abort();
    const result = await fetchSessions('secret-token', {}, controller.signal);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.status).toBeNull();
  });

  it('never reports an aborted health probe as unauthorized', async () => {
    fetchMock.mockRejectedValue(abortError());
    const controller = new AbortController();
    controller.abort();
    const result = await checkHealth('secret-token', controller.signal);

    // The shape, deliberately not the sentence: jsdom's DOMException is not an
    // `instanceof Error` (a real browser's is), so the same abort yields
    // 'network error' here and 'The operation was aborted.' in a browser.
    // Pinning that string would pin the environment, not the behaviour.
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.reason).toBe('no-response');
      expect(result.status).toBeNull();
    }
  });
});

/**
 * CA-8 / AU-10 (2026-09-03) - the response bodies stopped being taken on trust.
 *
 * Every read here used to end in `body as T`, and a cast is not provenance: it
 * asserts a shape nobody checked. Each case below feeds a body that PARSES as
 * JSON and passes the old non-object check, and each one names the concrete
 * damage it used to do downstream. Before the guards existed every one of them
 * returned `{ kind: 'ok' }` with the junk inside, which is why they are written
 * as boundary tests rather than as predicate unit tests - the defect was that
 * `api.ts` said "ok" about something it had not read.
 *
 * The tests are deliberately split by the two kinds of damage, because they
 * argue for the guards differently: a missing CONTAINER is loud (a TypeError
 * caught by the route error boundary, a panel replaced by a failure notice that
 * cannot say why), while a missing numeric LEAF is silent and worse - the
 * honesty disclosures are all spelled `x > 0 && <notice/>`, and `undefined > 0`
 * is false, so the absent field withdraws the sentence that says the figure is
 * incomplete.
 */
describe('CA-8/AU-10 - a body that arrived intact and still cannot be read', () => {
  /** A copy of `body` with one key dropped - the field a server stopped sending. */
  function omit<T extends object>(body: T, key: keyof T & string): unknown {
    // `{ ...value }` is typed `T`, and a bare `T extends object` carries no
    // index signature - the widening is the cast, not the spread.
    const clone = { ...body } as Record<string, unknown>;
    delete clone[key];
    return clone;
  }

  /** The verdict every case in this block expects, with the status that arrived. */
  function unreadable(status = 200) {
    return { kind: 'error', message: UNREADABLE_BODY_MESSAGE, status, reason: 'malformed-body' };
  }

  describe('a container the views dereference', () => {
    it('refuses a session list with no `sessions` array', async () => {
      // SessionsView does `.length` and `.map` on it, and LiveView sorts it -
      // absent, the panel throws during render.
      fetchMock.mockResolvedValue(jsonResponse(200, omit(sessionList(), 'sessions')));
      expect(await fetchSessions('secret-token')).toEqual(unreadable());
    });

    it('refuses a session tree with no `unattributed` rollup', async () => {
      // Read three fields deep in TreePanel; absent, the whole tree panel goes.
      fetchMock.mockResolvedValue(jsonResponse(200, omit(sessionTree(), 'unattributed')));
      expect(await fetchSessionTree('secret-token', 'session-1')).toEqual(unreadable());
    });

    it('refuses a global DAG with no `counts`', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, omit(globalDag(), 'counts')));
      expect(await fetchGlobalDag('secret-token')).toEqual(unreadable());
    });

    it('refuses a cost summary whose `perDay` is not an array', async () => {
      // `computeCostWindows` iterates it and `Math.max(0, ...days)` spreads it.
      fetchMock.mockResolvedValue(jsonResponse(200, costSummary({ perDay: null as never })));
      expect(await fetchCostSummary('secret-token')).toEqual(unreadable());
    });

    it('refuses an aggregate estimate with no `skippedSessions` sample', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, omit(aggregateSavings(), 'skippedSessions')));
      expect(await fetchAggregateSavings('secret-token')).toEqual(unreadable());
    });

    it('refuses a cost analysis with no `skippedAgentIds`', async () => {
      // SessionCostAnalysis reads `.length` on it before it renders anything
      // else, so this is the earliest crash the panel had.
      const analysis = costAnalysis();
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          compaction: analysis.compaction,
          delegationSavings: omit(analysis.delegationSavings, 'skippedAgentIds'),
        }),
      );
      expect(await fetchCostAnalysis('secret-token', 'session-1')).toEqual(unreadable());
    });

    it('refuses a compaction segment with no `tokens` bucket set', async () => {
      // `segmentTokens` reads five properties off it; absent, the table throws.
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          ...costAnalysis(),
          compaction: {
            ...costAnalysis().compaction,
            segments: [omit(compactionSegment(), 'tokens')],
          },
        }),
      );
      expect(await fetchCostAnalysis('secret-token', 'session-1')).toEqual(unreadable());
    });

    it('refuses a top-level array, which is an object to `typeof`', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, []));
      expect(await fetchSessions('secret-token')).toEqual(unreadable());
    });
  });

  describe('a figure the disclosures are gated on', () => {
    it('refuses a session row whose `unpricedTokens` is null', async () => {
      // The quiet one. `null > 0` is false, so the "~ n unpriced" caveat simply
      // stops rendering and the row asserts a complete price it never had.
      fetchMock.mockResolvedValue(
        jsonResponse(200, sessionList([sessionSummary({ unpricedTokens: null as never })])),
      );
      expect(await fetchSessions('secret-token')).toEqual(unreadable());
    });

    it('refuses a DAG whose `counts.truncated` flag is missing', async () => {
      // Falsy means "this graph is complete". A dropped flag turns a slice into
      // a claim about the whole corpus, in both DagView and the burners table.
      const dag = globalDag();
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ...dag, counts: omit(dag.counts, 'truncated') }),
      );
      expect(await fetchGlobalDag('secret-token')).toEqual(unreadable());
    });

    it('refuses a DAG node with no `unpricedTokens`', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, globalDag({ nodes: [omit(agentNode(), 'unpricedTokens') as never] })),
      );
      expect(await fetchGlobalDag('secret-token')).toEqual(unreadable());
    });

    it('refuses an aggregate estimate missing a scope counter', async () => {
      // `subagentsPriced + subagentsSkipped` is interpolated with `String(...)`
      // as the denominator of a coverage sentence, so one absent counter used
      // to print "N of NaN subagents".
      fetchMock.mockResolvedValue(jsonResponse(200, omit(aggregateSavings(), 'subagentsSkipped')));
      expect(await fetchAggregateSavings('secret-token')).toEqual(unreadable());
    });

    it('refuses a figure that is a numeric STRING rather than a number', async () => {
      // `Number.isFinite` is not used and the global `isFinite` is not either:
      // the global coerces, so '0' would have passed and then been concatenated
      // rather than added.
      const summary = costSummary();
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ...summary, totals: { ...summary.totals, unpricedTokens: '0' } }),
      );
      expect(await fetchCostSummary('secret-token')).toEqual(unreadable());
    });

    it('refuses a broken `coverage` while accepting an absent one', async () => {
      // `coverage` is Type.Optional and its absence means "no ingest seam
      // wired" - a different fact from zero, and not a malformed body.
      fetchMock.mockResolvedValue(jsonResponse(200, costSummary()));
      expect((await fetchCostSummary('secret-token')).kind).toBe('ok');

      fetchMock.mockResolvedValue(
        jsonResponse(200, costSummary({ coverage: { sessionsExcluded: 2 } as never })),
      );
      expect(await fetchCostSummary('secret-token')).toEqual(unreadable());
    });
  });

  /**
   * The other half of the line, and the half that is easy to get wrong:
   * refusing a whole payload trades a small lie for a total blackout, and a
   * blackout is not automatically more honest. Where this app already has a
   * dedicated marker for an unreadable value, the guard defers to it - the
   * cases below would each have gone dark under a stricter check, and each is
   * already pinned elsewhere in this suite as rendering honestly.
   */
  describe('what it deliberately still lets through', () => {
    it('accepts a status-count set the server sent holes in', async () => {
      // The board prints NO_FIGURE_META for a bucket that is not there (LV-3);
      // a "no figure" cell beats a blacked-out board.
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          sessionList([sessionSummary({ statusCounts: { working: 1, completed: 2 } as never })]),
        ),
      );
      expect((await fetchSessions('secret-token')).kind).toBe('ok');
    });

    it('accepts a compaction segment with an unreadable count and bucket', async () => {
      // `messageCountLabel` prints 'messages unreadable' and the bucket sum
      // formats as 'tokens unreadable' (CA-1) - both more precise than a blank
      // panel, and both regression-tested against this exact payload.
      const analysis = costAnalysis();
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          ...analysis,
          compaction: {
            ...analysis.compaction,
            segments: [
              {
                ...compactionSegment({ messageCount: undefined as never }),
                tokens: { input: 100, cacheRead: 300, cacheWrite5m: 40, cacheWrite1h: 5 },
              },
            ],
          },
        }),
      );
      expect((await fetchCostAnalysis('secret-token', 'session-1')).kind).toBe('ok');
    });

    it('accepts NaN, which no JSON body can actually carry', async () => {
      // Shape, not sanity: `response.json()` cannot produce NaN or Infinity -
      // JSON has no literal for either - so refusing them buys nothing across
      // the wire and costs the honest 'cost unreadable' rendering (F-5) that
      // several tests in this suite pin against hand-built bodies.
      const summary = costSummary();
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ...summary, totals: { ...summary.totals, costUsd: Number.NaN } }),
      );
      expect((await fetchCostSummary('secret-token')).kind).toBe('ok');
    });

    it('accepts an odd string, which prints as itself and fools nobody', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          costSummary({ perDay: [{ day: 42, tokens: 1, costUsd: 1, unpricedTokens: 0 }] as never }),
        ),
      );
      expect((await fetchCostSummary('secret-token')).kind).toBe('ok');
    });
  });

  it('says the server answered rather than that it is down or the token is bad', async () => {
    // AU-2 found three unrelated facts collapsed into one "unreachable"
    // sentence. This is the fourth, and it must not be collapsed into any of
    // them: the request was made, the transport worked, and every route is
    // auth-gated, so a 200 is proof the token was accepted. A reader told the
    // server is unreachable restarts a live process; a reader told the token is
    // wrong retypes a good token. Both are wasted, and both are wrong.
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const result = await fetchCostSummary('secret-token');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.reason).toBe('malformed-body');
    expect(result.message).toContain('the token was accepted');
    expect(result.message).toContain('cannot read the response body');
    expect(result.message).toContain('Nothing is shown rather than a wrong number');
    expect(result.message).not.toContain('unreachable');
    // The status is the one that arrived, never laundered into a fake 5xx.
    expect(result.status).toBe(200);
  });

  it('never lets the token into the unreadable-body message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const result = await fetchSessions('secret-token');
    expect(result.kind === 'error' && result.message.includes('secret-token')).toBe(false);
  });
});
