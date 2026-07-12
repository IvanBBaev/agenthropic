import { defineConfig } from 'vitest/config';

// No coverage thresholds here: the WP-F3 coverage gate scope is
// packages/shared, packages/core, apps/server.
export default defineConfig({
  test: {},
});
