import { defineConfig } from 'vitest/config';

// Thresholds are set at the level this package actually holds rather than at
// the workspace floor of 90: a 90% bar on a package sitting at 100% licenses a
// ten-point regression to pass in silence, which is the opposite of a gate.
// This package carries the parser, whose contract (docs/analysis/parser-spec.md)
// is normative for all ingest work — it is the last place where a silently
// uncovered branch is acceptable.
export default defineConfig({
  test: {
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
