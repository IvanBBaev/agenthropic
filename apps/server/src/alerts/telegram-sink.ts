/**
 * WP-A4 + WP-A6 - the Telegram `AlertSinkPort` adapter, and the ONLY place in
 * the server process that dials out.
 *
 * No-SSRF, structurally (AD-4): the host is the constant below. It is not
 * configurable, no notification field reaches the URL, and `redirect: 'error'`
 * stops a response from moving the request anywhere else. The only variable
 * part of the URL is the bot token, which comes from the operator's tokenRef
 * and must match Telegram's token grammar, so it cannot smuggle a path, query
 * or fragment either. The payload is plain text (no `parse_mode`).
 *
 * No secret leak: the bot token sits in the URL path, so the URL is a secret
 * too. No outcome reason ever contains the URL, the token, or a caught error's
 * message (undici messages can embed the URL). Reasons are fixed strings or an
 * HTTP status code, and every one is passed through `redactSecret` regardless.
 *
 * `send` never throws: every failure is a `DeliveryOutcome` (AD-7).
 */
import type { AlertNotification, AlertSinkPort, DeliveryOutcome } from '@agenthropic/shared';
import { formatTelegram } from './format-telegram';
import { redactSecret, resolveTokenRef, TokenRefError } from './token-ref';

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

/** Default per-request timeout (AD-7 retries on the next poll tick). */
export const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;

/** Largest `retry_after` (seconds) honoured from a 429 body; beyond it, use the backoff. */
export const MAX_RETRY_AFTER_SECONDS = 3600;

/** Telegram bot token grammar: `<bot id>:<secret>`. Pins the URL path shape. */
const TOKEN_GRAMMAR = /^[0-9]+:[A-Za-z0-9_-]+$/;

export interface TelegramSinkOptions {
  targetId: string;
  chatId: string;
  tokenRef: string;
  resolveToken?: (ref: string) => string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createTelegramSink(options: TelegramSinkOptions): AlertSinkPort {
  const resolveToken = options.resolveToken ?? ((ref: string) => resolveTokenRef(ref));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS;

  return {
    targetId: options.targetId,
    kind: 'telegram',
    async send(notification: AlertNotification): Promise<DeliveryOutcome> {
      let token: string;
      try {
        token = resolveToken(options.tokenRef);
      } catch (err) {
        const detail = err instanceof TokenRefError ? err.message : 'resolver failed';
        return { kind: 'terminal', reason: `token unavailable: ${detail}` };
      }
      if (!TOKEN_GRAMMAR.test(token)) {
        return { kind: 'terminal', reason: 'token unavailable: malformed bot token' };
      }
      const outcome = await deliver(options, token, notification, timeoutMs);
      return outcome.kind === 'sent'
        ? outcome
        : { ...outcome, reason: redactSecret(outcome.reason, token) };
    },
  };
}

function sendMessageUrl(token: string): string {
  return `${TELEGRAM_API_ORIGIN}/bot${token}/sendMessage`;
}

async function deliver(
  options: TelegramSinkOptions,
  token: string,
  notification: AlertNotification,
  timeoutMs: number,
): Promise<DeliveryOutcome> {
  // Named `fetch` on purpose so the WP-F5 gate sees the dial below and the
  // inline marker on it is a live, logged exemption rather than a dead one.
  const fetch = options.fetch ?? globalThis.fetch;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: options.chatId,
      text: formatTelegram(notification),
      disable_web_page_preview: true,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  };

  let response: Response;
  try {
    // The one outbound dial (WP-A4): constant host, operator token, no payload URL.
    response = await fetch(sendMessageUrl(token), init); // spawner-gate-allow: WP-A4 constant Telegram host
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { kind: 'retryable', reason: timedOut ? 'timeout' : 'network error' };
  }

  const status = response.status;
  const body = await readBody(response);
  if (status >= 200 && status < 300) return { kind: 'sent' };
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(body);
    return retryAfterMs === undefined
      ? { kind: 'retryable', reason: 'HTTP 429' }
      : { kind: 'retryable', reason: 'HTTP 429', retryAfterMs };
  }
  if (status >= 500) return { kind: 'retryable', reason: `HTTP ${status}` };
  return { kind: 'terminal', reason: `HTTP ${status}` };
}

/** Consume the body (frees the connection) and parse it as JSON when possible. */
async function readBody(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  }
}

/** Telegram's 429 body: `{ parameters: { retry_after: <seconds> } }`. */
export function parseRetryAfterMs(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const parameters = (body as { parameters?: unknown }).parameters;
  if (typeof parameters !== 'object' || parameters === null) return undefined;
  const seconds = (parameters as { retry_after?: unknown }).retry_after;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  if (seconds <= 0 || seconds > MAX_RETRY_AFTER_SECONDS) return undefined;
  return Math.ceil(seconds * 1000);
}
