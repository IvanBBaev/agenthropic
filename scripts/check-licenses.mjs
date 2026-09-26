// WP-F6 / CD-9 - license allowlist gate.
//
// Lists every installed dependency (prod + dev, whole workspace) via
// `pnpm licenses list --json` and exits 1 if any package's license falls
// outside the allowlist. SPDX OR-expressions pass if at least one branch is
// allowlisted; AND-expressions require every part to be allowlisted.
//
// AMENDED 2026-09-07 (findings L-1, L-2, L-3, L-4). Four things this gate used
// to say that were not quite what had happened:
//   L-1 A package cleared by PACKAGE_EXCEPTIONS was counted into the final
//       "all licenses allowlisted" line and printed nowhere. `caniuse-lite` is
//       CC-BY-4.0, which is NOT on the allowlist; it is excepted. Reporting an
//       exception as an allowlisted license is the one sentence a license gate
//       must not get wrong. Applied exceptions are now listed on every run and
//       counted separately, matching the sibling gate's rule that an exemption
//       is "LOGGED on every run, never silent".
//   L-2 An exception that matched nothing was invisible: drop the package and
//       its standing permission lives on forever, unaudited. Unused exceptions
//       are now named on every run. Deliberately NOT fatal - an ordinary
//       dependency bump can legitimately retire a package, and turning that
//       into a red build would teach people to delete the report rather than
//       read it. Dead permission is a visibility problem, not a broken tree.
//   L-3 `JSON.parse` sat outside the try, so anything pnpm printed ahead of the
//       JSON surfaced as a raw SyntaxError and a stack trace - the gate looked
//       broken rather than unable to read the license list.
//   L-4 "N installed packages" was a count of package NAMES. A package present
//       at two versions counted once, so the number understated the installed
//       tree (412 names against 429 installed versions at the time of writing).
//
// AMENDED 2026-09-23 (finding C-3). The final line reported an empty scan as a
// pass: `pnpm licenses list --json` returning `{}` - or `[]`, a wrong shape that
// parses perfectly well - printed "OK (0 packages / 0 installed versions)" and
// exited 0. Zero violations found in zero packages is not a clean tree, it is a
// gate that never looked, and in CI that is indistinguishable from success. The
// shape is now validated and an empty inspection is a failure.
import { execFileSync } from 'node:child_process'; // spawner-gate-allow: the only sanctioned subprocess in scripts/ (fixed-argv `pnpm licenses list`)
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  // MIT-0 is MIT with the attribution clause removed - strictly fewer
  // obligations than MIT, which is already allowlisted.
  'MIT-0',
]);

// Documented per-package exceptions: package name -> exact license we accept
// for it. Keep this list short and justified.
const PACKAGE_EXCEPTIONS = new Map([
  // Browser-support data file pulled in transitively by browserslist (vite
  // toolchain). CC-BY-4.0 applies to the data, requires attribution only,
  // and is the license the entire frontend ecosystem ships this package under.
  ['caniuse-lite', 'CC-BY-4.0'],
]);

/**
 * Split an SPDX expression into licence ids, parentheses and operators.
 *
 * @param {string} expression
 * @returns {string[]}
 */
function tokenizeExpression(expression) {
  return expression
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Is every obligation this SPDX expression can impose one we have allowlisted?
 *
 * Grammar (the subset npm package metadata uses), AND binding tighter than OR
 * exactly as SPDX specifies:
 *   or   := and ( 'OR' and )*
 *   and  := atom ( 'AND' atom )*
 *   atom := '(' or ')' | <licence-id>
 *
 * Anything this grammar cannot read - an unbalanced parenthesis, a `WITH`
 * exception, a trailing operator, an empty string - is NOT allowed. An
 * expression the gate cannot parse is an expression whose obligations it has
 * not established, and the whole point of the gate is to refuse those.
 *
 * AMENDED 2026-09-23 (finding L-2). This used to delete every parenthesis and
 * then split on OR before AND, which silently REASSOCIATED any expression whose
 * grouping was explicit. `(MIT OR Apache-2.0) AND CC-BY-NC-4.0` - a perfectly
 * ordinary SPDX shape, and one whose AND-term is a non-commercial licence that
 * is not on the allowlist - flattened to `MIT OR Apache-2.0 AND CC-BY-NC-4.0`,
 * whose first OR-branch is the bare token `MIT`. Measured 2026-09-23 with that
 * one licence key fed to this script: `check-licenses: OK (1 packages / 1
 * installed versions; 1 allowlisted, 0 under a documented exception)`, exit 0 -
 * the package was not merely let through, it was REPORTED AS ALLOWLISTED. The
 * two parenthesised keys actually installed today (`(MIT OR WTFPL)` and
 * `(BSD-2-Clause OR MIT OR Apache-2.0)`) still pass, because they are genuine
 * OR-groups; what no longer passes is a group whose AND-term was thrown away.
 *
 * @param {string} expression
 * @returns {boolean}
 */
function isAllowedExpression(expression) {
  const tokens = tokenizeExpression(expression);
  let index = 0;

  /** @returns {boolean | null} `null` means "could not parse" - never allowed. */
  function parseOrExpression() {
    let value = parseAndExpression();
    if (value === null) return null;
    while (tokens[index] === 'OR') {
      index += 1;
      const right = parseAndExpression();
      if (right === null) return null;
      value = value || right;
    }
    return value;
  }

  /** @returns {boolean | null} */
  function parseAndExpression() {
    let value = parseAtom();
    if (value === null) return null;
    while (tokens[index] === 'AND') {
      index += 1;
      const right = parseAtom();
      if (right === null) return null;
      value = value && right;
    }
    return value;
  }

  /** @returns {boolean | null} */
  function parseAtom() {
    const token = tokens[index];
    if (token === undefined || token === ')' || token === 'AND' || token === 'OR') return null;
    if (token === '(') {
      index += 1;
      const inner = parseOrExpression();
      if (inner === null || tokens[index] !== ')') return null;
      index += 1;
      return inner;
    }
    index += 1;
    return ALLOWED_LICENSES.has(token);
  }

  // Trailing tokens mean the parse stopped early (`Apache-2.0 WITH
  // LLVM-exception` stops at `WITH`), which is a parse this gate did not
  // complete and therefore a licence it has not cleared.
  return parseOrExpression() === true && index === tokens.length;
}

// Fixed argv, no shell, no interpolation - hoisted so the call below stays a
// single line and its `spawner-gate-allow` marker cannot be reflowed away.
const PNPM_LICENSES_OPTS = { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 };

function readLicenseOutput() {
  try {
    return execFileSync('pnpm', ['licenses', 'list', '--json'], PNPM_LICENSES_OPTS); // spawner-gate-allow
  } catch (error) {
    console.error('check-licenses: failed to run `pnpm licenses list --json`');
    console.error(
      String(error && typeof error === 'object' && 'message' in error ? error.message : error),
    );
    process.exit(1);
  }
}

/**
 * Classify every package in one `pnpm licenses list --json` payload.
 *
 * AMENDED 2026-09-23 (lane-N). Everything from the JSON parse down used to be
 * top-level statements, so the only way to exercise this gate's decisions was to
 * RUN it - which from a test means spawning it and giving that spawn an inline
 * opt-out marker, enlarging the very exception list SECURITY.md advertises as
 * small and auditable. It is now an exported pure core plus the thin CLI
 * wrapper at the bottom. The decisions, the messages, the counting and the exit
 * codes are unchanged; only the seam is new. `readLicenseOutput` above and the
 * wrapper below are NOT covered by any test - the core is.
 *
 * @param {string} raw stdout of `pnpm licenses list --json`
 * @returns {import('./check-licenses.d.mts').LicenseFindings}
 */
export function evaluateLicenses(raw) {
  /** @type {Record<string, Array<{ name: string, versions?: string[], version?: string, license?: string }>>} */
  let byLicense;
  try {
    byLicense = JSON.parse(raw);
  } catch (error) {
    // L-3 (2026-09-07). pnpm can put a warning line ahead of the JSON. That used
    // to escape as a bare SyntaxError with a stack trace, which reads as "the
    // gate is broken" rather than "the gate could not read the license list".
    return {
      status: 'unparseable',
      detail: String(
        error && typeof error === 'object' && 'message' in error ? error.message : error,
      ),
      raw: String(raw),
    };
  }

  // C-3 (2026-09-23). `[]` and `"x"` are valid JSON and would walk straight into
  // the loop below - the array yielding zero packages and a green OK, the string
  // yielding a TypeError. Neither is a license list.
  if (byLicense === null || typeof byLicense !== 'object' || Array.isArray(byLicense)) {
    return {
      status: 'wrong-shape',
      received: Array.isArray(byLicense) ? 'array' : typeof byLicense,
    };
  }

  const offenders = [];
  // L-1 / L-4 (2026-09-07). Names and installed versions are counted apart,
  // because a package present at two versions is one name and two installs; and
  // packages cleared by an exception are counted apart from packages cleared by
  // the allowlist, because those are not the same claim.
  //
  // II4 (2026-09-24). pnpm groups by licence, so a package whose licence changed
  // between two installed versions appears once under each licence. Counting one
  // per entry made that one name count twice, in the package figure and in the
  // allowlisted figure. Names are now collected in sets; versions stay per entry.
  const appliedExceptions = [];
  const exercisedExceptions = new Set();
  const checkedNameSet = new Set();
  const allowlistedNameSet = new Set();
  let checkedVersions = 0;
  for (const [license, packages] of Object.entries(byLicense)) {
    const allowed = isAllowedExpression(license);
    for (const pkg of packages) {
      if (pkg.name.startsWith('@agenthropic/')) continue; // workspace-local, private
      const versions = pkg.versions ? pkg.versions.join(', ') : (pkg.version ?? '?');
      checkedNameSet.add(pkg.name);
      checkedVersions += pkg.versions ? pkg.versions.length : 1;
      if (PACKAGE_EXCEPTIONS.get(pkg.name) === license) {
        appliedExceptions.push(`${pkg.name}@${versions}  [${license}]`);
        exercisedExceptions.add(pkg.name);
        continue;
      }
      if (allowed) {
        allowlistedNameSet.add(pkg.name);
      } else {
        offenders.push(`${pkg.name}@${versions}  [${license}]`);
      }
    }
  }

  return {
    status: 'inspected',
    offenders,
    appliedExceptions,
    // L-2 (2026-09-07). An exception that matched nothing is a standing
    // permission with no subject - reported, never fatal (see the header note).
    unusedExceptions: [...PACKAGE_EXCEPTIONS.keys()].filter(
      (name) => !exercisedExceptions.has(name),
    ),
    checkedNames: checkedNameSet.size,
    checkedVersions,
    allowlistedNames: allowlistedNameSet.size,
    exceptionNames: exercisedExceptions.size,
  };
}

/**
 * Render findings as the lines the gate prints and the code it exits with.
 *
 * @param {import('./check-licenses.d.mts').LicenseFindings} findings
 * @returns {import('./check-licenses.d.mts').GateReport}
 */
export function formatReport(findings) {
  if (findings.status === 'unparseable') {
    return {
      stdout: [],
      stderr: [
        'check-licenses: `pnpm licenses list --json` did not return parseable JSON',
        findings.detail,
        `  first 200 characters received: ${findings.raw.slice(0, 200)}`,
      ],
      exitCode: 1,
    };
  }
  if (findings.status === 'wrong-shape') {
    return {
      stdout: [],
      stderr: [
        'check-licenses: `pnpm licenses list --json` returned valid JSON of the wrong shape ' +
          '(expected an object keyed by license expression)',
        `  received: ${findings.received}`,
      ],
      exitCode: 1,
    };
  }

  const stdout = [];
  for (const applied of [...findings.appliedExceptions].sort()) {
    stdout.push(`check-licenses: documented exception applied (NOT allowlisted): ${applied}`);
  }
  for (const name of [...findings.unusedExceptions].sort()) {
    stdout.push(
      `check-licenses: exception for "${name}" matched nothing in the installed tree - ` +
        'it is a standing permission with no subject and should be removed.',
    );
  }

  // C-3 (2026-09-23). Nothing inspected is not the same claim as nothing wrong.
  // An empty tree here means the workspace is not installed, pnpm changed its
  // output, or the filter excluded everything - each of which leaves the license
  // invariant unverified, so none of them may print OK.
  if (findings.checkedNames === 0) {
    return {
      stdout,
      stderr: [
        'check-licenses: no third-party packages were inspected, so no license was ' +
          'actually verified. Refusing to report a pass over an empty scan.',
        '  Check that the workspace is installed (`pnpm install`) and that ' +
          '`pnpm licenses list --json` lists dependencies.',
      ],
      exitCode: 1,
    };
  }

  if (findings.offenders.length > 0) {
    return {
      stdout,
      stderr: [
        'check-licenses: packages with licenses outside the allowlist:',
        ...findings.offenders.map((offender) => `  ${offender}`),
      ],
      exitCode: 1,
    };
  }

  stdout.push(
    `check-licenses: OK (${findings.checkedNames} packages / ` +
      `${findings.checkedVersions} installed versions; ` +
      `${findings.allowlistedNames} allowlisted, ` +
      `${findings.exceptionNames} under a documented exception)`,
  );
  return { stdout, stderr: [], exitCode: 0 };
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
  const report = formatReport(evaluateLicenses(readLicenseOutput()));
  for (const line of report.stdout) console.log(line);
  for (const line of report.stderr) console.error(line);
  if (report.exitCode !== 0) process.exit(report.exitCode);
}
