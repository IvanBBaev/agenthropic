import { defineConfig } from 'vitest/config';

// Coverage mirrors the workspace convention (packages/shared, packages/core,
// apps/server, apps/web): v8 provider, thresholds applied on every `test` run.
//
// This package was originally left out of the WP-F3 coverage gate on the
// grounds that fixtures are data rather than logic. That is only half true:
// `getFixture`, `listFixtures` and `makeRawEventEnvelope` are real code, and a
// defect in a fixture builder does not fail loudly — it silently weakens every
// downstream parser and ingest test that consumes it. Gating the package makes
// that class of defect visible.
//
// Thresholds are set at the level the package actually holds rather than at
// the workspace floor of 90: a 90% bar on a package sitting at 100% licenses a
// ten-point regression to pass in silence, which is the opposite of a gate.
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
