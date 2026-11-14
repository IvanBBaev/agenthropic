import { defineConfig } from 'vitest/config';

// R17 / QA-2: the opt-in real-corpus contract suite (`pnpm test:real`). Kept out
// of the default run (see vitest.config.ts). No coverage: it measures the
// corpus, not the code. The bounds are generous on purpose - a cold ingest of
// a multi-gigabyte `~/.claude/projects` takes minutes on a loaded machine.
export default defineConfig({
  test: {
    include: ['test/real-corpus/**/*.test.ts'],
    // The counts-only report is the point of a run; the default reporter drops
    // a passing test's stdout when it is not attached to a TTY.
    reporters: ['verbose'],
    testTimeout: 2 * 60 * 60 * 1000,
    hookTimeout: 2 * 60 * 60 * 1000,
  },
});
