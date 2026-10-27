/**
 * WP-A10 - the SSRF / secret-leak negative corpus for the alerting core.
 *
 * (1) SSRF: notifications whose string fields carry hostile URLs and header-
 *     injection strings never change where the sink dials - the dial target is
 *     always the constant Telegram origin plus `/bot<token>/sendMessage`.
 * (2) Secret leak: with a recognisable token, every outcome path is driven and
 *     neither an outcome nor anything written to the console contains it.
 * (3) Static: the alerts source holds no other URL origin literal, no console
 *     call, and never interpolates a token-named value into a message.
 *
 * The static checks read source as TEXT, so they hold for every file under
 * src/alerts - including ones added later.
 */
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlertNotification } from '@agenthropic/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createTelegramSink, TELEGRAM_API_ORIGIN } from '../src/alerts/telegram-sink';
import { resolveTokenRef } from '../src/alerts/token-ref';

const TOKEN = '987654321:LEAKCANARY-do_not_print-0xDEADBEEF';
const TOKEN_TAIL = 'LEAKCANARY-do_not_print-0xDEADBEEF';

const HOSTILE = [
  'http://169.254.169.254/latest/meta-data',
  'http://127.0.0.1:4317/api',
  'http://localhost:4317/api/hooks',
  'file:///etc/passwd',
  'https://evil.example/@api.telegram.org',
  'https://api.telegram.org.evil.example/bot1:x/sendMessage',
  'https://api.telegram.org@evil.example/',
  '//evil.example/path',
  '../../../../etc/passwd',
  'x\r\nHost: evil.example\r\nX-Injected: 1',
  'x\nContent-Length: 0\n\nGET / HTTP/1.1',
  'https://аpi.telegram.org/', // Cyrillic "а" lookalike
  'https://api.telegram.org／evil', // fullwidth solidus
  'ｈｔｔｐｓ://evil.example', // fullwidth scheme
  'javascript:alert(1)',
  'gopher://127.0.0.1:6379/_FLUSHALL',
];

function notifications(value: string): AlertNotification[] {
  const base = { alertEventId: value, ruleId: value, sessionId: value, firedAt: value };
  return [
    { ...base, kind: 'cost_threshold', costUsd: 1, thresholdUsd: 1 },
    { ...base, kind: 'stuck_agent', agentId: value, lastSeenAt: value },
    { ...base, kind: 'error', agentId: value },
  ];
}

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function recordingFetch(respond: () => Response | Promise<Response> = () => new Response('{}')) {
  return vi.fn<typeof globalThis.fetch>(async () => respond());
}

function sinkWith(
  fetch: typeof globalThis.fetch,
  resolveToken: (ref: string) => string = () => TOKEN,
) {
  return createTelegramSink({
    targetId: 'tg',
    chatId: '-1001',
    tokenRef: 'env:TG',
    resolveToken,
    fetch,
    timeoutMs: 5,
  });
}

describe('WP-A10 (1) SSRF: no payload value reaches the dial target', () => {
  it.each(HOSTILE)('dials only the constant origin for field value %j', async (value) => {
    const fetch = recordingFetch();
    const sink = sinkWith(fetch);
    for (const n of notifications(value)) {
      await expect(sink.send(n)).resolves.toEqual({ kind: 'sent' });
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [input, init] of fetch.mock.calls as FetchArgs[]) {
      expect(typeof input).toBe('string');
      const url = new URL(String(input));
      expect(url.origin).toBe(TELEGRAM_API_ORIGIN);
      expect(url.pathname).toBe(`/bot${TOKEN}/sendMessage`);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect(url.username).toBe('');
      expect(String(input)).not.toContain(value);
      expect(init?.redirect).toBe('error');
      // The hostile value travels only as JSON text, never in a header.
      expect(init?.headers).toEqual({ 'content-type': 'application/json' });
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      expect(body.chat_id).toBe('-1001');
      expect(Object.keys(body).sort()).toEqual(['chat_id', 'disable_web_page_preview', 'text']);
    }
  });
});

describe('WP-A10 (2) secret leak: the token appears in no outcome and no log', () => {
  const consoleMethods = ['log', 'error', 'warn', 'info', 'debug', 'trace'] as const;
  let spies: MockInstance[] = [];
  let dir: string | undefined;

  beforeEach(() => {
    spies = consoleMethods.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function assertNoLeak(outcome: unknown): void {
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(TOKEN_TAIL);
    expect(serialized).not.toContain('api.telegram.org');
    for (const spy of spies) {
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).not.toContain(TOKEN_TAIL);
    }
  }

  const fullUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const paths: Array<[string, () => Response | Promise<Response>, string]> = [
    ['sent', () => new Response('{"ok":true}'), 'sent'],
    [
      '429',
      () => new Response(JSON.stringify({ description: TOKEN }), { status: 429 }),
      'retryable',
    ],
    ['5xx echoing the URL', () => new Response(fullUrl, { status: 502 }), 'retryable'],
    [
      '4xx echoing the token',
      () => new Response(JSON.stringify({ description: TOKEN }), { status: 401 }),
      'terminal',
    ],
    [
      'network throw embedding the URL',
      () => {
        throw new TypeError(`fetch failed: ${fullUrl}`, { cause: new Error(fullUrl) });
      },
      'retryable',
    ],
    [
      'abort embedding the token',
      () => {
        throw new DOMException(`The operation timed out: ${fullUrl}`, 'TimeoutError');
      },
      'retryable',
    ],
  ];

  it.each(paths)('%s', async (_label, respond, kind) => {
    const outcome = await sinkWith(recordingFetch(respond)).send(notifications('s')[0]!);
    expect(outcome.kind).toBe(kind);
    assertNoLeak(outcome);
  });

  it('a real timeout', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const outcome = await sinkWith(fetch).send(notifications('s')[1]!);
    expect(outcome).toEqual({ kind: 'retryable', reason: 'timeout' });
    assertNoLeak(outcome);
  });

  it('token-resolution failures (env and file, real resolver) carry the ref, not the value', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-a10-'));
    const loose = join(dir, 'loose');
    writeFileSync(loose, TOKEN);
    chmodSync(loose, 0o644);
    const empty = join(dir, 'empty');
    writeFileSync(empty, '');
    chmodSync(empty, 0o600);
    const foreign = join(dir, 'foreign');
    writeFileSync(foreign, TOKEN);
    chmodSync(foreign, 0o600);

    const cases: Array<[string, (ref: string) => string]> = [
      ['env:TG', (ref) => resolveTokenRef(ref, { env: { TG: '' } })],
      [`file:${loose}`, (ref) => resolveTokenRef(ref)],
      [`file:${empty}`, (ref) => resolveTokenRef(ref)],
      [`file:${foreign}`, (ref) => resolveTokenRef(ref, { uid: process.getuid!() + 1 })],
      ['env:TG', () => `${TOKEN}/../evil`],
    ];
    for (const [ref, resolve] of cases) {
      const fetch = recordingFetch();
      const sink = createTelegramSink({
        targetId: 't',
        chatId: '1',
        tokenRef: ref,
        resolveToken: resolve,
        fetch,
      });
      const outcome = await sink.send(notifications('s')[2]!);
      expect(outcome.kind).toBe('terminal');
      assertNoLeak(outcome);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

describe('WP-A10 (3) static scan of src/alerts', () => {
  const alertsDir = fileURLToPath(new URL('../src/alerts', import.meta.url));

  function sourceFiles(dirPath: string): string[] {
    return readdirSync(dirPath).flatMap((name) => {
      const full = join(dirPath, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  const files = sourceFiles(alertsDir).map((path) => ({
    path: relative(alertsDir, path),
    text: readFileSync(path, 'utf8'),
  }));

  it('finds the alerts sources (the scan is not vacuous)', () => {
    const names = files.map((f) => f.path);
    expect(names).toEqual(
      expect.arrayContaining(['telegram-sink.ts', 'token-ref.ts', 'format-telegram.ts']),
    );
  });

  it('TELEGRAM_API_ORIGIN is the only URL origin literal', () => {
    const found: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)\]}>,]*/gi)) {
        found.push(`${path}: ${m[0]}`);
      }
    }
    expect(found).toEqual(['telegram-sink.ts: https://api.telegram.org']);
  });

  it('holds no console call', () => {
    const offenders = files.flatMap(({ path, text }) =>
      text
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /\bconsole\s*\./.test(line))
        .map(({ i }) => `${path}:${i + 1}`),
    );
    expect(offenders).toEqual([]);
  });

  it('interpolates a token-named value only into the one sendMessage URL', () => {
    // A token-named identifier (token, botToken, secret, ...) - but not a
    // tokenRef, which is a name and safe to print.
    const tokenNamed = /\b\w*(?:token|secret)\w*\b/gi;
    const hits: string[] = [];
    for (const { path, text } of files) {
      text.split('\n').forEach((line, i) => {
        const exprs = [...line.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!);
        const concatenated = [...line.matchAll(/(?:\+\s*([\w.]+)|([\w.]+)\s*\+)/g)].map(
          (m) => (m[1] ?? m[2])!,
        );
        for (const expr of [...exprs, ...concatenated]) {
          const names = [...expr.matchAll(tokenNamed)].map((m) => m[0]);
          if (names.some((n) => !/ref$/i.test(n) && !/^TOKEN_GRAMMAR$/.test(n))) {
            hits.push(`${path}:${i + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(
      /^telegram-sink\.ts:\d+: return `\$\{TELEGRAM_API_ORIGIN\}\/bot\$\{token\}\/sendMessage`;$/,
    );
  });
});
