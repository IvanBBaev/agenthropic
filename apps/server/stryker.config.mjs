// QA-9: a ONE-OFF mutation run, recorded before a tag - not a CI gate, and not
// part of `pnpm test` (it takes a long time and its score is a finding, not a
// bar). `pnpm --filter @agenthropic/server mutation` runs it; the score and the
// surviving mutants of the last run are written up in
// docs/measurement/mutation-*.md.
//
// Scope is the read models behind the API (formerly api/queries.ts, split by
// ARC-4): the SQL and the shaping that turn stored rows into the numbers every
// view shows. Nearly every server test is integration (real SQLite, booted
// server), so `perTest` coverage matters here: each mutant reruns only the
// tests that reached it.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  // `forks`, not the runner's default `threads`: test/index.test.ts stubs HOME
  // and asserts os.homedir() follows it, which only holds in a child process
  // (a worker thread's process.env is a copy libuv never reads).
  vitest: { configFile: 'vitest.config.ts', pool: 'forks' },
  mutate: ['src/api/read-models/**/*.ts'],
  coverageAnalysis: 'perTest',
  // A finding, never a gate: no break threshold.
  thresholds: { high: 90, low: 75, break: null },
  // Two runners and a generous dry-run budget: the dry run executes the whole
  // suite once under perTest coverage and must survive a loaded build machine.
  concurrency: 2,
  dryRunTimeoutMinutes: 30,
  timeoutMS: 120_000,
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
