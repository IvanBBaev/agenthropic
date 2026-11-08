import { defineConfig } from 'vitest/config';

// Thresholds are set at the level this package actually holds rather than at
// the workspace floor of 90: a 90% bar on a package sitting at 100% licenses a
// ten-point regression to pass in silence, which is the opposite of a gate.
// Timeouts (R16 / QA-4): pure in-memory tests, so a modest explicit bound
// rather than Vitest's 5 s default, which a loaded machine can exceed.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
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
