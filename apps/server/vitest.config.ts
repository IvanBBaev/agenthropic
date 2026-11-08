import { defineConfig } from 'vitest/config';

// Thresholds are set at the level this package actually holds rather than at
// the workspace floor of 90: a 90% bar on a package sitting at ~100% licenses a
// ten-point regression to pass in silence, which is the opposite of a gate.
//
// All four are 100, and none of it is bought with an ignore pragma: `src/**`
// contains zero `v8 ignore` directives and `test/coverage-honesty.test.ts`
// fails the build if one appears. The bar was 99 on branches while `server.ts`
// carried an unreachable `??` arm; that arm was deleted rather than suppressed
// (Fastify types `request.url` as `string`, so the fallback was dead), which is
// the only way to raise the number without hiding live code. Suppressing it
// would have removed BOTH arms of the operator from the denominator and bought
// a cosmetic 100 - the wrong trade for a project whose whole claim is that its
// numbers are ground truth.
//
// Timeouts (R16 / QA-4): Vitest's 5 s default timed tests out on a loaded
// machine. Nearly every file here is integration - a real temp-dir SQLite with
// the full migration chain, a booted server, real sockets - so one generous
// bound for the whole package beats a unit/integration projects split that
// would sort ~100 of ~125 files into the slow bucket anyway. A real hang still
// fails, just later. No retries: they would hide real races.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
