/**
 * AD-1 - the alerting service and its wiring: boot proves every tokenRef
 * resolves (and fails loudly, without the value, when one does not), syncs
 * the file, and ticks rules + delivery on an unref-ed timer that survives a
 * failing tick and stops on close. Off by default: without
 * DASHBOARD_ALERTS_CONFIG start() builds none of it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryAlertSink, type AlertsConfig } from '@agenthropic/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAlerting } from '../src/alerts/index';
import { countDeliveries, listTargets } from '../src/db/alerts';
import type { SqliteDatabase } from '../src/db/connection';
import { start } from '../src/index';
import { createMigratedTempDb, TEST_TOKEN, type TempDb } from './helpers';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const LATER = new Date('2026-10-24T10:05:00.000Z');

const CONFIG: AlertsConfig = {
  targets: [
    { id: 'ops', kind: 'telegram', tokenRef: 'env:AGENTHROPIC_TEST_ALERT_TOKEN', chatId: '12345' },
  ],
  rules: [
    { id: 'errors', kind: 'error', targetId: 'ops' },
    { id: 'off', kind: 'stuck_agent', targetId: 'ops', enabled: false },
  ],
};

function erroredAgent(db: SqliteDatabase): void {
  const seen = LATER.toISOString();
  db.prepare(
    `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status) VALUES ('s1', 'p', ?, ?, 'active')`,
  ).run(seen, seen);
  db.prepare(
    `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES ('a1', 's1', 'subagent', 'explorer', 'error', NULL, ?, ?)`,
  ).run(seen, seen);
}

describe('startAlerting (AD-1)', () => {
  let temp: TempDb;
  let clock: Date;
  const now = (): Date => clock;

  beforeEach(() => {
    temp = createMigratedTempDb();
    clock = NOW;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    temp.cleanup();
  });

  it('fails the boot when a tokenRef does not resolve, without syncing anything', () => {
    expect(() =>
      startAlerting({
        db: temp.db,
        config: CONFIG,
        intervalMs: 1000,
        resolveToken: () => {
          throw new Error('environment variable is unset or empty');
        },
      }),
    ).toThrow(
      'Alert target "ops": tokenRef env:AGENTHROPIC_TEST_ALERT_TOKEN does not resolve - environment variable is unset or empty',
    );
    expect(listTargets(temp.db)).toEqual([]);
  });

  it('resolves env: refs from the process environment by default', () => {
    expect(() => startAlerting({ db: temp.db, config: CONFIG, intervalMs: 1000 })).toThrow(
      /does not resolve/,
    );

    vi.stubEnv('AGENTHROPIC_TEST_ALERT_TOKEN', '123456:not-a-real-token');
    // The default sink is built but never asked to send: there is nothing to fire.
    const service = startAlerting({ db: temp.db, config: CONFIG, intervalMs: 1000, now });
    service.stop();
    expect(listTargets(temp.db).map((t) => t.id)).toEqual(['ops']);
  });

  it('syncs the file, logs the enabled shape, and ticks rules then delivery', async () => {
    const sink = new InMemoryAlertSink('ops');
    const logs: string[] = [];
    const service = startAlerting({
      db: temp.db,
      config: CONFIG,
      intervalMs: 60_000,
      now,
      log: (line) => logs.push(line),
      resolveToken: () => 'token',
      createSink: () => sink,
    });
    try {
      expect(logs).toEqual(['alerts: enabled - 1 target(s), 1 active rule(s).']);
      expect(await service.tick()).toEqual({
        fired: 0,
        delivery: { sent: 0, retried: 0, failed: 0, throttled: 0 },
      });

      erroredAgent(temp.db);
      clock = LATER;
      expect(await service.tick()).toEqual({
        fired: 1,
        delivery: { sent: 1, retried: 0, failed: 0, throttled: 0 },
      });
      expect(logs).toContain('alerts: 1 new alert event(s).');
      expect(sink.sent()).toEqual([expect.objectContaining({ kind: 'error', agentId: 'a1' })]);
    } finally {
      service.stop();
    }
  });

  it('ticks on the timer, logs a failing tick and keeps going, and stops cleanly', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const sink = new InMemoryAlertSink('ops');
    let broken = false;
    const service = startAlerting({
      db: temp.db,
      config: CONFIG,
      intervalMs: 1000,
      now: () => {
        if (broken) throw new Error('clock broke');
        return clock;
      },
      logError: (line) => errors.push(line),
      resolveToken: () => 'token',
      createSink: () => sink,
    });
    erroredAgent(temp.db);
    clock = LATER;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.sent()).toHaveLength(1);

    broken = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual(['alerts tick failed: clock broke']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toHaveLength(2);

    service.stop();
    service.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(errors).toHaveLength(2);
  });

  it('swallows a failing tick silently when no error logger is given', async () => {
    vi.useFakeTimers();
    let broken = false;
    const service = startAlerting({
      db: temp.db,
      config: CONFIG,
      intervalMs: 1000,
      now: () => {
        if (broken) throw new Error('clock broke');
        return clock;
      },
      resolveToken: () => 'token',
      createSink: () => new InMemoryAlertSink('ops'),
    });
    broken = true;
    await vi.advanceTimersByTimeAsync(1000);
    service.stop();
  });

  it('reports a non-Error tick failure by its string form', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let broken = false;
    const service = startAlerting({
      db: temp.db,
      config: CONFIG,
      intervalMs: 1000,
      now: () => {
        if (broken) throw 'clock broke';
        return clock;
      },
      logError: (line) => errors.push(line),
      resolveToken: () => 'token',
      createSink: () => new InMemoryAlertSink('ops'),
    });
    broken = true;
    await vi.advanceTimersByTimeAsync(1000);
    service.stop();
    expect(errors).toEqual(['alerts tick failed: clock broke']);
  });
});

describe('start() alerting wiring (AD-1)', { timeout: 30_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-alerts-start-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseEnv = (): Record<string, string> => ({
    DASHBOARD_TOKEN: TEST_TOKEN,
    DASHBOARD_PORT: '0',
    DASHBOARD_DB_PATH: join(dir, 'data', 'agent.db'),
    DASHBOARD_INGEST: '0',
  });

  it('builds no alerting without DASHBOARD_ALERTS_CONFIG', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = await start(baseEnv());
    try {
      expect(log.mock.calls.flat().join('\n')).not.toContain('alerts:');
      expect(listTargets(server.db)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('starts alerting from the config file and stops it on close', async () => {
    const path = join(dir, 'alerts.json');
    writeFileSync(path, JSON.stringify(CONFIG));
    vi.stubEnv('AGENTHROPIC_TEST_ALERT_TOKEN', '123456:not-a-real-token');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = await start({ ...baseEnv(), DASHBOARD_ALERTS_CONFIG: path });
    try {
      expect(log).toHaveBeenCalledWith('alerts: enabled - 1 target(s), 1 active rule(s).');
      expect(listTargets(server.db).map((t) => t.id)).toEqual(['ops']);
      expect(countDeliveries(server.db)).toEqual({ pending: 0, sent: 0, failed: 0 });
    } finally {
      await server.close();
    }
  });

  it('refuses to boot on an invalid config file, before opening the database', async () => {
    const path = join(dir, 'alerts.json');
    writeFileSync(path, '{ nope');
    await expect(start({ ...baseEnv(), DASHBOARD_ALERTS_CONFIG: path })).rejects.toThrow(
      `Invalid alerts config ${path}: not valid JSON.`,
    );
  });

  it('refuses to boot when a tokenRef does not resolve, and closes what it opened', async () => {
    const path = join(dir, 'alerts.json');
    writeFileSync(path, JSON.stringify(CONFIG));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(start({ ...baseEnv(), DASHBOARD_ALERTS_CONFIG: path })).rejects.toThrow(
      /Alert target "ops": tokenRef env:AGENTHROPIC_TEST_ALERT_TOKEN does not resolve/,
    );
  });
});
