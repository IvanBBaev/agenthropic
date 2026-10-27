/**
 * WP-A4 + WP-A6 - the Telegram sink against an injected fake fetch: the exact
 * request it dials, and every response -> DeliveryOutcome mapping (AD-7).
 */
import type { AlertNotification } from '@agenthropic/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTelegram } from '../src/alerts/format-telegram';
import {
  createTelegramSink,
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  MAX_RETRY_AFTER_SECONDS,
  parseRetryAfterMs,
  TELEGRAM_API_ORIGIN,
} from '../src/alerts/telegram-sink';
import { TokenRefError } from '../src/alerts/token-ref';

const TOKEN = '123456789:AAH-test_TOKEN-value';

const notification: AlertNotification = {
  kind: 'cost_threshold',
  alertEventId: 'evt-1',
  ruleId: 'cost-5',
  sessionId: 'sess-1',
  firedAt: '2026-10-24T10:00:00.000Z',
  costUsd: 5,
  thresholdUsd: 5,
};

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function fakeFetch(respond: (...args: FetchArgs) => Response | Promise<Response>) {
  return vi.fn<typeof globalThis.fetch>(async (...args: FetchArgs) => respond(...args));
}

function sink(fetch: typeof globalThis.fetch, extra: { timeoutMs?: number } = {}) {
  return createTelegramSink({
    targetId: 'tg-main',
    chatId: '-100123',
    tokenRef: 'env:TG',
    resolveToken: () => TOKEN,
    fetch,
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createTelegramSink - the request', () => {
  it('exposes targetId and kind', () => {
    const s = sink(fakeFetch(() => new Response('{}')));
    expect(s.targetId).toBe('tg-main');
    expect(s.kind).toBe('telegram');
  });

  it('POSTs plain-text JSON to the constant host with redirect:error and a timeout signal', async () => {
    const fetch = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
    await expect(sink(fetch).send(notification)).resolves.toEqual({ kind: 'sent' });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as FetchArgs;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(new URL(String(url)).origin).toBe(TELEGRAM_API_ORIGIN);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      chat_id: '-100123',
      text: formatTelegram(notification),
      disable_web_page_preview: true,
    });
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('pins the origin constant', () => {
    expect(TELEGRAM_API_ORIGIN).toBe('https://api.telegram.org');
    expect(DEFAULT_TELEGRAM_TIMEOUT_MS).toBe(10_000);
  });

  it('defaults to globalThis.fetch and the real tokenRef resolver', async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('AGENTHROPIC_TEST_TG', TOKEN);
    const s = createTelegramSink({
      targetId: 't',
      chatId: '1',
      tokenRef: 'env:AGENTHROPIC_TEST_TG',
    });
    await expect(s.send(notification)).resolves.toEqual({ kind: 'sent' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('createTelegramSink - status mapping', () => {
  it.each([200, 201, 299])('%i -> sent', async (status) => {
    const out = await sink(fakeFetch(() => new Response(null, { status }))).send(notification);
    expect(out).toEqual({ kind: 'sent' });
  });

  it.each([500, 502, 503, 599])('%i -> retryable', async (status) => {
    const out = await sink(fakeFetch(() => new Response('oops', { status }))).send(notification);
    expect(out).toEqual({ kind: 'retryable', reason: `HTTP ${status}` });
  });

  it.each([400, 401, 403, 404, 409, 302, 199])('%i -> terminal', async (status) => {
    // 199 and 302 are not constructible via `new Response`, so fake the shape.
    const response = { status, text: async () => '{}' } as unknown as Response;
    const out = await sink(fakeFetch(() => response)).send(notification);
    expect(out).toEqual({ kind: 'terminal', reason: `HTTP ${status}` });
  });

  it('429 with a sane retry_after -> retryable with retryAfterMs', async () => {
    const body = JSON.stringify({ ok: false, parameters: { retry_after: 7 } });
    const out = await sink(fakeFetch(() => new Response(body, { status: 429 }))).send(notification);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 429', retryAfterMs: 7000 });
  });

  it.each([
    ['no body', ''],
    ['non-JSON body', 'Too Many Requests'],
    ['JSON null', 'null'],
    ['JSON number', '42'],
    ['no parameters', '{"ok":false}'],
    ['parameters null', '{"parameters":null}'],
    ['retry_after string', '{"parameters":{"retry_after":"7"}}'],
    ['retry_after infinite', '{"parameters":{"retry_after":1e999}}'],
    ['retry_after zero', '{"parameters":{"retry_after":0}}'],
    ['retry_after negative', '{"parameters":{"retry_after":-3}}'],
    ['retry_after too large', `{"parameters":{"retry_after":${MAX_RETRY_AFTER_SECONDS + 1}}}`],
  ])('429 with %s -> retryable without retryAfterMs', async (_label, body) => {
    const out = await sink(fakeFetch(() => new Response(body, { status: 429 }))).send(notification);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 429' });
  });

  it('parseRetryAfterMs rounds fractional seconds up and accepts the upper bound', () => {
    expect(parseRetryAfterMs({ parameters: { retry_after: 1.2 } })).toBe(1200);
    expect(parseRetryAfterMs({ parameters: { retry_after: 0.0001 } })).toBe(1);
    expect(parseRetryAfterMs({ parameters: { retry_after: MAX_RETRY_AFTER_SECONDS } })).toBe(
      MAX_RETRY_AFTER_SECONDS * 1000,
    );
  });

  it('treats a body that cannot be read as absent', async () => {
    const response = {
      status: 429,
      text: async () => {
        throw new Error('stream broke');
      },
    } as unknown as Response;
    const out = await sink(fakeFetch(() => response)).send(notification);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 429' });
  });
});

describe('createTelegramSink - failures before or during the dial', () => {
  it('a thrown network error -> retryable "network error", never the message', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    expect(await sink(fetch).send(notification)).toEqual({
      kind: 'retryable',
      reason: 'network error',
    });
  });

  it('a thrown non-Error value -> retryable "network error"', async () => {
    const fetch = fakeFetch(() => Promise.reject(TOKEN as unknown as Error));
    expect(await sink(fetch).send(notification)).toEqual({
      kind: 'retryable',
      reason: 'network error',
    });
  });

  it('a real AbortSignal.timeout firing -> retryable "timeout"', async () => {
    const fetch = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    expect(await sink(fetch, { timeoutMs: 5 }).send(notification)).toEqual({
      kind: 'retryable',
      reason: 'timeout',
    });
  });

  it('an AbortError -> retryable "timeout"', async () => {
    const fetch = fakeFetch(() => {
      throw new DOMException(`aborted ${TOKEN}`, 'AbortError');
    });
    expect(await sink(fetch).send(notification)).toEqual({ kind: 'retryable', reason: 'timeout' });
  });

  it('a TokenRefError -> terminal naming the ref, and fetch is never called', async () => {
    const fetch = fakeFetch(() => new Response(''));
    const s = createTelegramSink({
      targetId: 't',
      chatId: '1',
      tokenRef: 'env:NOPE',
      resolveToken: (ref) => {
        throw new TokenRefError(ref, 'environment variable is unset or empty');
      },
      fetch,
    });
    expect(await s.send(notification)).toEqual({
      kind: 'terminal',
      reason:
        'token unavailable: tokenRef "env:NOPE" rejected: environment variable is unset or empty',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('any other resolver throw -> terminal with a constant reason', async () => {
    const s = createTelegramSink({
      targetId: 't',
      chatId: '1',
      tokenRef: 'env:X',
      resolveToken: () => {
        throw new Error(`boom ${TOKEN}`);
      },
      fetch: fakeFetch(() => new Response('')),
    });
    expect(await s.send(notification)).toEqual({
      kind: 'terminal',
      reason: 'token unavailable: resolver failed',
    });
  });

  it.each(['abc', '123', '123:has/slash', '123:a?b', '123:a#b', '123:a@evil.example', ' 123:abc'])(
    'a token that breaks the grammar (%j) is terminal and never dialled',
    async (bad) => {
      const fetch = fakeFetch(() => new Response(''));
      const s = createTelegramSink({
        targetId: 't',
        chatId: '1',
        tokenRef: 'env:X',
        resolveToken: () => bad,
        fetch,
      });
      expect(await s.send(notification)).toEqual({
        kind: 'terminal',
        reason: 'token unavailable: malformed bot token',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
