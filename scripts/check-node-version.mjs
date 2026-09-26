#!/usr/bin/env node
// check-node-version: refuse to run under a Node major other than the one `.nvmrc` names.
//
// Why a runtime guard when `engines.node` is already `>=22 <23` and `.npmrc` sets
// `engine-strict` (L6 / D2, 2026-09-09): pnpm checks `engines` against the Node that runs
// PNPM, not the one that will run the scripts. On a machine where pnpm is corepack's shim
// under nvm's Node 22 but a v26 `node` sits first on PATH, the install passes and
// `pnpm run test` then executes vitest under v26 - where the `better-sqlite3` binding built
// for NODE_MODULE_VERSION 127 refuses to load and every DB-touching test dies with
// `Cannot read properties of undefined (reading 'close')`, plus ~16 spurious
// `localStorage is undefined` failures under jsdom. The failure is large and blames the
// wrong files (measured 2026-09-01: a full cascade on v26, 15 real failures on v22).
//
// So `test` and `start` run this first. It compares MAJORS only - `.nvmrc` says `22`, and
// the native binding cares about the ABI, which is per major - and it is "missing is loud":
// an absent or unparsable `.nvmrc` is a failure, not a pass, the same rule as
// `check-no-spawner`. No child process is involved; the running process already knows its
// own version.
//
// AMENDED 2026-09-23 (finding C-8). "So `test` and `start` run this first" is true
// of the ROOT scripts only, and reads as a stronger guarantee than the wiring gives.
// Measured on 2026-09-23 with `/opt/homebrew/bin` first on PATH: `node
// scripts/check-node-version.mjs` refused (exit 1, v26.7.0), while
// `pnpm --filter @agenthropic/server exec node -p process.version` reported v26.7.0
// - no guard anywhere in that chain. Every per-package entry point bypasses this
// file: `pnpm --filter @agenthropic/server test`, `... dev` (the command this repo's
// own docs tell people to run), `... start` and `... bench` all execute under
// whatever `node` PATH resolves first. The hole this guard exists to close is open
// at the entry points people actually type. Closing it means prefixing the
// per-package `test`/`dev`/`start`/`bench` scripts too, which is a package.json
// change outside this file; until that lands, treat this guard as covering the root
// scripts and nothing else.

// AMENDED 2026-09-23 (C-8 closed). That wiring landed the same day: `apps/server`'s
// `dev`, `start`, `bench` and `test`, `apps/web`'s `dev` and `test`, and the `test`
// script of `packages/shared`, `packages/core` and `packages/test-fixtures` now each
// begin with `node ../../scripts/check-node-version.mjs &&`. The relative path is
// correct from both `apps/*` and `packages/*`, and this file resolves `.nvmrc` from
// its own location (`import.meta.url`), not from the working directory, so the guard
// reads the same `.nvmrc` wherever it is invoked from. Still deliberately NOT wired:
// `build`, `typecheck`, `lint`, `format:check` and `render-claims` - the native ABI
// that motivates this guard does not participate in them, and a guard on a script it
// cannot protect is the same overclaim in the other direction. So the honest scope is
// now: every entry point that loads the native binding, plus the root scripts. A
// `vitest`/`tsx` invoked directly (`npx vitest run --root apps/server`) still bypasses
// it, because it never goes through a package script.

// AMENDED 2026-09-23 (lane-N). Split into an exported pure core
// (`evaluateNodeVersion` + `formatReport`) and a CLI wrapper, so the gate can be
// unit-tested by IMPORTING it rather than by spawning it - spawning would need a
// new inline opt-out marker, which enlarges the very exception list
// SECURITY.md advertises as small. The decision, the messages and the exit codes
// are unchanged; only the seam is new. The wrapper below the core is NOT
// exercised by any test - it is kept small enough to read at a glance instead.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NVMRC = join(REPO_ROOT, '.nvmrc');

/**
 * Decide whether the running Node satisfies the `.nvmrc` at `nvmrcPath`.
 *
 * Pure apart from the one `.nvmrc` read, and every input the verdict depends on
 * is a parameter - so a test can point it at a temp `.nvmrc` and name a Node
 * version without being that version. "Missing is loud": an absent or
 * unparsable `.nvmrc` is a finding, never a pass.
 *
 * @param {{ nvmrcPath: string, nodeVersion: string, execPath: string }} options
 * @returns {import('./check-node-version.d.mts').NodeVersionFindings}
 */
export function evaluateNodeVersion({ nvmrcPath, nodeVersion, execPath }) {
  let wanted;
  try {
    wanted = readFileSync(nvmrcPath, 'utf8').trim();
  } catch (error) {
    return {
      status: 'unreadable',
      nvmrcPath,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const match = /^v?(\d+)(?:\.\d+)*$/.exec(wanted);
  if (match === null) return { status: 'unparsable', wanted };
  // Majors only - `.nvmrc` says `22`, and the native binding cares about the
  // ABI, which is per major.
  const wantedMajor = Number(match[1]);
  const runningMajor = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
  if (runningMajor !== wantedMajor) {
    return { status: 'mismatch', wantedMajor, nodeVersion, execPath };
  }
  return { status: 'ok', wantedMajor, nodeVersion };
}

/**
 * Render a finding as the lines the gate prints and the code it exits with.
 *
 * @param {import('./check-node-version.d.mts').NodeVersionFindings} findings
 * @returns {import('./check-node-version.d.mts').GateReport}
 */
export function formatReport(findings) {
  if (findings.status === 'unreadable') {
    return {
      stdout: [],
      stderr: [`check-node-version: cannot read ${findings.nvmrcPath}: ${findings.detail}`],
      exitCode: 1,
    };
  }
  if (findings.status === 'unparsable') {
    return {
      stdout: [],
      stderr: [
        `check-node-version: .nvmrc says ${JSON.stringify(findings.wanted)}, ` +
          'which is not a Node version',
      ],
      exitCode: 1,
    };
  }
  if (findings.status === 'mismatch') {
    return {
      stdout: [],
      stderr: [
        `check-node-version: Node ${findings.wantedMajor} required (.nvmrc), but this is ` +
          `${findings.nodeVersion} at ${findings.execPath}.\n` +
          '  pnpm runs scripts with the first `node` on PATH, not with the Node that runs pnpm; under\n' +
          '  another major the better-sqlite3 binding refuses to load and the whole suite fails while\n' +
          '  blaming the wrong files. Run `nvm use` (it reads .nvmrc) and retry.',
      ],
      exitCode: 1,
    };
  }
  return {
    stdout: [
      `check-node-version: OK (${findings.nodeVersion} matches .nvmrc ${findings.wantedMajor})`,
    ],
    stderr: [],
    exitCode: 0,
  };
}

// --- CLI wrapper (untested by design; keep it trivial) ---------------------

/**
 * True when this module is the script Node was asked to run.
 *
 * II1 (2026-09-24). Node resolves symlinks in `import.meta.url` but leaves
 * `process.argv[1]` as typed, so comparing the two as URLs made a gate invoked
 * through a symlinked path (a symlinked checkout, say) skip its checks and exit
 * 0. Both sides are resolved to real paths first; if either cannot be resolved
 * the plain URL comparison decides. Duplicated verbatim in the three gate
 * scripts, which share no module on purpose - keep the copies in step.
 *
 * @param {string | undefined} argv1 `process.argv[1]`
 * @param {string} moduleUrl `import.meta.url` of the calling module
 * @returns {boolean}
 */
export function isMainModule(argv1, moduleUrl) {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(argv1).href;
  }
}

const isMain = isMainModule(process.argv[1], import.meta.url);
if (isMain) {
  const report = formatReport(
    evaluateNodeVersion({
      nvmrcPath: NVMRC,
      nodeVersion: process.version,
      execPath: process.execPath,
    }),
  );
  for (const line of report.stdout) console.log(line);
  for (const line of report.stderr) console.error(line);
  if (report.exitCode !== 0) process.exit(report.exitCode);
}
