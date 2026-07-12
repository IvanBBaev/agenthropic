import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enforceLoopbackOrExit, isLoopbackAddress, start } from '../src/index';
import { TEST_TOKEN } from './helpers';

describe('composition root (src/index)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start() boots config -> WAL db -> migrations -> loopback listen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-start-'));
    dirs.push(dir);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'nested', 'agent.db'),
    });
    try {
      expect(server.db.pragma('journal_mode', { simple: true })).toBe('wal');
      const tables = server.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events_raw'")
        .all();
      expect(tables).toHaveLength(1);
      expect(server.app.addresses().every((entry) => entry.address === '127.0.0.1')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('start() throws without a token and starts no server', async () => {
    await expect(start({})).rejects.toThrow(/DASHBOARD_TOKEN/);
  });

  it('start() cleans up and rethrows when the port is already taken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-start-conflict-'));
    dirs.push(dir);
    const first = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: join(dir, 'first.db'),
    });
    try {
      const takenPort = first.app.addresses()[0]?.port;
      await expect(
        start({
          DASHBOARD_TOKEN: TEST_TOKEN,
          DASHBOARD_PORT: String(takenPort),
          DASHBOARD_DB_PATH: join(dir, 'second.db'),
        }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  });

  it('isLoopbackAddress accepts loopback forms only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });

  it('enforceLoopbackOrExit is a no-op when every address is loopback', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    await enforceLoopbackOrExit([{ address: '127.0.0.1' }, { address: '::1' }], cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('enforceLoopbackOrExit logs, cleans up and exits on a non-loopback bind', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(enforceLoopbackOrExit([{ address: '192.168.1.10' }], cleanup)).rejects.toThrow(
      'process.exit called',
    );

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('192.168.1.10'));
  });
});
