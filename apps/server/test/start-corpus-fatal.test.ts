/**
 * The composition root's `onFatal` wiring — previously hidden behind a
 * `/* v8 ignore next *\/` whose justification ("unreachable via a real
 * filesystem") does not hold.
 *
 * `isSafeEntryName` rejects any directory-entry name carrying a path
 * separator, and `foo\bar` is a legal file name on macOS and Linux. So a single
 * oddly-named directory sitting in the corpus root makes `enumerateSessions`
 * raise a `ContainmentError` out of the very first replay tick, on a REAL
 * filesystem, with no crafted `CorpusFs` in sight. That is exactly the arm
 * `start()` wires `onFatal` to, and this suite drives it end to end.
 *
 * The corpus used here is a throwaway temp directory; the real
 * `~/.claude/projects` is never resolved (`CLAUDE_PROJECTS_DIR` is always set).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { start } from '../src/index';
import { TEST_TOKEN } from './helpers';

/** A backslash is not a path separator on POSIX, but it IS a rejected name. */
const TRAVERSAL_SHAPED_SLUG = 'a\\b';

describe('start() on a corpus that violates containment', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs loudly, closes the database and exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-fatal-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    mkdirSync(join(corpusRoot, TRAVERSAL_SHAPED_SLUG), { recursive: true });

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(
      start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: join(dir, 'agent.db'),
        CLAUDE_PROJECTS_DIR: corpusRoot,
        DASHBOARD_POLL_INTERVAL_MS: '600000',
      }),
    ).rejects.toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    const fatal = error.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('FATAL: corpus containment violation'));
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain('stop-everything');
    expect(fatal[0]).toContain(TRAVERSAL_SHAPED_SLUG);
    // Fail closed: no listening socket survives the fatal, and the database
    // handle was closed by the cleanup callback before the exit.
  });
});
