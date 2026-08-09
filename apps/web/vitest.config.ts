import { defineConfig } from 'vitest/config';

// Coverage mirrors the workspace convention (packages/shared, packages/core,
// apps/server, packages/test-fixtures): v8 provider, thresholds applied on
// every `test` run. src/main.tsx is the DOM entry point (mount only, exercised
// by the browser, not by jsdom tests) and is excluded like the server CLI entry.
//
// Thresholds are set at the level this package actually holds rather than at
// the workspace floor of 90: a 90% bar on a package sitting at 100% licenses a
// ten-point regression to pass in silence, which is the opposite of a gate.
//
// The figure carries no caveat: there is not a single `/* v8 ignore */` in
// src/**, so nothing is excluded from the denominator. The 7 type-defensive
// `??` arms in `src/views/layout/cost-flow.ts` that used to be excluded (the
// @types/d3-sankey optional-geometry fields) are now reached by real tests
// through the exported `toFlowNode` / `toFlowLink` converters and the
// injectable `pathFor` seam - see test/honesty.test.tsx. A static test in that
// file fails if the pragma ever comes back.
export default defineConfig({
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
