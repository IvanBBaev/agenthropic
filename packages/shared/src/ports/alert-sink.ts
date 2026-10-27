/**
 * WP-A1 - the outbound port of the alerting core. A pure interface: no server,
 * driver or network import, so the rules engine and the delivery loop are
 * testable against an in-memory sink and the one adapter that dials out
 * (Telegram, WP-A6) is the only place an outbound request can originate.
 *
 * A sink receives a notification and NOTHING that names where to send it: the
 * destination is bound when the adapter is built from an operator-configured
 * target (AD-4). That is the structural half of the no-SSRF rule - there is no
 * parameter through which a URL read from ingested data could reach a dial.
 */
import type { AlertNotification, AlertTargetKind } from '../schemas/alerts';

/**
 * Outcome of one delivery attempt (AD-7). `reason` is a short operator-facing
 * sentence (status code, timeout) and must never contain a URL or a secret -
 * the Telegram URL embeds the bot token.
 */
export type DeliveryOutcome =
  | { kind: 'sent' }
  /** Worth retrying on the backoff schedule (network error, 5xx, 429). */
  | { kind: 'retryable'; reason: string; retryAfterMs?: number }
  /** Retrying cannot help (4xx other than 429, unresolvable secret). */
  | { kind: 'terminal'; reason: string };

export interface AlertSinkPort {
  /** The `webhook_targets.id` this sink was built for. */
  readonly targetId: string;
  readonly kind: AlertTargetKind;
  /** Attempt one delivery. Must not throw: every failure is an outcome. */
  send(notification: AlertNotification): Promise<DeliveryOutcome>;
}
