/**
 * QA-7: one real-browser smoke over the real server, the built SPA and the
 * synthetic fixture corpus. A local pre-tag step (docs/RELEASE.md), not part
 * of `pnpm test` and not in CI yet.
 *
 * Playwright evaluates this file in the runner AND in every worker. The root
 * directory and the token are created once, in the runner, and handed down
 * through the environment (`??=`), so the webServer process and the workers
 * agree on them. The root is a mkdtemp directory (mode 0700) under the OS
 * temp dir; the real `~/.claude/projects` is never read.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_HOST } from './env';

process.env.E2E_ROOT ??= mkdtempSync(join(tmpdir(), 'agenthropic-e2e-'));
process.env.E2E_TOKEN ??= randomBytes(24).toString('hex');
process.env.E2E_PORT ??= '7391';

const baseURL = `http://${E2E_HOST}:${process.env.E2E_PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts$/,
  // Artifacts (traces, screenshots) go to the throwaway root, not the repo.
  outputDir: join(process.env.E2E_ROOT, 'test-results'),
  reporter: 'list',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  // Timeouts sized for a loaded build machine (QA-4 measured load ~100).
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'tsx e2e/serve-fixtures.ts',
    cwd: '..',
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
