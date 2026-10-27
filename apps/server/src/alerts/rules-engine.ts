/**
 * WP-A5 - the rules engine: turns the projection into alert events.
 *
 * One pass evaluates every active rule (enabled, and its target enabled) over
 * the current projection and records an `alert_events` row - plus its pending
 * delivery - for each subject that meets the rule's condition (AD-5):
 *
 *   cost_threshold  a session whose priced cost is >= `thresholdUsd`
 *   stuck_agent     an agent the watchdog moved to `unknown`
 *   error           an agent whose status resolved to `error`
 *
 * EXACTLY ONCE PER SUBJECT (AD-6). The dedupe key is `<ruleId>:<subjectId>`
 * (session id for a cost rule, agent id otherwise) and `alert_events` holds it
 * UNIQUE, so re-evaluating the same projection on the next tick records
 * nothing: a condition that stays true is one notification, not one per tick.
 *
 * NO HISTORY FLOOD. A rule only considers subjects active at or after its
 * `armed_at` (the instant it was created or re-enabled): turning alerting on
 * over a corpus with months of sessions must not page the operator for every
 * old one. Activity is the session's `last_activity_at` for a cost rule and
 * the agent's `last_seen_at` otherwise - so an agent last seen before the rule
 * was armed is not reported even if the watchdog sweeps it later.
 *
 * Synchronous: the projection lives in better-sqlite3. Bounded: at most
 * `MAX_EVENTS_PER_RULE_PER_PASS` new events per rule per pass; the remainder
 * is picked up by the next pass, because dedupe makes that safe.
 */
import type { SqliteDatabase } from '../db/connection';
import {
  listActiveRules,
  recordAlertEvent,
  type AlertRuleRow,
  type NewAlertEvent,
} from '../db/alerts';
import { listSessionCostsAtLeast } from '../api/queries';

export const MAX_EVENTS_PER_RULE_PER_PASS = 50;

/** The `alert_events.dedupe_key` for one rule and one subject (AD-6). */
export function dedupeKey(ruleId: string, subjectId: string): string {
  return `${ruleId}:${subjectId}`;
}

interface AgentSubjectRow {
  readonly id: string;
  readonly session_id: string;
  readonly last_seen_at: string;
}

/**
 * Evaluate every active rule once. Returns the number of NEW alert events
 * recorded (0 when every true condition had already fired).
 */
export function evaluateAlertRules(db: SqliteDatabase, nowIso: string): number {
  let recorded = 0;
  for (const rule of listActiveRules(db)) {
    recorded +=
      rule.kind === 'cost_threshold'
        ? evaluateCostRule(db, rule, nowIso)
        : evaluateAgentStatusRule(db, rule, nowIso);
  }
  return recorded;
}

function evaluateCostRule(db: SqliteDatabase, rule: AlertRuleRow, nowIso: string): number {
  // The CHECK on alert_rules guarantees a cost rule carries a threshold.
  const thresholdUsd = rule.thresholdUsd as number;
  let recorded = 0;
  for (const { sessionId, costUsd } of listSessionCostsAtLeast(db, rule.armedAt, thresholdUsd)) {
    if (recorded >= MAX_EVENTS_PER_RULE_PER_PASS) break;
    // A session that already fired is rejected by the UNIQUE dedupe key.
    recorded += record(db, {
      ruleId: rule.id,
      targetId: rule.targetId,
      dedupeKey: dedupeKey(rule.id, sessionId),
      payload: {
        kind: 'cost_threshold',
        ruleId: rule.id,
        sessionId,
        firedAt: nowIso,
        costUsd,
        thresholdUsd,
      },
    });
  }
  return recorded;
}

function evaluateAgentStatusRule(db: SqliteDatabase, rule: AlertRuleRow, nowIso: string): number {
  const status = rule.kind === 'stuck_agent' ? 'unknown' : 'error';
  // Already-alerted agents are filtered in SQL, so the LIMIT bounds NEW work.
  const rows = db
    .prepare(
      `SELECT a.id, a.session_id, a.last_seen_at
       FROM agents a
       WHERE a.status = ?
         AND a.last_seen_at >= ?
         AND NOT EXISTS (SELECT 1 FROM alert_events e WHERE e.dedupe_key = ? || ':' || a.id)
       ORDER BY a.last_seen_at, a.id
       LIMIT ?`,
    )
    .all(status, rule.armedAt, rule.id, MAX_EVENTS_PER_RULE_PER_PASS) as AgentSubjectRow[];
  let recorded = 0;
  for (const row of rows) {
    const base = { ruleId: rule.id, sessionId: row.session_id, firedAt: nowIso, agentId: row.id };
    recorded += record(db, {
      ruleId: rule.id,
      targetId: rule.targetId,
      dedupeKey: dedupeKey(rule.id, row.id),
      payload:
        rule.kind === 'stuck_agent'
          ? { ...base, kind: 'stuck_agent', lastSeenAt: row.last_seen_at }
          : { ...base, kind: 'error' },
    });
  }
  return recorded;
}

/** 1 when the event was recorded, 0 when its dedupe key had already fired. */
function record(db: SqliteDatabase, event: NewAlertEvent): number {
  return recordAlertEvent(db, event) === null ? 0 : 1;
}
