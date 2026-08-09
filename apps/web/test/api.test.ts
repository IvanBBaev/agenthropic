import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  fetchCostAnalysis,
  fetchCostSummary,
  fetchGlobalDag,
  fetchSessions,
  fetchSessionTree,
} from '../src/api';
import {
  costAnalysis,
  costSummary,
  globalDag,
  jsonResponse,
  sessionList,
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
    });
  });

  it('returns unreachable when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'Failed to fetch',
    });
  });

  it('returns unreachable when fetch rejects with a non-Error value', async () => {
    fetchMock.mockRejectedValue('offline');
    expect(await checkHealth('secret')).toEqual({ kind: 'unreachable', message: 'network error' });
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
    });
  });

  it('returns unreachable when the body is not an object', async () => {
    fetchMock.mockResolvedValue(response(200, 'ok'));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'malformed health response',
    });
  });

  it('returns unreachable when schemaVersion is missing or not a number', async () => {
    fetchMock.mockResolvedValue(response(200, { status: 'ok', schemaVersion: '3' }));
    expect(await checkHealth('secret')).toEqual({
      kind: 'unreachable',
      message: 'malformed health response',
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

  it('rejects a malformed (non-object or unparseable) success body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, 'nope'));
    expect(await fetchSessions('secret-token')).toEqual({
      kind: 'error',
      message: 'malformed response body',
      // The transport succeeded; it is the payload that is wrong, so the
      // status stays 200 rather than being laundered into a fake 5xx.
      status: 200,
    });

    fetchMock.mockResolvedValue(textResponse(200));
    expect(await fetchSessions('secret-token')).toEqual({
      kind: 'error',
      message: 'malformed response body',
      status: 200,
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
