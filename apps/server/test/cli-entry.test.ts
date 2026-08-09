/**
 * The CLI entry point of `src/index.ts` — previously the one block in the
 * server hidden behind `/* v8 ignore start - CLI entry *\/`.
 *
 * It is not untestable code, it is the code that runs every single time Ivan
 * starts the dashboard, so it is tested like anything else:
 *
 *   - `isMainModule` decides library-import vs. process-entry;
 *   - `runCli` announces the bound address on success and fails CLOSED on any
 *     boot error (message only, never a stack trace, then a non-zero exit);
 *   - the module-level `if (isMainModule(...))` guard is driven through BOTH
 *     arms — false by every other test that imports the module as a library,
 *     true by re-importing it with `process.argv[1]` pointed at the module.
 *
 * Nothing here touches the real `~/.claude/projects`: every boot either fails
 * at the token check before any I/O, or runs with `DASHBOARD_INGEST=0` and a
 * throwaway database directory.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMainModule, runCli, start, type RunningServer } from '../src/index';
import { TEST_TOKEN } from './helpers';

const INDEX_PATH = fileURLToPath(new URL('../src/index.ts', import.meta.url));

describe('CLI entry (src/index)', () => {
  const dirs: string[] = [];
  const servers: RunningServer[] = [];
  // Snapshot the whole vector rather than `argv[1]` alone: under
  // `noUncheckedIndexedAccess` an element read is `string | undefined`, which
  // cannot be written back into a `string[]`.
  const originalArgv = [...process.argv];

  beforeEach(() => {
    // The suite asserts on stdout/stderr shape, so both are captured rather
    // than left to leak into the reporter.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('isMainModule', () => {
    it('is true only when argv[1] IS this module', () => {
      expect(isMainModule(INDEX_PATH, pathToFileURL(INDEX_PATH).href)).toBe(true);
    });

    it('is false when the process was started from a different file', () => {
      expect(isMainModule('/usr/local/bin/vitest', pathToFileURL(INDEX_PATH).href)).toBe(false);
    });

    it('is false when there is no argv[1] at all (`node -e`, a REPL)', () => {
      expect(isMainModule(undefined, pathToFileURL(INDEX_PATH).href)).toBe(false);
    });
  });

  describe('runCli', () => {
    it('announces every bound address, and they are all loopback', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-cli-'));
      dirs.push(dir);
      const log = vi.mocked(console.log);

      await runCli(async () => {
        const server = await start({
          DASHBOARD_TOKEN: TEST_TOKEN,
          DASHBOARD_PORT: '0',
          DASHBOARD_DB_PATH: join(dir, 'agent.db'),
          DASHBOARD_INGEST: '0', // never resolve the real ~/.claude/projects
        });
        servers.push(server);
        return server;
      });

      const announcements = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('agenthropic server listening on '));
      expect(announcements).toHaveLength(1);
      expect(announcements[0]).toMatch(/^agenthropic server listening on 127\.0\.0\.1:\d+$/);
    });

    it('fails closed on a boot error: message only, no stack, exit 1', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const error = vi.mocked(console.error);

      await runCli(() => start({})); // no DASHBOARD_TOKEN

      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledTimes(1);
      const printed = error.mock.calls[0]?.[0];
      expect(printed).toEqual(expect.stringContaining('DASHBOARD_TOKEN'));
      // The Error object itself is never handed to console.error - a stack
      // trace carries filesystem paths into whatever collects the terminal log.
      expect(typeof printed).toBe('string');
      expect(String(printed)).not.toContain(INDEX_PATH);
    });

    it('prints a non-Error rejection as-is instead of swallowing it', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const error = vi.mocked(console.error);

      await runCli(() => Promise.reject('plain string failure'));

      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith('plain string failure');
    });
  });

  describe('the module-level entry guard', () => {
    it('does NOT boot when the module is imported as a library', () => {
      // Every other test file in this package proves the same thing by simply
      // importing `../src/index` without a server appearing; this pins it.
      expect(isMainModule(process.argv[1], pathToFileURL(INDEX_PATH).href)).toBe(false);
    });

    it('DOES boot when the module is the process entry point', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const error = vi.mocked(console.error);
      // No token in the environment: the bootstrap must reach `start()` and
      // fail there, which proves the guard fired without leaving a listening
      // socket or a database file behind.
      vi.stubEnv('DASHBOARD_TOKEN', undefined);
      process.argv[1] = INDEX_PATH;

      vi.resetModules();
      await import('../src/index');

      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(1);
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_TOKEN'));
    });
  });
});
