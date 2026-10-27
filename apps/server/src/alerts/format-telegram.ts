/**
 * WP-A6 - render an `AlertNotification` as a Telegram message body.
 *
 * Attribution: the idea of a dedicated per-provider `formatTelegram` step is
 * grafted from hoangsonww's Claude Code agent monitor (MIT licensed). This is
 * a re-implementation against our own notification union; no code was copied.
 *
 * Rules this formatter holds:
 * - Plain text only. The sink sends no `parse_mode`, so nothing in a field can
 *   be interpreted as Markdown/HTML markup.
 * - Built from ids and figures only - the notification carries no transcript
 *   text, and nothing here reads any.
 * - Every id is passed through `field()`: control characters (a newline in an
 *   id could forge a fake line), bidi overrides/isolates (which could reorder
 *   what the reader sees) and zero-width characters become spaces, and the
 *   length is capped, so the message stays well under Telegram's 4096-character
 *   limit.
 */
import type { AlertNotification } from '@agenthropic/shared';

/** Longest id rendered verbatim; longer values are cut with an ellipsis. */
export const MAX_FIELD_LENGTH = 128;

export function formatTelegram(n: AlertNotification): string {
  switch (n.kind) {
    case 'cost_threshold':
      return lines(n, 'Cost threshold reached', [
        `Session: ${field(n.sessionId)}`,
        `Cost: ${usd(n.costUsd)} (threshold ${usd(n.thresholdUsd)})`,
      ]);
    case 'stuck_agent':
      return lines(n, 'Agent appears stuck', [
        `Session: ${field(n.sessionId)}`,
        `Agent: ${field(n.agentId)}`,
        `Last seen: ${field(n.lastSeenAt)}`,
      ]);
    case 'error':
      return lines(n, 'Agent ended in error', [
        `Session: ${field(n.sessionId)}`,
        `Agent: ${field(n.agentId)}`,
      ]);
    default: {
      // Exhaustiveness: adding a kind to the union fails typecheck here. At
      // runtime a value outside the union still gets a generic message rather
      // than an exception, because a sink must never throw.
      const unhandled: never = n;
      const base = unhandled as AlertNotification;
      return lines(base, 'Alert', [`Session: ${field(base.sessionId)}`]);
    }
  }
}

function lines(n: AlertNotification, title: string, body: string[]): string {
  return [
    `[agenthropic] ${title}`,
    ...body,
    `Rule: ${field(n.ruleId)}`,
    `Fired: ${field(n.firedAt)}`,
    `Event: ${field(n.alertEventId)}`,
  ].join('\n');
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function field(value: string): string {
  const clean = String(value).replace(
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    ' ',
  );
  return clean.length > MAX_FIELD_LENGTH ? `${clean.slice(0, MAX_FIELD_LENGTH)}…` : clean;
}
