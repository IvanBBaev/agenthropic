/**
 * WP-A7 - the delivery loop: sent / terminal / retryable outcomes, the
 * 30 s x 2^n backoff with a longer server retry_after winning, give-up after
 * MAX_DELIVERY_ATTEMPTS, the per-target throttle that never charges an
 * attempt, a missing sink, a sink that breaks the never-throw contract (its
 * message is never relayed) and single-flight passes.
 */
import type { AlertSinkPort, AlertsConfig, DeliveryOutcome } from '@agenthropic/shared';
import { InMemoryAlertSink } from '@agenthropic/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAlertDispatcher,
  DISPATCH_BATCH_SIZE,
  MAX_DELIVERY_ATTEMPTS,
  retryDelayMs,
  RETRY_BASE_MS,
  THROTTLE_WINDOW_MS,
} from '../src/alerts/dispatcher';
import { countDeliveries, recordAlertEvent, syncAlertsConfig } from '../src/db/alerts';
import type { SqliteDatabase } from '../src/db/connection';
import { createMigratedTempDb, type TempDb } from './helpers';

const T0 = new Date('2026-10-24T10:00:00.000Z');

interface DeliveryRow {
  status: string;
  attempt_count: number;
  next_retry_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
}

function config(maxPerMinute?: number): AlertsConfig {
  return {
    targets: [
      { id: 'ops', kind: 'telegram', tokenRef: 'env:ALERT_TOKEN', chatId: '12345', maxPerMinute },
    ],
    rules: [{ id: 'errors', kind: 'error', targetId: 'ops' }],
  };
}

function fire(db: SqliteDatabase, agentId: string, firedAt = T0): void {
  recordAlertEvent(db, {
    ruleId: 'errors',
    targetId: 'ops',
    dedupeKey: `errors:${agentId}`,
    payload: {
      kind: 'error',
      ruleId: 'errors',
      sessionId: 's1',
      agentId,
      firedAt: firedAt.toISOString(),
    },
  });
}

function rows(db: SqliteDatabase): DeliveryRow[] {
  return db
    .prepare(
      `SELECT d.status, d.attempt_count, d.next_retry_at, d.delivered_at, d.last_error
         FROM webhook_deliveries d JOIN alert_events e ON e.id = d.alert_event_id
        ORDER BY e.agent_id`,
    )
    .all() as DeliveryRow[];
}

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

describe('alert dispatcher (WP-A7)', () => {
  let temp: TempDb;
  let db: SqliteDatabase;
  let clock: Date;
  let logs: string[];
  const now = (): Date => clock;

  function dispatcher(sink: AlertSinkPort | null) {
    const sinks = new Map<string, AlertSinkPort>(sink === null ? [] : [['ops', sink]]);
    return createAlertDispatcher({ db, sinks, now, log: (line) => logs.push(line) });
  }

  beforeEach(() => {
    temp = createMigratedTempDb();
    db = temp.db;
    clock = T0;
    logs = [];
    syncAlertsConfig(db, config(), T0.toISOString());
  });
  afterEach(() => temp.cleanup());

  it('backs off 30 s x 2^(n-1)', () => {
    expect(RETRY_BASE_MS).toBe(30_000);
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
    expect(THROTTLE_WINDOW_MS).toBe(60_000);
    expect(DISPATCH_BATCH_SIZE).toBe(100);
  });

  it('an empty outbox is an empty pass', async () => {
    expect(await dispatcher(new InMemoryAlertSink('ops')).runOnce()).toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
      throttled: 0,
    });
  });

  it('sends a due delivery and stamps it', async () => {
    fire(db, 'a1');
    const sink = new InMemoryAlertSink('ops');
    clock = at(1_000);
    expect(await dispatcher(sink).runOnce()).toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
      throttled: 0,
    });
    expect(sink.sent()).toEqual([expect.objectContaining({ kind: 'error', agentId: 'a1' })]);
    expect(rows(db)).toEqual([
      {
        status: 'sent',
        attempt_count: 1,
        next_retry_at: null,
        delivered_at: at(1_000).toISOString(),
        last_error: null,
      },
    ]);
    expect(logs.some((l) => l.endsWith(': sent'))).toBe(true);
  });

  it('does not send a delivery that is not yet due', async () => {
    fire(db, 'a1', at(5_000));
    const sink = new InMemoryAlertSink('ops');
    expect((await dispatcher(sink).runOnce())?.sent).toBe(0);
    expect(sink.sent()).toEqual([]);
  });

  it('fails a terminal outcome at once with its reason', async () => {
    fire(db, 'a1');
    const sink = new InMemoryAlertSink('ops', [{ kind: 'terminal', reason: 'http 400' }]);
    expect((await dispatcher(sink).runOnce())?.failed).toBe(1);
    expect(rows(db)[0]).toMatchObject({
      status: 'failed',
      attempt_count: 1,
      last_error: 'http 400',
    });
  });

  it('retries with exponential backoff and gives up after the last attempt', async () => {
    fire(db, 'a1');
    const sink = new InMemoryAlertSink('ops', [{ kind: 'retryable', reason: 'http 502' }]);
    const d = dispatcher(sink);

    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      expect((await d.runOnce())?.retried).toBe(1);
      const row = rows(db)[0] as DeliveryRow;
      const next = new Date(clock.getTime() + retryDelayMs(attempt));
      expect(row).toMatchObject({
        status: 'pending',
        attempt_count: attempt,
        next_retry_at: next.toISOString(),
        last_error: 'http 502',
      });
      // One millisecond early: not due, not attempted.
      clock = new Date(next.getTime() - 1);
      expect((await d.runOnce())?.retried).toBe(0);
      clock = next;
    }

    expect((await d.runOnce())?.failed).toBe(1);
    expect(rows(db)[0]).toMatchObject({
      status: 'failed',
      attempt_count: MAX_DELIVERY_ATTEMPTS,
      next_retry_at: null,
      last_error: `http 502; gave up after ${MAX_DELIVERY_ATTEMPTS} attempts`,
    });
    expect(sink.sent()).toHaveLength(MAX_DELIVERY_ATTEMPTS);
  });

  it('honours a server retry_after longer than the backoff, but never a shorter one', async () => {
    fire(db, 'a1');
    fire(db, 'a2');
    const outcomes: DeliveryOutcome[] = [
      { kind: 'retryable', reason: 'http 429', retryAfterMs: 120_000 },
      { kind: 'retryable', reason: 'http 429', retryAfterMs: 1_000 },
    ];
    await dispatcher(new InMemoryAlertSink('ops', outcomes)).runOnce();
    // Delivery order follows the random delivery id, so compare as a set.
    expect(
      rows(db)
        .map((r) => r.next_retry_at)
        .sort(),
    ).toEqual([at(RETRY_BASE_MS).toISOString(), at(120_000).toISOString()]);
  });

  it('throttles a target over its per-minute budget without charging an attempt', async () => {
    syncAlertsConfig(db, config(2), T0.toISOString());
    fire(db, 'a1');
    fire(db, 'a2');
    fire(db, 'a3');
    const sink = new InMemoryAlertSink('ops');
    const d = dispatcher(sink);

    expect(await d.runOnce()).toEqual({ sent: 2, retried: 0, failed: 0, throttled: 1 });
    expect(rows(db).filter((r) => r.status === 'pending')).toEqual([
      {
        status: 'pending',
        attempt_count: 0,
        next_retry_at: T0.toISOString(),
        delivered_at: null,
        last_error: null,
      },
    ]);

    // Still inside the trailing window: the budget is spent.
    clock = at(THROTTLE_WINDOW_MS - 1);
    expect(await d.runOnce()).toEqual({ sent: 0, retried: 0, failed: 0, throttled: 1 });

    clock = at(THROTTLE_WINDOW_MS + 1);
    expect((await d.runOnce())?.sent).toBe(1);
    expect(countDeliveries(db)).toEqual({ pending: 0, sent: 3, failed: 0 });
  });

  it('a throttled backlog on one target never starves another (AU, 2026-10-27)', async () => {
    // A full batch of older `ops` rows used to fill every pass: they stayed
    // pending (throttled) and the later `oncall` row was never reached.
    syncAlertsConfig(
      db,
      {
        targets: [
          {
            id: 'ops',
            kind: 'telegram',
            tokenRef: 'env:ALERT_TOKEN',
            chatId: '1',
            maxPerMinute: 1,
          },
          { id: 'oncall', kind: 'telegram', tokenRef: 'env:ALERT_TOKEN', chatId: '2' },
        ],
        rules: [
          { id: 'errors', kind: 'error', targetId: 'ops' },
          { id: 'page', kind: 'error', targetId: 'oncall' },
        ],
      },
      T0.toISOString(),
    );
    for (let i = 0; i < DISPATCH_BATCH_SIZE + 5; i++) fire(db, `a${String(i).padStart(3, '0')}`);
    recordAlertEvent(db, {
      ruleId: 'page',
      targetId: 'oncall',
      dedupeKey: 'page:b1',
      payload: {
        kind: 'error',
        ruleId: 'page',
        sessionId: 's1',
        agentId: 'b1',
        firedAt: at(1).toISOString(),
      },
    });
    clock = at(1);
    const ops = new InMemoryAlertSink('ops');
    const oncall = new InMemoryAlertSink('oncall');
    const d = createAlertDispatcher({
      db,
      sinks: new Map<string, AlertSinkPort>([
        ['ops', ops],
        ['oncall', oncall],
      ]),
      now,
    });

    expect(await d.runOnce()).toEqual({
      sent: 2,
      retried: 0,
      failed: 0,
      throttled: DISPATCH_BATCH_SIZE + 4,
    });
    expect(ops.sent()).toHaveLength(1);
    expect(oncall.sent().map((n) => n.ruleId)).toEqual(['page']);
  });

  it('fails a delivery whose target has no sink', async () => {
    fire(db, 'a1');
    expect((await dispatcher(null).runOnce())?.failed).toBe(1);
    expect(rows(db)[0]).toMatchObject({
      status: 'failed',
      attempt_count: 0,
      last_error: 'target not configured',
    });
    expect(logs).toEqual([expect.stringContaining('failed (target not configured)')]);
  });

  it('fails every due delivery of a sinkless target in one pass, whatever its budget', async () => {
    // A disabled target is still in the table with a budget; the budget must
    // not hold its rows back as "throttled" when they can only fail.
    syncAlertsConfig(db, config(1), T0.toISOString());
    fire(db, 'a1');
    fire(db, 'a2');
    fire(db, 'a3');
    expect(await dispatcher(null).runOnce()).toEqual({
      sent: 0,
      retried: 0,
      failed: 3,
      throttled: 0,
    });
  });

  it('treats a throwing sink as retryable and never relays its message', async () => {
    fire(db, 'a1');
    const secretUrl = 'https://api.telegram.org/bot123456:SECRET-TOKEN/sendMessage';
    const sink: AlertSinkPort = {
      targetId: 'ops',
      kind: 'telegram',
      send: () => Promise.reject(new Error(`request to ${secretUrl} failed`)),
    };
    expect((await dispatcher(sink).runOnce())?.retried).toBe(1);
    expect(rows(db)[0]?.last_error).toBe('sink error');
    expect(logs.join('\n')).not.toContain('SECRET-TOKEN');
  });

  it('is single-flight: a pass started while one runs returns null', async () => {
    fire(db, 'a1');
    let release: (outcome: DeliveryOutcome) => void = () => undefined;
    const sink: AlertSinkPort = {
      targetId: 'ops',
      kind: 'telegram',
      send: () =>
        new Promise<DeliveryOutcome>((resolve) => {
          release = resolve;
        }),
    };
    const d = dispatcher(sink);
    const first = d.runOnce();
    expect(await d.runOnce()).toBeNull();
    release({ kind: 'sent' });
    expect((await first)?.sent).toBe(1);
    // The flag is released: the next pass runs (and finds nothing).
    expect((await d.runOnce())?.sent).toBe(0);
  });

  it('runs on the wall clock and logs nothing by default', async () => {
    fire(db, 'a1', new Date('2020-01-01T00:00:00.000Z'));
    const d = createAlertDispatcher({
      db,
      sinks: new Map([['ops', new InMemoryAlertSink('ops')]]),
    });
    expect((await d.runOnce())?.sent).toBe(1);
  });
});
