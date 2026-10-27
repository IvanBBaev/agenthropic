/**
 * WP-A5 - the rules engine over the real projection: each rule kind fires
 * once per subject (AD-6), only for subjects active since the rule was armed
 * (no history flood), at most MAX_EVENTS_PER_RULE_PER_PASS per rule per pass,
 * and a cost rule prices through the single pricing CTE (WP-C1) at exactly
 * the threshold.
 */
import type { AlertsConfig } from '@agenthropic/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSessionCostsAtLeast } from '../src/api/queries';
import { listDueDeliveries, syncAlertsConfig } from '../src/db/alerts';
import type { SqliteDatabase } from '../src/db/connection';
import {
  dedupeKey,
  evaluateAlertRules,
  MAX_EVENTS_PER_RULE_PER_PASS,
} from '../src/alerts/rules-engine';
import { createMigratedTempDb, type TempDb } from './helpers';

const ARMED = '2026-07-10T00:00:00.000Z';
const BEFORE_ARMED = '2026-07-01T00:00:00.000Z';
const AFTER_ARMED = '2026-07-10T02:00:00.000Z';
const NOW = '2026-07-10T03:00:00.000Z';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

const TARGET = {
  id: 'ops',
  kind: 'telegram',
  tokenRef: 'env:ALERT_TOKEN',
  chatId: '12345',
} as const;

function configWith(rules: AlertsConfig['rules']): AlertsConfig {
  return { targets: [TARGET], rules };
}

/** A session with `usd` of fable input usage ($10/Mtok, so 100k tokens = $1). */
function sessionCosting(
  db: SqliteDatabase,
  id: string,
  usd: number,
  lastActivityAt = AFTER_ARMED,
): void {
  db.prepare(
    `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
     VALUES (?, 'p', ?, ?, 'active')`,
  ).run(id, lastActivityAt, lastActivityAt);
  db.prepare(
    `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
     VALUES (?, NULL, ?, 'claude-fable-5', 'input', ?, ?)`,
  ).run(id, `m-${id}`, usd * 100_000, lastActivityAt);
}

function agentWith(
  db: SqliteDatabase,
  id: string,
  status: string,
  lastSeenAt = AFTER_ARMED,
  sessionId = 's1',
): void {
  db.prepare(
    `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES (?, ?, 'subagent', 'explorer', ?, NULL, ?, ?)`,
  ).run(id, sessionId, status, lastSeenAt, lastSeenAt);
}

function notifications(db: SqliteDatabase) {
  return listDueDeliveries(db, FAR_FUTURE, 1000).map((d) => d.notification);
}

describe('alert rules engine (WP-A5)', () => {
  let temp: TempDb;
  let db: SqliteDatabase;

  beforeEach(() => {
    temp = createMigratedTempDb();
    db = temp.db;
  });
  afterEach(() => temp.cleanup());

  it('builds the dedupe key as <ruleId>:<subjectId>', () => {
    expect(dedupeKey('big-spend', 's-1')).toBe('big-spend:s-1');
  });

  it('records nothing without active rules', () => {
    sessionCosting(db, 's-a', 9);
    syncAlertsConfig(db, configWith([]), ARMED);
    expect(evaluateAlertRules(db, NOW)).toBe(0);
  });

  describe('cost_threshold', () => {
    it('fires at exactly the threshold, not below it, once per session', () => {
      sessionCosting(db, 's-at', 3);
      sessionCosting(db, 's-below', 2);
      sessionCosting(db, 's-above', 5);
      syncAlertsConfig(
        db,
        configWith([{ id: 'spend', kind: 'cost_threshold', targetId: 'ops', thresholdUsd: 3 }]),
        ARMED,
      );

      expect(evaluateAlertRules(db, NOW)).toBe(2);
      const fired = notifications(db);
      expect(fired.map((n) => n.sessionId).sort()).toEqual(['s-above', 's-at']);
      const atThreshold = fired.find((n) => n.sessionId === 's-at');
      expect(atThreshold).toMatchObject({
        kind: 'cost_threshold',
        ruleId: 'spend',
        firedAt: NOW,
        thresholdUsd: 3,
      });
      expect(atThreshold?.kind === 'cost_threshold' && atThreshold.costUsd).toBeCloseTo(3, 9);

      // The condition still holds on the next tick: nothing new (AD-6).
      expect(evaluateAlertRules(db, NOW)).toBe(0);
      expect(notifications(db)).toHaveLength(2);
    });

    it('ignores sessions last active before the rule was armed', () => {
      sessionCosting(db, 's-old', 50, BEFORE_ARMED);
      sessionCosting(db, 's-new', 5);
      syncAlertsConfig(
        db,
        configWith([{ id: 'spend', kind: 'cost_threshold', targetId: 'ops', thresholdUsd: 1 }]),
        ARMED,
      );
      expect(evaluateAlertRules(db, NOW)).toBe(1);
      expect(notifications(db).map((n) => n.sessionId)).toEqual(['s-new']);
    });

    it('caps new events per rule per pass and picks up the rest on the next pass', () => {
      const total = MAX_EVENTS_PER_RULE_PER_PASS + 3;
      for (let i = 0; i < total; i++) sessionCosting(db, `s-${String(i).padStart(3, '0')}`, 2);
      syncAlertsConfig(
        db,
        configWith([{ id: 'spend', kind: 'cost_threshold', targetId: 'ops', thresholdUsd: 1 }]),
        ARMED,
      );
      expect(evaluateAlertRules(db, NOW)).toBe(MAX_EVENTS_PER_RULE_PER_PASS);
      expect(evaluateAlertRules(db, NOW)).toBe(3);
      expect(evaluateAlertRules(db, NOW)).toBe(0);
    });

    it('lets two rules fire independently for the same session', () => {
      sessionCosting(db, 's-a', 5);
      syncAlertsConfig(
        db,
        configWith([
          { id: 'spend-1', kind: 'cost_threshold', targetId: 'ops', thresholdUsd: 1 },
          { id: 'spend-4', kind: 'cost_threshold', targetId: 'ops', thresholdUsd: 4 },
        ]),
        ARMED,
      );
      expect(evaluateAlertRules(db, NOW)).toBe(2);
    });
  });

  describe('stuck_agent and error', () => {
    beforeEach(() => {
      sessionCosting(db, 's1', 0);
    });

    it('stuck_agent fires for an unknown agent seen since arming, with its last-seen instant', () => {
      agentWith(db, 'a-stuck', 'unknown');
      agentWith(db, 'a-old', 'unknown', BEFORE_ARMED);
      agentWith(db, 'a-working', 'working');
      agentWith(db, 'a-error', 'error');
      syncAlertsConfig(
        db,
        configWith([{ id: 'stuck', kind: 'stuck_agent', targetId: 'ops' }]),
        ARMED,
      );

      expect(evaluateAlertRules(db, NOW)).toBe(1);
      expect(notifications(db)).toEqual([
        expect.objectContaining({
          kind: 'stuck_agent',
          ruleId: 'stuck',
          sessionId: 's1',
          agentId: 'a-stuck',
          lastSeenAt: AFTER_ARMED,
          firedAt: NOW,
        }),
      ]);
      expect(evaluateAlertRules(db, NOW)).toBe(0);
    });

    it('error fires for an errored agent seen since arming', () => {
      agentWith(db, 'a-error', 'error');
      agentWith(db, 'a-stuck', 'unknown');
      syncAlertsConfig(db, configWith([{ id: 'errors', kind: 'error', targetId: 'ops' }]), ARMED);

      expect(evaluateAlertRules(db, NOW)).toBe(1);
      const [only] = notifications(db);
      expect(only).toMatchObject({
        kind: 'error',
        ruleId: 'errors',
        sessionId: 's1',
        agentId: 'a-error',
      });
      expect(only).not.toHaveProperty('lastSeenAt');
    });

    it('caps new agent events per pass, then drains the remainder', () => {
      for (let i = 0; i < MAX_EVENTS_PER_RULE_PER_PASS + 1; i++) {
        agentWith(db, `a-${String(i).padStart(3, '0')}`, 'error');
      }
      syncAlertsConfig(db, configWith([{ id: 'errors', kind: 'error', targetId: 'ops' }]), ARMED);
      expect(evaluateAlertRules(db, NOW)).toBe(MAX_EVENTS_PER_RULE_PER_PASS);
      expect(evaluateAlertRules(db, NOW)).toBe(1);
      expect(evaluateAlertRules(db, NOW)).toBe(0);
    });

    it('skips a disabled rule', () => {
      agentWith(db, 'a-error', 'error');
      syncAlertsConfig(
        db,
        configWith([{ id: 'errors', kind: 'error', targetId: 'ops', enabled: false }]),
        ARMED,
      );
      expect(evaluateAlertRules(db, NOW)).toBe(0);
    });
  });
});

describe('listSessionCostsAtLeast (WP-A5 cost source)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });
  afterEach(() => temp.cleanup());

  it('returns sessions active since the cutoff whose priced cost reaches the floor, ordered by id', () => {
    sessionCosting(temp.db, 's-b', 4);
    sessionCosting(temp.db, 's-a', 2);
    sessionCosting(temp.db, 's-cheap', 1);
    sessionCosting(temp.db, 's-old', 9, BEFORE_ARMED);
    const rows = listSessionCostsAtLeast(temp.db, ARMED, 2);
    expect(rows.map((r) => r.sessionId)).toEqual(['s-a', 's-b']);
    expect(rows[0]?.costUsd).toBeCloseTo(2, 9);
    expect(rows[1]?.costUsd).toBeCloseTo(4, 9);
  });

  it('returns nothing on an empty corpus', () => {
    expect(listSessionCostsAtLeast(temp.db, ARMED, 0)).toEqual([]);
  });
});
