/**
 * WP-A1 - the alerting domain contract (v2.0, roadmap §6; decisions AD-1..AD-7
 * in TODO.md). Two halves live here:
 *
 * 1. The operator config file (`DASHBOARD_ALERTS_CONFIG`, AD-2). WP-A8/A9 were
 *    cut, so the file IS the operator surface: targets plus rules, validated
 *    against `AlertsConfigSchema` at startup. It never carries a secret - a
 *    target names its bot token by reference (`tokenRef`, AD-3), and no field
 *    anywhere admits a URL (AD-4: the Telegram host is a constant in code).
 * 2. The notification a rule firing hands to an `AlertSink` (ports/alert-sink).
 *
 * Every object is `additionalProperties: false`: an unknown key in the config
 * file is a typo the operator must hear about, not a setting silently ignored.
 */
import { Type, type Static } from '@sinclair/typebox';

/** The three rule kinds WP-A5 fixes (AD-5). Mirrors the `alert_rules.kind` CHECK. */
export const AlertKindSchema = Type.Union([
  Type.Literal('cost_threshold'),
  Type.Literal('stuck_agent'),
  Type.Literal('error'),
]);

export type AlertKind = Static<typeof AlertKindSchema>;

/** Delivery target kinds. Telegram only (AD-4); mirrors the `webhook_targets.kind` CHECK. */
export const AlertTargetKindSchema = Type.Literal('telegram');

export type AlertTargetKind = Static<typeof AlertTargetKindSchema>;

/**
 * Operator-chosen identifier for a target or a rule: lower-case, URL-free,
 * short. It doubles as the primary key and as half of every `dedupe_key`, so
 * it must be stable across edits of the config file.
 */
export const ALERT_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$';

/**
 * Where a secret is resolved from (AD-3, CD-10). `env:NAME` reads the process
 * environment (launchd); `file:/abs/path` reads a file whose mode has no
 * group/other bits. The pattern only fixes the grammar - the permission check
 * is the resolver's job (WP-A3), because a schema cannot stat a file.
 */
export const TOKEN_REF_PATTERN = '^(env:[A-Za-z_][A-Za-z0-9_]*|file:/[^\\0]+)$';

/** Upper bound for a target's throttle (AD-6): Telegram's own per-chat limit is ~1/s. */
export const MAX_ALERTS_PER_MINUTE = 60;

/** Default throttle when a target omits `maxPerMinute` (AD-6). */
export const DEFAULT_ALERTS_PER_MINUTE = 10;

export const TelegramTargetConfigSchema = Type.Object(
  {
    id: Type.String({ pattern: ALERT_ID_PATTERN }),
    kind: AlertTargetKindSchema,
    tokenRef: Type.String({ pattern: TOKEN_REF_PATTERN }),
    /** Telegram chat id: a numeric id (negative for groups) or an `@channel` name. */
    chatId: Type.String({ pattern: '^(-?[0-9]{1,20}|@[A-Za-z0-9_]{5,32})$' }),
    maxPerMinute: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ALERTS_PER_MINUTE })),
  },
  { additionalProperties: false },
);

export type TelegramTargetConfig = Static<typeof TelegramTargetConfigSchema>;

const ruleBase = {
  id: Type.String({ pattern: ALERT_ID_PATTERN }),
  /** The `TelegramTargetConfig.id` this rule delivers through. */
  targetId: Type.String({ pattern: ALERT_ID_PATTERN }),
  enabled: Type.Optional(Type.Boolean()),
};

/** Fires once per session when its priced cost reaches `thresholdUsd` (>=, AD-5). */
export const CostThresholdRuleConfigSchema = Type.Object(
  {
    ...ruleBase,
    kind: Type.Literal('cost_threshold'),
    thresholdUsd: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: false },
);

/** Fires once per agent the watchdog moved to `unknown` (AD-5). */
export const StuckAgentRuleConfigSchema = Type.Object(
  { ...ruleBase, kind: Type.Literal('stuck_agent') },
  { additionalProperties: false },
);

/** Fires once per agent whose status resolves to `error` (AD-5). */
export const ErrorRuleConfigSchema = Type.Object(
  { ...ruleBase, kind: Type.Literal('error') },
  { additionalProperties: false },
);

export const AlertRuleConfigSchema = Type.Union([
  CostThresholdRuleConfigSchema,
  StuckAgentRuleConfigSchema,
  ErrorRuleConfigSchema,
]);

export type CostThresholdRuleConfig = Static<typeof CostThresholdRuleConfigSchema>;
export type StuckAgentRuleConfig = Static<typeof StuckAgentRuleConfigSchema>;
export type ErrorRuleConfig = Static<typeof ErrorRuleConfigSchema>;
export type AlertRuleConfig = Static<typeof AlertRuleConfigSchema>;

/** The whole operator config file (AD-2). */
export const AlertsConfigSchema = Type.Object(
  {
    targets: Type.Array(TelegramTargetConfigSchema, { maxItems: 16 }),
    rules: Type.Array(AlertRuleConfigSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);

export type AlertsConfig = Static<typeof AlertsConfigSchema>;

/**
 * Cross-reference problems the schema cannot express: duplicate ids and a
 * rule pointing at a target the file does not declare. Returns one sentence
 * per problem (empty = consistent) so a loader can report all of them at once.
 * Callers run it only on a value that already passed `AlertsConfigSchema`.
 */
export function alertsConfigProblems(config: AlertsConfig): string[] {
  const problems: string[] = [];
  const targetIds = new Set<string>();
  for (const target of config.targets) {
    if (targetIds.has(target.id)) problems.push(`duplicate target id "${target.id}"`);
    targetIds.add(target.id);
  }
  const ruleIds = new Set<string>();
  for (const rule of config.rules) {
    if (ruleIds.has(rule.id)) problems.push(`duplicate rule id "${rule.id}"`);
    ruleIds.add(rule.id);
    if (!targetIds.has(rule.targetId)) {
      problems.push(`rule "${rule.id}" names unknown target "${rule.targetId}"`);
    }
  }
  return problems;
}

/**
 * What a firing rule hands to a sink - one variant per `AlertKind`, so a
 * formatter switches exhaustively. Carries ids and figures only: no transcript
 * text, no payload field, nothing a sink could mistake for a URL.
 */
interface NotificationBase {
  /** `alert_events.id` - the unit of dedupe and delivery. */
  alertEventId: string;
  ruleId: string;
  sessionId: string;
  /** ISO-8601 UTC instant the rule fired. */
  firedAt: string;
}

export interface CostThresholdNotification extends NotificationBase {
  kind: 'cost_threshold';
  costUsd: number;
  thresholdUsd: number;
}

export interface StuckAgentNotification extends NotificationBase {
  kind: 'stuck_agent';
  agentId: string;
  /** ISO-8601 UTC instant of the agent's last observed activity. */
  lastSeenAt: string;
}

export interface ErrorNotification extends NotificationBase {
  kind: 'error';
  agentId: string;
}

export type AlertNotification =
  CostThresholdNotification | StuckAgentNotification | ErrorNotification;
