/**
 * QA-7 smoke: the contract between playwright.config.ts, the boot script
 * (serve-fixtures.ts) and the spec (smoke.e2e.ts).
 *
 * The config creates one throwaway root and one random token per run and puts
 * both into the environment, which the webServer process and the test workers
 * inherit. This module only reads that environment; it never creates anything.
 */
import { join } from 'node:path';

/** One synthetic project slug hosts every fixture session (ids are disjoint). */
export const E2E_SLUG = '-Users-synthetic-e2e-project';

/** Loopback only, like every other way of running the server. */
export const E2E_HOST = '127.0.0.1';

export function requireEnv(name: 'E2E_ROOT' | 'E2E_TOKEN' | 'E2E_PORT'): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`QA-7 smoke: ${name} is required (set by e2e/playwright.config.ts)`);
  }
  return value;
}

/** The corpus root the server watches: `<E2E_ROOT>/projects`. */
export function corpusRoot(): string {
  return join(requireEnv('E2E_ROOT'), 'projects');
}
