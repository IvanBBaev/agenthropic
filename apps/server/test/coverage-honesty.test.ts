/**
 * Static guard: this package's coverage number must never be bought.
 *
 * `apps/web` has carried a guard like this since 2026-07-31, but it inspected
 * exactly ONE file (`views/layout/cost-flow.ts`), so the server - the package
 * that owns ingest, pricing, retention and every security invariant - had no
 * guard at all. Anyone could have restored a 100 by annotating a live branch.
 *
 * Why the pragma is the thing being banned rather than merely discouraged:
 * `/* v8 ignore start *\/` removes BOTH arms of an operator from the coverage
 * DENOMINATOR. The reported percentage goes up while the untested code stays
 * exactly as untested as it was. For a project whose central claim is that its
 * numbers are ground truth - token counts never inferred, unpriced surfaces
 * never a silent $0 - a coverage figure inflated by hiding code is the same
 * category of lie as an inferred token count.
 *
 * The remedy when a branch is genuinely unreachable is to DELETE it, not to
 * hide it. That is what happened to `server.ts`'s `request.raw.url ?? ''`
 * (Fastify types `url` as `string`) and to `normalize-session.ts`'s BFS
 * dedupe - the latter turned out to be reachable at the pure function's own
 * contract boundary and is now covered by a real test.
 *
 * This file reads source as TEXT and never imports it, so it cannot be
 * satisfied by a mock.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_ROOT = join(PACKAGE_ROOT, 'src');
const VITEST_CONFIG = readFileSync(join(PACKAGE_ROOT, 'vitest.config.ts'), 'utf8');

/** Every `.ts` file under `src/`, recursively, as repo-relative paths. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      found.push(...sourceFiles(abs));
      continue;
    }
    if (entry.endsWith('.ts')) {
      found.push(abs);
    }
  }
  return found;
}

// Built once: a failure names the offending file, and an empty sweep is itself
// a failure (a broken walker must not read as "clean").
const FILES = sourceFiles(SRC_ROOT);

describe('coverage honesty (static)', () => {
  it('sweeps a non-empty set of source files', () => {
    // Guards the guard: if the walker ever silently returns nothing, every
    // assertion below would vacuously pass.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('has no v8 ignore pragma anywhere under src/', () => {
    const offenders = FILES.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('v8 ignore') || text.includes('c8 ignore');
    }).map((file) => relative(PACKAGE_ROOT, file));

    // Listed rather than counted: the failure message has to say WHICH file, or
    // the next person just deletes the test.
    expect(offenders).toEqual([]);
  });

  it('has no istanbul ignore pragma anywhere under src/', () => {
    // The project uses the v8 provider, but an istanbul pragma is the same
    // intent and would become live the moment the provider changed.
    const offenders = FILES.filter((file) =>
      readFileSync(file, 'utf8').includes('istanbul ignore'),
    ).map((file) => relative(PACKAGE_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('keeps every coverage threshold at 100', () => {
    // The other way to buy a number is to move the bar. This package sits at
    // 100/100/100/100; a threshold below that licenses a silent regression,
    // which is the opposite of a gate. Raising coverage is always allowed -
    // lowering the bar to match a regression is what this catches.
    for (const metric of ['lines', 'branches', 'functions', 'statements']) {
      const match = new RegExp(`\\b${metric}:\\s*(\\d+)`).exec(VITEST_CONFIG);
      expect(match, `no ${metric} threshold found in vitest.config.ts`).not.toBeNull();
      expect(Number(match?.[1]), `${metric} threshold`).toBe(100);
    }
  });

  it('measures the whole of src/, with no per-file exclusions', () => {
    // `exclude` is the third way to inflate the figure: a file that is never
    // measured cannot lower the average. `include: ['src/**']` with no
    // `exclude` means the denominator is the entire package.
    expect(VITEST_CONFIG).toContain("include: ['src/**']");
    expect(VITEST_CONFIG).not.toContain('exclude');
  });
});
