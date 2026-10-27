/**
 * The alerting service (v2.0, AD-1): config sync, rules engine and delivery
 * loop, composed on one timer. Started only when `DASHBOARD_ALERTS_CONFIG`
 * names a file - with it unset the server builds none of this and nothing in
 * the process can dial out.
 *
 * Boot order: sync the file into `webhook_targets` / `alert_rules` (AD-2),
 * prove every enabled target's `tokenRef` resolves - a missing env variable or
 * a world-readable token file fails startup loudly, the value itself is
 * dropped at once (AD-3) - then build one sink per target and start the timer.
 *
 * Each tick evaluates the rules over the projection, then runs one delivery
 * pass. A tick that throws is logged and the next one tries again: alerting
 * must never take the dashboard down with it. The timer is `unref`-ed and
 * single-flight (a slow send never stacks passes).
 */
import type { AlertSinkPort, AlertsConfig } from '@agenthropic/shared';
import type { SqliteDatabase } from '../db/connection';
import { syncAlertsConfig } from '../db/alerts';
import { createAlertDispatcher, type DispatchSummary } from './dispatcher';
import { evaluateAlertRules } from './rules-engine';
import { createTelegramSink } from './telegram-sink';
import { resolveTokenRef } from './token-ref';

export { loadAlertsConfig } from './load-config';

export interface AlertingDeps {
  readonly db: SqliteDatabase;
  readonly config: AlertsConfig;
  readonly intervalMs: number;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
  /** Test seam; production resolves `env:` / `file:` refs (WP-A3). */
  readonly resolveToken?: (ref: string) => string;
  /** Test seam; production builds the Telegram sink (WP-A6). */
  readonly createSink?: (target: AlertsConfig['targets'][number]) => AlertSinkPort;
}

export interface AlertTickResult {
  readonly fired: number;
  /** null when a previous delivery pass was still in flight. */
  readonly delivery: DispatchSummary | null;
}

export interface AlertingService {
  /** One tick by hand (tests). */
  tick(): Promise<AlertTickResult>;
  /**
   * Clear the timer and resolve once every tick already in flight has settled
   * (a failed one included - the timer path logs it). Shutdown awaits this
   * before closing the DB: a send that finished after the close could not be
   * marked sent and would go out again on the next boot. Idempotent.
   */
  stop(): Promise<void>;
}

export function startAlerting(deps: AlertingDeps): AlertingService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const logError = deps.logError ?? (() => undefined);
  const resolveToken = deps.resolveToken ?? ((ref: string) => resolveTokenRef(ref));
  const createSink =
    deps.createSink ??
    ((target) =>
      createTelegramSink({
        targetId: target.id,
        chatId: target.chatId,
        tokenRef: target.tokenRef,
        resolveToken,
      }));

  for (const target of deps.config.targets) {
    try {
      resolveToken(target.tokenRef);
    } catch (error) {
      throw new Error(
        `Alert target "${target.id}": tokenRef ${target.tokenRef} does not resolve - ${(error as Error).message}`,
      );
    }
  }
  syncAlertsConfig(deps.db, deps.config, now().toISOString());
  const sinks = new Map(deps.config.targets.map((t) => [t.id, createSink(t)] as const));
  const dispatcher = createAlertDispatcher({ db: deps.db, sinks, now, log });

  const inFlight = new Set<Promise<AlertTickResult>>();

  async function runTick(): Promise<AlertTickResult> {
    const fired = evaluateAlertRules(deps.db, now().toISOString());
    if (fired > 0) log(`alerts: ${fired} new alert event(s).`);
    return { fired, delivery: await dispatcher.runOnce() };
  }

  function tick(): Promise<AlertTickResult> {
    const running = runTick();
    inFlight.add(running);
    const forget = (): void => {
      inFlight.delete(running);
    };
    running.then(forget, forget);
    return running;
  }

  const timer = setInterval(() => {
    tick().catch((error: unknown) => {
      logError(`alerts tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, deps.intervalMs);
  timer.unref();
  log(
    `alerts: enabled - ${deps.config.targets.length} target(s), ` +
      `${deps.config.rules.filter((r) => r.enabled !== false).length} active rule(s).`,
  );

  return {
    tick,
    async stop() {
      clearInterval(timer);
      await Promise.allSettled(inFlight);
    },
  };
}
