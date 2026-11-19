// QA-9: a ONE-OFF mutation run, recorded before a tag - not a CI gate, and not
// part of `pnpm test` (it takes minutes and its score is a finding, not a bar).
// `pnpm --filter @agenthropic/core mutation` runs it; the score and the
// surviving mutants of the last run are written up in
// docs/measurement/mutation-*.md. 100% line/branch coverage says every line
// ran; a killed mutant says a test noticed when the line was wrong.
//
// Scope is the code whose numbers the dashboard is trusted for: the parser
// (the normative parser-spec.md contract), the usage dedupe and the cost
// arithmetic. The rest of core is left out to keep one run inside an hour on
// a loaded machine, not because it does not matter.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.ts' },
  mutate: ['src/parser/**/*.ts', 'src/usage/dedupe.ts', 'src/cost/compute-cost.ts'],
  coverageAnalysis: 'perTest',
  // A finding, never a gate: no break threshold.
  thresholds: { high: 90, low: 75, break: null },
  // Two runners and a generous dry-run budget: the dry run executes the whole
  // suite once under perTest coverage and must survive a loaded build machine.
  concurrency: 2,
  dryRunTimeoutMinutes: 30,
  timeoutMS: 30_000,
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  // In place, not in a sandbox copy: tests locate repo files relative to their
  // own path (hierarchy-gate.test.ts reads packages/test-fixtures/annotations
  // through `../../../`), and a sandbox under .stryker-tmp/ moves them one
  // level deeper. Stryker restores every mutated file when the run ends or is
  // interrupted; run it on a clean tree and check `git status` afterwards (a
  // SIGKILL can leave a mutant behind - `git checkout -- src` undoes it).
  inPlace: true,
  tempDirName: '.stryker-tmp',
};
