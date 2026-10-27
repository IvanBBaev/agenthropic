/**
 * WP-A2 - the alerting store (migration 23): the persisted mirror of the
 * operator config file (targets + rules), the fired-alert history with its
 * dedupe key, and the delivery outbox the dispatcher drains.
 *
 * Synchronous better-sqlite3, like the rest of `db/`. Nothing here ever reads
 * or writes a secret: a target carries only its `tokenRef` (AD-3), and a
 * delivery's `last_error` is whatever short reason the caller hands in.
 *
 * Every instant is an ISO-8601 string compared lexicographically; callers pass
 * canonical `Date#toISOString()` values, which order correctly as text.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_ALERTS_PER_MINUTE,
  type AlertKind,
  type AlertNotification,
  type AlertsConfig,
} from '@agenthropic/shared';
import type { SqliteDatabase } from './connection';

export interface AlertTargetRow {
  id: string;
  kind: 'telegram';
  tokenRef: string;
  chatId: string;
  maxPerMinute: number;
  enabled: boolean;
}

export interface AlertRuleRow {
  id: string;
  kind: AlertKind;
  targetId: string;
  thresholdUsd: number | null;
  enabled: boolean;
  armedAt: string;
}

/** `Omit` applied to each member of a union, so the kind discriminant survives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The AlertNotification payload minus alertEventId. */
export type AlertEventPayload = DistributiveOmit<AlertNotification, 'alertEventId'>;

export interface NewAlertEvent {
  ruleId: string;
  targetId: string;
  dedupeKey: string;
  payload: AlertEventPayload;
}

export interface DueDelivery {
  deliveryId: string;
  targetId: string;
  attemptCount: number;
  notification: AlertNotification;
}

export interface DeliveryCounts {
  pending: number;
  sent: number;
  failed: number;
}

/**
 * Upsert every target and rule from the file by id, in ONE transaction.
 * Targets go first because rules reference them. A target or rule present in
 * the database but absent from the file is set enabled = 0, never deleted -
 * alert history references it.
 *
 * `armed_at` is set to `nowIso` on insert and reset to `nowIso` only when a
 * rule goes from disabled to enabled; a rule whose kind, threshold or target
 * changed keeps its `armed_at`.
 */
export function syncAlertsConfig(db: SqliteDatabase, config: AlertsConfig, nowIso: string): void {
  const upsertTarget = db.prepare(
    `INSERT INTO webhook_targets (id, kind, token_ref, chat_id, max_per_minute, enabled)
     VALUES (@id, @kind, @tokenRef, @chatId, @maxPerMinute, 1)
     ON CONFLICT(id) DO UPDATE SET
       kind           = excluded.kind,
       token_ref      = excluded.token_ref,
       chat_id        = excluded.chat_id,
       max_per_minute = excluded.max_per_minute,
       enabled        = 1`,
  );
  const disableAbsentTargets = db.prepare(
    `UPDATE webhook_targets SET enabled = 0
      WHERE id NOT IN (SELECT value FROM json_each(?))`,
  );
  const upsertRule = db.prepare(
    `INSERT INTO alert_rules (id, kind, target_id, threshold_usd, enabled, armed_at)
     VALUES (@id, @kind, @targetId, @thresholdUsd, @enabled, @nowIso)
     ON CONFLICT(id) DO UPDATE SET
       kind          = excluded.kind,
       target_id     = excluded.target_id,
       threshold_usd = excluded.threshold_usd,
       -- Re-arm only on a disabled -> enabled transition: enabling a rule
       -- must not replay history, and editing an enabled rule must not
       -- silently skip what it would have caught.
       armed_at      = CASE
         WHEN alert_rules.enabled = 0 AND excluded.enabled = 1 THEN excluded.armed_at
         ELSE alert_rules.armed_at
       END,
       enabled       = excluded.enabled`,
  );
  const disableAbsentRules = db.prepare(
    `UPDATE alert_rules SET enabled = 0
      WHERE id NOT IN (SELECT value FROM json_each(?))`,
  );

  db.transaction(() => {
    for (const target of config.targets) {
      upsertTarget.run({
        id: target.id,
        kind: target.kind,
        tokenRef: target.tokenRef,
        chatId: target.chatId,
        maxPerMinute: target.maxPerMinute ?? DEFAULT_ALERTS_PER_MINUTE,
      });
    }
    disableAbsentTargets.run(JSON.stringify(config.targets.map((target) => target.id)));
    for (const rule of config.rules) {
      upsertRule.run({
        id: rule.id,
        kind: rule.kind,
        targetId: rule.targetId,
        thresholdUsd: rule.kind === 'cost_threshold' ? rule.thresholdUsd : null,
        enabled: (rule.enabled ?? true) ? 1 : 0,
        nowIso,
      });
    }
    disableAbsentRules.run(JSON.stringify(config.rules.map((rule) => rule.id)));
  })();
}

interface TargetRecord {
  id: string;
  kind: 'telegram';
  token_ref: string;
  chat_id: string;
  max_per_minute: number;
  enabled: number;
}

/** Every target, enabled or not, ordered by id. */
export function listTargets(db: SqliteDatabase): AlertTargetRow[] {
  const rows = db
    .prepare(
      `SELECT id, kind, token_ref, chat_id, max_per_minute, enabled
         FROM webhook_targets ORDER BY id`,
    )
    .all() as TargetRecord[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    tokenRef: row.token_ref,
    chatId: row.chat_id,
    maxPerMinute: row.max_per_minute,
    enabled: row.enabled === 1,
  }));
}

interface RuleRecord {
  id: string;
  kind: AlertKind;
  target_id: string;
  threshold_usd: number | null;
  enabled: number;
  armed_at: string;
}

/** Enabled rules whose target is also enabled, ordered by id. */
export function listActiveRules(db: SqliteDatabase): AlertRuleRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.kind, r.target_id, r.threshold_usd, r.enabled, r.armed_at
         FROM alert_rules r
         JOIN webhook_targets t ON t.id = r.target_id
        WHERE r.enabled = 1 AND t.enabled = 1
        ORDER BY r.id`,
    )
    .all() as RuleRecord[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    thresholdUsd: row.threshold_usd,
    enabled: row.enabled === 1,
    armedAt: row.armed_at,
  }));
}

/**
 * INSERT the alert event and ONE pending delivery for `targetId` (attempt 0,
 * due at `payload.firedAt`) in one transaction. On a `dedupe_key` conflict
 * nothing is inserted and null is returned; otherwise the new event id.
 */
export function recordAlertEvent(db: SqliteDatabase, event: NewAlertEvent): string | null {
  const insertEvent = db.prepare(
    `INSERT INTO alert_events (id, rule_id, session_id, agent_id, fired_at, dedupe_key, payload)
     VALUES (@id, @ruleId, @sessionId, @agentId, @firedAt, @dedupeKey, @payload)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  );
  const insertDelivery = db.prepare(
    `INSERT INTO webhook_deliveries (id, target_id, alert_event_id, status, attempt_count, next_retry_at)
     VALUES (?, ?, ?, 'pending', 0, ?)`,
  );
  const { payload } = event;
  return db.transaction((): string | null => {
    const id = randomUUID();
    const inserted = insertEvent.run({
      id,
      ruleId: event.ruleId,
      sessionId: payload.sessionId,
      agentId: 'agentId' in payload ? payload.agentId : null,
      firedAt: payload.firedAt,
      dedupeKey: event.dedupeKey,
      payload: JSON.stringify(payload),
    });
    if (inserted.changes === 0) {
      return null;
    }
    insertDelivery.run(randomUUID(), event.targetId, id, payload.firedAt);
    return id;
  })();
}

/** True when an alert_event with this dedupe key exists. */
export function alertEventExists(db: SqliteDatabase, dedupeKey: string): boolean {
  return (
    db.prepare('SELECT 1 FROM alert_events WHERE dedupe_key = ?').pluck().get(dedupeKey) !==
    undefined
  );
}

interface DueRecord {
  id: string;
  target_id: string;
  attempt_count: number;
  alert_event_id: string;
  payload: string;
}

/**
 * Pending deliveries due at `nowIso` (next_retry_at <= nowIso), ordered by
 * next_retry_at then id, at most `limit`. The notification is the stored
 * payload plus its alertEventId.
 */
export function listDueDeliveries(
  db: SqliteDatabase,
  nowIso: string,
  limit: number,
): DueDelivery[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.target_id, d.attempt_count, d.alert_event_id, e.payload
         FROM webhook_deliveries d
         JOIN alert_events e ON e.id = d.alert_event_id
        WHERE d.status = 'pending' AND d.next_retry_at <= ?
        ORDER BY d.next_retry_at, d.id
        LIMIT ?`,
    )
    .all(nowIso, limit) as DueRecord[];
  return rows.map((row) => ({
    deliveryId: row.id,
    targetId: row.target_id,
    attemptCount: row.attempt_count,
    notification: {
      ...(JSON.parse(row.payload) as AlertEventPayload),
      alertEventId: row.alert_event_id,
    },
  }));
}

/** Deliveries for `targetId` sent at or after `sinceIso` - the throttle window. */
export function countSentSince(db: SqliteDatabase, targetId: string, sinceIso: string): number {
  return db
    .prepare(
      `SELECT COUNT(*) FROM webhook_deliveries
        WHERE target_id = ? AND status = 'sent' AND delivered_at >= ?`,
    )
    .pluck()
    .get(targetId, sinceIso) as number;
}

/** Pending -> sent. A no-op on a row that is no longer pending. */
export function markDeliverySent(
  db: SqliteDatabase,
  deliveryId: string,
  attemptCount: number,
  atIso: string,
): void {
  db.prepare(
    `UPDATE webhook_deliveries
        SET status = 'sent', delivered_at = ?, attempt_count = ?,
            next_retry_at = NULL, last_error = NULL
      WHERE id = ? AND status = 'pending'`,
  ).run(atIso, attemptCount, deliveryId);
}

/** Stays pending, due again at `nextRetryAtIso`. A no-op on a row that is no longer pending. */
export function markDeliveryRetry(
  db: SqliteDatabase,
  deliveryId: string,
  attemptCount: number,
  nextRetryAtIso: string,
  lastError: string,
): void {
  db.prepare(
    `UPDATE webhook_deliveries
        SET attempt_count = ?, next_retry_at = ?, last_error = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(attemptCount, nextRetryAtIso, lastError, deliveryId);
}

/** Pending -> failed (terminal). A no-op on a row that is no longer pending. */
export function markDeliveryFailed(
  db: SqliteDatabase,
  deliveryId: string,
  attemptCount: number,
  lastError: string,
): void {
  db.prepare(
    `UPDATE webhook_deliveries
        SET status = 'failed', attempt_count = ?, next_retry_at = NULL, last_error = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(attemptCount, lastError, deliveryId);
}

/** Delivery totals by status (zero for a status with no rows). */
export function countDeliveries(db: SqliteDatabase): DeliveryCounts {
  return db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
              COUNT(*) FILTER (WHERE status = 'failed')  AS failed
         FROM webhook_deliveries`,
    )
    .get() as DeliveryCounts;
}
