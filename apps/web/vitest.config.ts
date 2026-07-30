import { defineConfig } from 'vitest/config';

// Coverage mirrors the workspace convention (packages/shared, packages/core,
// apps/server): v8 provider, 90% thresholds, applied when run with
// `--coverage`. src/main.tsx is the DOM entry point (mount only, exercised by
// the browser, not by jsdom tests) and is excluded like the server CLI entry.
export default defineConfig({
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
