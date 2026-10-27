/**
 * WP-A2 - migration 23 (`alerts-core`) and the alerting store in
 * `src/db/alerts.ts`: the schema rejects what it must (no raw token, bounded
 * throttle, threshold exactly on cost rules, one event per dedupe key), the
 * config sync disables instead of deleting and re-arms only on a
 * disabled -> enabled transition, and the delivery outbox moves only out of
 * `pending`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlertsConfig } from '@agenthropic/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  alertEventExists,
  countDeliveries,
  countSentSince,
  listActiveRules,
  listDueDeliveries,
  listTargets,
  markDeliveryFailed,
  markDeliveryRetry,
  markDeliverySent,
  recordAlertEvent,
  syncAlertsConfig,
  type AlertEventPayload,
} from '../src/db/alerts';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { currentSchemaVersion, migrations, runMigrations } from '../src/db/migrations';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

const T0 = '2026-10-24T10:00:00.000Z';
const T1 = '2026-10-24T11:00:00.000Z';
const T2 = '2026-10-24T12:00:00.000Z';

const ALERT_TABLES = ['alert_events', 'alert_rules', 'webhook_deliveries', 'webhook_targets'];

function tableNames(db: SqliteDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[];
}

function baseConfig(): AlertsConfig {
  return {
    targets: [
      { id: 'tg-main', kind: 'telegram', tokenRef: 'env:TELEGRAM_BOT_TOKEN', chatId: '-100123' },
    ],
    rules: [
      { id: 'cost-5', kind: 'cost_threshold', targetId: 'tg-main', thresholdUsd: 5 },
      { id: 'stuck', kind: 'stuck_agent', targetId: 'tg-main' },
    ],
  };
}

function costPayload(sessionId: string, firedAt: string): AlertEventPayload {
  return {
    kind: 'cost_threshold',
    ruleId: 'cost-5',
    sessionId,
    firedAt,
    costUsd: 6.5,
    thresholdUsd: 5,
  };
}

function stuckPayload(agentId: string, firedAt: string): AlertEventPayload {
  return {
    kind: 'stuck_agent',
    ruleId: 'stuck',
    sessionId: 's1',
    agentId,
    firedAt,
    lastSeenAt: '2026-10-24T09:00:00.000Z',
  };
}

function deliveryRow(db: SqliteDatabase, id: string): Record<string, unknown> {
  return db
    .prepare(
      `SELECT status, attempt_count, next_retry_at, delivered_at, last_error
         FROM webhook_deliveries WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

describe('migration 23 (alerts-core)', () => {
  let temp: TempDb | undefined;

  afterEach(() => {
    temp?.cleanup();
    temp = undefined;
  });

  it('creates the four alert tables and both delivery indexes on a fresh database', () => {
    temp = createMigratedTempDb();
    expect(currentSchemaVersion(temp.db)).toBe(23);
    expect(tableNames(temp.db)).toEqual(expect.arrayContaining(ALERT_TABLES));
    const indexes = temp.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'webhook_deliveries'",
      )
      .pluck()
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_webhook_deliveries_due',
        'idx_webhook_deliveries_target_delivered',
      ]),
    );
  });

  it('applies forward-only on a schema-22 database with data, and a second run applies nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-mig23-'));
    const db = openDatabase(join(dir, 'v22.db'));
    try {
      runMigrations(
        db,
        migrations.filter((m) => m.id <= 22),
      );
      expect(currentSchemaVersion(db)).toBe(22);
      insertSession(db, 'sess-a');
      const before = db.prepare('SELECT * FROM sessions').all();
      for (const table of ALERT_TABLES) {
        expect(tableNames(db)).not.toContain(table);
      }

      expect(runMigrations(db).appliedIds).toEqual([23]);
      expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
      expect(tableNames(db)).toEqual(expect.arrayContaining(ALERT_TABLES));

      expect(runMigrations(db).appliedIds).toEqual([]);
      expect(currentSchemaVersion(db)).toBe(23);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('constraints', () => {
    beforeEach(() => {
      temp = createMigratedTempDb();
    });

    const insertTarget = (
      db: SqliteDatabase,
      overrides: Partial<Record<'id' | 'kind' | 'tokenRef' | 'max' | 'enabled', unknown>> = {},
    ): void => {
      db.prepare(
        `INSERT INTO webhook_targets (id, kind, token_ref, chat_id, max_per_minute, enabled)
         VALUES (@id, @kind, @tokenRef, '-1', @max, @enabled)`,
      ).run({
        id: 't',
        kind: 'telegram',
        tokenRef: 'env:TOKEN',
        max: 10,
        enabled: 1,
        ...overrides,
      });
    };

    const insertRule = (
      db: SqliteDatabase,
      id: string,
      kind: string,
      thresholdUsd: number | null,
      targetId = 't',
    ): void => {
      db.prepare(
        `INSERT INTO alert_rules (id, kind, target_id, threshold_usd, enabled, armed_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).run(id, kind, targetId, thresholdUsd, T0);
    };

    it('accepts a well-formed target with an env: or file: token reference', () => {
      const db = temp!.db;
      insertTarget(db);
      insertTarget(db, { id: 't2', tokenRef: 'file:/etc/agenthropic/token', max: 1 });
      insertTarget(db, { id: 't3', max: 60, enabled: 0 });
      expect(db.prepare('SELECT COUNT(*) FROM webhook_targets').pluck().get()).toBe(3);
    });

    it('rejects an unknown target kind, a raw token, an out-of-range throttle and a bad enabled flag', () => {
      const db = temp!.db;
      expect(() => insertTarget(db, { kind: 'slack' })).toThrow(/CHECK constraint failed/);
      for (const tokenRef of ['abc', '123456:AAH-raw-bot-token', 'env:', 'file:/', 'file:rel']) {
        expect(() => insertTarget(db, { tokenRef })).toThrow(/CHECK constraint failed/);
      }
      expect(() => insertTarget(db, { max: 0 })).toThrow(/CHECK constraint failed/);
      expect(() => insertTarget(db, { max: 61 })).toThrow(/CHECK constraint failed/);
      expect(() => insertTarget(db, { enabled: 2 })).toThrow(/CHECK constraint failed/);
    });

    it('rejects a bad rule kind, a threshold on a non-cost rule, a missing or non-positive cost threshold, and an unknown target', () => {
      const db = temp!.db;
      insertTarget(db);
      insertRule(db, 'ok-cost', 'cost_threshold', 1.5);
      insertRule(db, 'ok-stuck', 'stuck_agent', null);
      insertRule(db, 'ok-error', 'error', null);

      expect(() => insertRule(db, 'r', 'budget', null)).toThrow(/CHECK constraint failed/);
      expect(() => insertRule(db, 'r', 'stuck_agent', 5)).toThrow(/CHECK constraint failed/);
      expect(() => insertRule(db, 'r', 'error', 5)).toThrow(/CHECK constraint failed/);
      expect(() => insertRule(db, 'r', 'cost_threshold', null)).toThrow(/CHECK constraint failed/);
      expect(() => insertRule(db, 'r', 'cost_threshold', 0)).toThrow(/CHECK constraint failed/);
      expect(() => insertRule(db, 'r', 'cost_threshold', -1)).toThrow(/CHECK constraint failed/);
      expect(() => insertRule(db, 'r', 'error', null, 'nope')).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    });

    it('rejects a duplicate dedupe key, invalid JSON, an unknown rule, and a bad delivery row', () => {
      const db = temp!.db;
      insertTarget(db);
      insertRule(db, 'r', 'error', null);
      const insertEvent = db.prepare(
        `INSERT INTO alert_events (id, rule_id, session_id, agent_id, fired_at, dedupe_key, payload)
         VALUES (?, ?, 'gone-session', NULL, ?, ?, ?)`,
      );
      // No FK to sessions: an event for a session that does not exist is fine.
      insertEvent.run('e1', 'r', T0, 'k1', '{}');
      expect(() => insertEvent.run('e2', 'r', T0, 'k1', '{}')).toThrow(
        /UNIQUE constraint failed: alert_events.dedupe_key/,
      );
      expect(() => insertEvent.run('e3', 'r', T0, 'k3', 'not json')).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => insertEvent.run('e4', 'missing', T0, 'k4', '{}')).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      const insertDelivery = db.prepare(
        `INSERT INTO webhook_deliveries (id, target_id, alert_event_id, status, attempt_count)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insertDelivery.run('d1', 't', 'e1', 'pending', 0);
      expect(() => insertDelivery.run('d2', 't', 'e1', 'pending', 0)).toThrow(
        /UNIQUE constraint failed/,
      );
      expect(() => insertDelivery.run('d3', 't', 'e1', 'queued', 0)).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => insertDelivery.run('d4', 't', 'e1', 'pending', -1)).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => insertDelivery.run('d5', 'nope', 'e1', 'pending', 0)).toThrow(
        /FOREIGN KEY constraint failed/,
      );
      expect(() => insertDelivery.run('d6', 't', 'nope', 'pending', 0)).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    });

    it('keeps the alert history when retention-style deletes remove the session', () => {
      const db = temp!.db;
      insertSession(db, 's1');
      insertTarget(db);
      insertRule(db, 'r', 'error', null);
      db.prepare(
        `INSERT INTO alert_events (id, rule_id, session_id, agent_id, fired_at, dedupe_key, payload)
         VALUES ('e1', 'r', 's1', 'a1', ?, 'k1', '{}')`,
      ).run(T0);
      db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
      expect(db.prepare('SELECT session_id FROM alert_events').pluck().all()).toEqual(['s1']);
    });
  });
});

describe('alerts store (WP-A2)', () => {
  let temp: TempDb;
  let db: SqliteDatabase;

  beforeEach(() => {
    temp = createMigratedTempDb();
    db = temp.db;
  });

  afterEach(() => {
    temp.cleanup();
  });

  describe('syncAlertsConfig', () => {
    it('inserts targets with the default throttle and rules armed at now, enabled by default', () => {
      syncAlertsConfig(db, baseConfig(), T0);

      expect(listTargets(db)).toEqual([
        {
          id: 'tg-main',
          kind: 'telegram',
          tokenRef: 'env:TELEGRAM_BOT_TOKEN',
          chatId: '-100123',
          maxPerMinute: 10,
          enabled: true,
        },
      ]);
      expect(listActiveRules(db)).toEqual([
        {
          id: 'cost-5',
          kind: 'cost_threshold',
          targetId: 'tg-main',
          thresholdUsd: 5,
          enabled: true,
          armedAt: T0,
        },
        {
          id: 'stuck',
          kind: 'stuck_agent',
          targetId: 'tg-main',
          thresholdUsd: null,
          enabled: true,
          armedAt: T0,
        },
      ]);
    });

    it('honours an explicit throttle and an explicitly disabled rule', () => {
      const config = baseConfig();
      config.targets[0] = { ...config.targets[0]!, maxPerMinute: 3 };
      config.rules.push({ id: 'err', kind: 'error', targetId: 'tg-main', enabled: false });
      syncAlertsConfig(db, config, T0);

      expect(listTargets(db)[0]?.maxPerMinute).toBe(3);
      expect(listActiveRules(db).map((r) => r.id)).toEqual(['cost-5', 'stuck']);
      expect(
        db.prepare("SELECT enabled, armed_at FROM alert_rules WHERE id = 'err'").get(),
      ).toEqual({ enabled: 0, armed_at: T0 });
    });

    it('updates a target in place and disables, never deletes, what the file no longer names', () => {
      syncAlertsConfig(db, baseConfig(), T0);
      syncAlertsConfig(
        db,
        {
          targets: [
            {
              id: 'tg-main',
              kind: 'telegram',
              tokenRef: 'file:/run/token',
              chatId: '@alerts_channel',
              maxPerMinute: 60,
            },
            { id: 'tg-two', kind: 'telegram', tokenRef: 'env:OTHER', chatId: '42' },
          ],
          rules: [{ id: 'stuck', kind: 'stuck_agent', targetId: 'tg-main' }],
        },
        T1,
      );
      expect(listTargets(db)).toEqual([
        {
          id: 'tg-main',
          kind: 'telegram',
          tokenRef: 'file:/run/token',
          chatId: '@alerts_channel',
          maxPerMinute: 60,
          enabled: true,
        },
        {
          id: 'tg-two',
          kind: 'telegram',
          tokenRef: 'env:OTHER',
          chatId: '42',
          maxPerMinute: 10,
          enabled: true,
        },
      ]);
      expect(listActiveRules(db).map((r) => r.id)).toEqual(['stuck']);
      expect(db.prepare("SELECT enabled FROM alert_rules WHERE id = 'cost-5'").pluck().get()).toBe(
        0,
      );

      // An empty file disables everything and deletes nothing.
      syncAlertsConfig(db, { targets: [], rules: [] }, T2);
      expect(listTargets(db).map((t) => [t.id, t.enabled])).toEqual([
        ['tg-main', false],
        ['tg-two', false],
      ]);
      expect(listActiveRules(db)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) FROM alert_rules').pluck().get()).toBe(2);
    });

    it('re-enables a target that comes back to the file', () => {
      syncAlertsConfig(db, baseConfig(), T0);
      syncAlertsConfig(db, { targets: [], rules: [] }, T1);
      syncAlertsConfig(db, baseConfig(), T2);
      expect(listTargets(db)[0]?.enabled).toBe(true);
    });

    it('keeps armed_at on an edit and resets it only on a disabled -> enabled transition', () => {
      syncAlertsConfig(db, baseConfig(), T0);

      // Edited kind, threshold and target while enabled: armed_at stays.
      const edited: AlertsConfig = {
        targets: [
          ...baseConfig().targets,
          { id: 'tg-two', kind: 'telegram', tokenRef: 'env:OTHER', chatId: '42' },
        ],
        rules: [
          { id: 'cost-5', kind: 'error', targetId: 'tg-two' },
          { id: 'stuck', kind: 'cost_threshold', targetId: 'tg-main', thresholdUsd: 9.5 },
        ],
      };
      syncAlertsConfig(db, edited, T1);
      expect(listActiveRules(db)).toEqual([
        {
          id: 'cost-5',
          kind: 'error',
          targetId: 'tg-two',
          thresholdUsd: null,
          enabled: true,
          armedAt: T0,
        },
        {
          id: 'stuck',
          kind: 'cost_threshold',
          targetId: 'tg-main',
          thresholdUsd: 9.5,
          enabled: true,
          armedAt: T0,
        },
      ]);

      // Disabled explicitly: armed_at untouched while disabled.
      const disabled: AlertsConfig = {
        ...edited,
        rules: [
          { id: 'cost-5', kind: 'error', targetId: 'tg-two', enabled: false },
          edited.rules[1]!,
        ],
      };
      syncAlertsConfig(db, disabled, T1);
      expect(db.prepare("SELECT armed_at FROM alert_rules WHERE id = 'cost-5'").pluck().get()).toBe(
        T0,
      );

      // Re-enabled: re-armed at now. The always-enabled rule keeps T0.
      syncAlertsConfig(db, edited, T2);
      expect(listActiveRules(db).map((r) => [r.id, r.armedAt])).toEqual([
        ['cost-5', T2],
        ['stuck', T0],
      ]);
    });

    it('re-arms a rule that was dropped from the file and comes back', () => {
      syncAlertsConfig(db, baseConfig(), T0);
      syncAlertsConfig(db, { targets: baseConfig().targets, rules: [] }, T1);
      syncAlertsConfig(db, baseConfig(), T2);
      expect(listActiveRules(db).map((r) => r.armedAt)).toEqual([T2, T2]);
    });

    it('is atomic: a failing rule rolls back the targets written before it', () => {
      expect(() =>
        syncAlertsConfig(
          db,
          {
            targets: baseConfig().targets,
            rules: [{ id: 'orphan', kind: 'error', targetId: 'no-such-target' }],
          },
          T0,
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(listTargets(db)).toEqual([]);
    });

    it('lists only rules whose target is enabled', () => {
      syncAlertsConfig(db, baseConfig(), T0);
      db.prepare("UPDATE webhook_targets SET enabled = 0 WHERE id = 'tg-main'").run();
      expect(listActiveRules(db)).toEqual([]);
    });
  });

  describe('alert events and deliveries', () => {
    beforeEach(() => {
      syncAlertsConfig(db, baseConfig(), T0);
    });

    it('records an event plus one pending delivery due at firedAt, with a null agent for cost', () => {
      const payload = costPayload('s1', T1);
      const id = recordAlertEvent(db, {
        ruleId: 'cost-5',
        targetId: 'tg-main',
        dedupeKey: 'cost-5:s1',
        payload,
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        db
          .prepare(
            'SELECT id, rule_id, session_id, agent_id, fired_at, dedupe_key, payload FROM alert_events',
          )
          .all(),
      ).toEqual([
        {
          id,
          rule_id: 'cost-5',
          session_id: 's1',
          agent_id: null,
          fired_at: T1,
          dedupe_key: 'cost-5:s1',
          payload: JSON.stringify(payload),
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT target_id, alert_event_id, status, attempt_count, next_retry_at, delivered_at, last_error
               FROM webhook_deliveries`,
          )
          .all(),
      ).toEqual([
        {
          target_id: 'tg-main',
          alert_event_id: id,
          status: 'pending',
          attempt_count: 0,
          next_retry_at: T1,
          delivered_at: null,
          last_error: null,
        },
      ]);
      expect(alertEventExists(db, 'cost-5:s1')).toBe(true);
      expect(alertEventExists(db, 'cost-5:s2')).toBe(false);
    });

    it('stores the agent id for an agent-scoped kind', () => {
      recordAlertEvent(db, {
        ruleId: 'stuck',
        targetId: 'tg-main',
        dedupeKey: 'stuck:a1',
        payload: stuckPayload('a1', T1),
      });
      expect(db.prepare('SELECT agent_id FROM alert_events').pluck().get()).toBe('a1');
    });

    it('returns null and inserts nothing on a dedupe-key conflict', () => {
      const event = {
        ruleId: 'cost-5',
        targetId: 'tg-main',
        dedupeKey: 'cost-5:s1',
        payload: costPayload('s1', T1),
      };
      expect(recordAlertEvent(db, event)).not.toBeNull();
      expect(recordAlertEvent(db, { ...event, payload: costPayload('s1', T2) })).toBeNull();
      expect(db.prepare('SELECT COUNT(*) FROM alert_events').pluck().get()).toBe(1);
      expect(countDeliveries(db)).toEqual({ pending: 1, sent: 0, failed: 0 });
    });

    it('rolls the event back when its delivery cannot be written', () => {
      expect(() =>
        recordAlertEvent(db, {
          ruleId: 'cost-5',
          targetId: 'no-such-target',
          dedupeKey: 'cost-5:s1',
          payload: costPayload('s1', T1),
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(alertEventExists(db, 'cost-5:s1')).toBe(false);
    });

    it('lists due deliveries ordered by next_retry_at then id, honouring the limit', () => {
      const late = recordAlertEvent(db, {
        ruleId: 'stuck',
        targetId: 'tg-main',
        dedupeKey: 'stuck:late',
        payload: stuckPayload('late', T2),
      });
      const early = recordAlertEvent(db, {
        ruleId: 'cost-5',
        targetId: 'tg-main',
        dedupeKey: 'cost-5:s1',
        payload: costPayload('s1', T0),
      });
      const mid = recordAlertEvent(db, {
        ruleId: 'stuck',
        targetId: 'tg-main',
        dedupeKey: 'stuck:mid',
        payload: stuckPayload('mid', T1),
      });
      // Two deliveries due at the same instant tie-break on id.
      const tieA = recordAlertEvent(db, {
        ruleId: 'stuck',
        targetId: 'tg-main',
        dedupeKey: 'stuck:tie',
        payload: stuckPayload('tie', T1),
      });
      db.prepare("UPDATE webhook_deliveries SET id = 'zzz' WHERE alert_event_id = ?").run(mid);
      db.prepare("UPDATE webhook_deliveries SET id = 'aaa' WHERE alert_event_id = ?").run(tieA);

      const due = listDueDeliveries(db, T1, 10);
      expect(due.map((d) => d.notification.alertEventId)).toEqual([early, tieA, mid]);
      expect(due.map((d) => d.deliveryId).slice(1)).toEqual(['aaa', 'zzz']);
      expect(due[0]).toEqual({
        deliveryId: expect.any(String) as string,
        targetId: 'tg-main',
        attemptCount: 0,
        notification: { ...costPayload('s1', T0), alertEventId: early },
      });

      expect(listDueDeliveries(db, T1, 1).map((d) => d.notification.alertEventId)).toEqual([early]);
      expect(listDueDeliveries(db, T2, 10).map((d) => d.notification.alertEventId)).toEqual([
        early,
        tieA,
        mid,
        late,
      ]);
      expect(listDueDeliveries(db, '2026-10-24T09:59:59.999Z', 10)).toEqual([]);
    });

    it('skips deliveries that are no longer pending and re-lists a retry once it is due', () => {
      const a = recordAlertEvent(db, {
        ruleId: 'cost-5',
        targetId: 'tg-main',
        dedupeKey: 'cost-5:s1',
        payload: costPayload('s1', T0),
      });
      const b = recordAlertEvent(db, {
        ruleId: 'cost-5',
        targetId: 'tg-main',
        dedupeKey: 'cost-5:s2',
        payload: costPayload('s2', T0),
      });
      const [first, second] = listDueDeliveries(db, T0, 10).sort((x, y) =>
        x.notification.alertEventId === a ? -1 : y.notification.alertEventId === a ? 1 : 0,
      );
      markDeliverySent(db, first!.deliveryId, 1, T0);
      markDeliveryRetry(db, second!.deliveryId, 1, T2, 'HTTP 429');

      expect(listDueDeliveries(db, T1, 10)).toEqual([]);
      const retried = listDueDeliveries(db, T2, 10);
      expect(retried.map((d) => [d.notification.alertEventId, d.attemptCount])).toEqual([[b, 1]]);
    });

    it('marks sent, retry and failed, each only from pending', () => {
      const ids = ['s1', 's2', 's3'].map((session) =>
        recordAlertEvent(db, {
          ruleId: 'cost-5',
          targetId: 'tg-main',
          dedupeKey: `cost-5:${session}`,
          payload: costPayload(session, T0),
        }),
      );
      const deliveryOf = (eventId: string | null): string =>
        db
          .prepare('SELECT id FROM webhook_deliveries WHERE alert_event_id = ?')
          .pluck()
          .get(eventId) as string;
      const [sent, retried, failed] = ids.map(deliveryOf) as [string, string, string];

      markDeliveryRetry(db, retried, 1, T1, 'HTTP 502');
      expect(deliveryRow(db, retried)).toEqual({
        status: 'pending',
        attempt_count: 1,
        next_retry_at: T1,
        delivered_at: null,
        last_error: 'HTTP 502',
      });
      markDeliverySent(db, retried, 2, T1);
      expect(deliveryRow(db, retried)).toEqual({
        status: 'sent',
        attempt_count: 2,
        next_retry_at: null,
        delivered_at: T1,
        last_error: null,
      });

      markDeliverySent(db, sent, 1, T0);
      markDeliveryFailed(db, failed, 5, 'HTTP 403');
      expect(deliveryRow(db, failed)).toEqual({
        status: 'failed',
        attempt_count: 5,
        next_retry_at: null,
        delivered_at: null,
        last_error: 'HTTP 403',
      });
      expect(countDeliveries(db)).toEqual({ pending: 0, sent: 2, failed: 1 });

      // No-ops once a row has left pending.
      const sentBefore = deliveryRow(db, sent);
      const failedBefore = deliveryRow(db, failed);
      markDeliveryFailed(db, sent, 9, 'late failure');
      markDeliveryRetry(db, sent, 9, T2, 'late retry');
      markDeliverySent(db, failed, 9, T2);
      markDeliveryRetry(db, failed, 9, T2, 'late retry');
      expect(deliveryRow(db, sent)).toEqual(sentBefore);
      expect(deliveryRow(db, failed)).toEqual(failedBefore);
    });

    it('counts deliveries by status, zero when empty', () => {
      expect(countDeliveries(db)).toEqual({ pending: 0, sent: 0, failed: 0 });
    });

    it('counts only sent deliveries of the target inside the throttle window', () => {
      syncAlertsConfig(
        db,
        {
          ...baseConfig(),
          targets: [
            ...baseConfig().targets,
            { id: 'tg-two', kind: 'telegram', tokenRef: 'env:OTHER', chatId: '42' },
          ],
        },
        T0,
      );
      const record = (session: string, targetId: string): string => {
        recordAlertEvent(db, {
          ruleId: 'cost-5',
          targetId,
          dedupeKey: `cost-5:${session}`,
          payload: costPayload(session, T0),
        });
        return db
          .prepare(
            `SELECT d.id FROM webhook_deliveries d JOIN alert_events e ON e.id = d.alert_event_id
              WHERE e.dedupe_key = ?`,
          )
          .pluck()
          .get(`cost-5:${session}`) as string;
      };
      markDeliverySent(db, record('old', 'tg-main'), 1, '2026-10-24T10:58:59.999Z');
      markDeliverySent(db, record('edge', 'tg-main'), 1, '2026-10-24T10:59:00.000Z');
      markDeliverySent(db, record('new', 'tg-main'), 1, T1);
      markDeliverySent(db, record('other', 'tg-two'), 1, T1);
      markDeliveryFailed(db, record('failed', 'tg-main'), 1, 'HTTP 400');
      record('pending', 'tg-main');

      expect(countSentSince(db, 'tg-main', '2026-10-24T10:59:00.000Z')).toBe(2);
      expect(countSentSince(db, 'tg-main', T0)).toBe(3);
      expect(countSentSince(db, 'tg-two', T0)).toBe(1);
      expect(countSentSince(db, 'tg-main', T2)).toBe(0);
    });
  });
});
