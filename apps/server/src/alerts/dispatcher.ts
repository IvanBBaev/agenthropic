/**
 * WP-A7 - the delivery loop over `webhook_deliveries` (AD-6, AD-7).
 *
 * One pass takes the deliveries that are due (`pending`, `next_retry_at` <=
 * now), hands each to the sink bound to its target and records the outcome:
 *
 *   sent       -> `sent`, `delivered_at` stamped.
 *   terminal   -> `failed` at once (4xx other than 429, unresolvable secret).
 *   retryable  -> stays `pending` with `next_retry_at` = now + 30 s x 2^(n-1)
 *                 (n = attempts so far), or the server's `retry_after` when that
 *                 is longer; after `MAX_DELIVERY_ATTEMPTS` it becomes `failed`.
 *
 * The pass runs on the poll interval, so no retry is ever tighter than the
 * tick, and the first backoff step (30 s) is already ten ticks at the default.
 *
 * THROTTLE. A target sends at most `maxPerMinute` messages in any trailing
 * 60 s window, counted from `delivered_at` in the table itself (so it holds
 * across restarts). A delivery over budget is not attempted and not charged an
 * attempt: it stays `pending` and goes out on a later pass. The budget caps
 * each target's share of the batch in the query itself, so a throttled
 * target's backlog never crowds another target's due rows out of a pass.
 *
 * NO SINK. A delivery whose target has no sink - the target was disabled or
 * removed from the config file after the event fired - fails terminally with a
 * fixed reason, rather than sitting `pending` forever.
 *
 * The loop never logs a URL or a secret: it only ever sees outcome reasons,
 * which the sink contract keeps free of both, and target/delivery ids.
 */
import type { AlertSinkPort, DeliveryOutcome } from '@agenthropic/shared';
import type { SqliteDatabase } from '../db/connection';
import {
  countDueByTarget,
  countSentSince,
  listDueDeliveries,
  listTargets,
  markDeliveryFailed,
  markDeliveryRetry,
  markDeliverySent,
} from '../db/alerts';

export const MAX_DELIVERY_ATTEMPTS = 5;
export const RETRY_BASE_MS = 30_000;
export const THROTTLE_WINDOW_MS = 60_000;
/** Deliveries considered per pass; the rest wait for the next tick. */
export const DISPATCH_BATCH_SIZE = 100;

/** Backoff before attempt `attempts + 1`, after `attempts` failed ones (>= 1). */
export function retryDelayMs(attempts: number): number {
  return RETRY_BASE_MS * 2 ** (attempts - 1);
}

export interface DispatchSummary {
  sent: number;
  retried: number;
  failed: number;
  /** Due deliveries left pending because their target was over budget. */
  throttled: number;
}

export interface AlertDispatcher {
  /** One pass. Resolves to null when a previous pass is still in flight. */
  runOnce(): Promise<DispatchSummary | null>;
}

export interface AlertDispatcherDeps {
  readonly db: SqliteDatabase;
  /** One sink per ENABLED target, keyed by target id. */
  readonly sinks: ReadonlyMap<string, AlertSinkPort>;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export function createAlertDispatcher(deps: AlertDispatcherDeps): AlertDispatcher {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  let inFlight = false;

  async function pass(): Promise<DispatchSummary> {
    const summary: DispatchSummary = { sent: 0, retried: 0, failed: 0, throttled: 0 };
    const start = now();
    const windowStart = new Date(start.getTime() - THROTTLE_WINDOW_MS).toISOString();
    const nowIso = start.toISOString();
    const budget = new Map<string, number>();
    for (const target of listTargets(deps.db)) {
      // Only a target that can send is budgeted: a sinkless one's rows can
      // only fail, so they are never held back as throttled.
      if (!deps.sinks.has(target.id)) continue;
      const left = target.maxPerMinute - countSentSince(deps.db, target.id, windowStart);
      budget.set(target.id, Math.max(0, left));
    }
    for (const [targetId, due] of countDueByTarget(deps.db, nowIso)) {
      summary.throttled += Math.max(0, due - (budget.get(targetId) ?? due));
    }

    for (const delivery of listDueDeliveries(deps.db, nowIso, DISPATCH_BATCH_SIZE, budget)) {
      const attempts = delivery.attemptCount + 1;
      const sink = deps.sinks.get(delivery.targetId);
      if (sink === undefined) {
        markDeliveryFailed(
          deps.db,
          delivery.deliveryId,
          delivery.attemptCount,
          'target not configured',
        );
        summary.failed++;
        log(
          `alert delivery ${delivery.deliveryId} -> ${delivery.targetId}: failed (target not configured)`,
        );
        continue;
      }
      const outcome = await sendSafely(sink, delivery.notification);
      const at = now();
      const prefix = `alert delivery ${delivery.deliveryId} -> ${delivery.targetId}`;
      if (outcome.kind === 'sent') {
        markDeliverySent(deps.db, delivery.deliveryId, attempts, at.toISOString());
        summary.sent++;
        log(`${prefix}: sent`);
      } else if (outcome.kind === 'terminal' || attempts >= MAX_DELIVERY_ATTEMPTS) {
        const reason =
          outcome.kind === 'terminal'
            ? outcome.reason
            : `${outcome.reason}; gave up after ${attempts} attempts`;
        markDeliveryFailed(deps.db, delivery.deliveryId, attempts, reason);
        summary.failed++;
        log(`${prefix}: failed (${reason})`);
      } else {
        const delay = Math.max(retryDelayMs(attempts), outcome.retryAfterMs ?? 0);
        const next = new Date(at.getTime() + delay).toISOString();
        markDeliveryRetry(deps.db, delivery.deliveryId, attempts, next, outcome.reason);
        summary.retried++;
        log(`${prefix}: retry ${attempts}/${MAX_DELIVERY_ATTEMPTS} at ${next} (${outcome.reason})`);
      }
    }
    return summary;
  }

  return {
    async runOnce() {
      if (inFlight) return null;
      inFlight = true;
      try {
        return await pass();
      } finally {
        inFlight = false;
      }
    },
  };
}

/**
 * The port says `send` never throws; a sink that breaks that contract is
 * treated as a retryable failure with a FIXED reason - its error message is
 * never relayed, because an adapter's error may embed the URL (and the token).
 */
async function sendSafely(
  sink: AlertSinkPort,
  notification: Parameters<AlertSinkPort['send']>[0],
): Promise<DeliveryOutcome> {
  try {
    return await sink.send(notification);
  } catch {
    return { kind: 'retryable', reason: 'sink error' };
  }
}
