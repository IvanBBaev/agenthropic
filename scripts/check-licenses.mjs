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
import { execFileSync } from 'node:child_process'; // spawner-gate-allow: sole sanctioned subprocess (fixed-argv `pnpm licenses list`)
import { fileURLToPath } from 'node:url';

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

/** @param {string} expression @returns {boolean} */
function isAllowedExpression(expression) {
  const cleaned = expression.replace(/[()]/g, ' ').trim();
  if (cleaned.length === 0) return false;
  return cleaned
    .split(/\s+OR\s+/)
    .some((orBranch) =>
      orBranch.split(/\s+AND\s+/).every((andPart) => ALLOWED_LICENSES.has(andPart.trim())),
    );
}

// Fixed argv, no shell, no interpolation - hoisted so the call below stays a
// single line and its `spawner-gate-allow` marker cannot be reflowed away.
const PNPM_LICENSES_OPTS = { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 };

let raw;
try {
  raw = execFileSync('pnpm', ['licenses', 'list', '--json'], PNPM_LICENSES_OPTS); // spawner-gate-allow
} catch (error) {
  console.error('check-licenses: failed to run `pnpm licenses list --json`');
  console.error(
    String(error && typeof error === 'object' && 'message' in error ? error.message : error),
  );
  process.exit(1);
}

/** @type {Record<string, Array<{ name: string, versions?: string[], version?: string, license?: string }>>} */
let byLicense;
try {
  byLicense = JSON.parse(raw);
} catch (error) {
  // L-3 (2026-09-07). pnpm can put a warning line ahead of the JSON. That used
  // to escape as a bare SyntaxError with a stack trace, which reads as "the
  // gate is broken" rather than "the gate could not read the license list".
  console.error('check-licenses: `pnpm licenses list --json` did not return parseable JSON');
  console.error(
    String(error && typeof error === 'object' && 'message' in error ? error.message : error),
  );
  console.error(`  first 200 characters received: ${String(raw).slice(0, 200)}`);
  process.exit(1);
}

const offenders = [];
// L-1 / L-4 (2026-09-07). Names and installed versions are counted apart,
// because a package present at two versions is one name and two installs; and
// packages cleared by an exception are counted apart from packages cleared by
// the allowlist, because those are not the same claim.
const appliedExceptions = [];
const exercisedExceptions = new Set();
let checkedNames = 0;
let checkedVersions = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  const allowed = isAllowedExpression(license);
  for (const pkg of packages) {
    if (pkg.name.startsWith('@agenthropic/')) continue; // workspace-local, private
    const versions = pkg.versions ? pkg.versions.join(', ') : (pkg.version ?? '?');
    checkedNames += 1;
    checkedVersions += pkg.versions ? pkg.versions.length : 1;
    if (PACKAGE_EXCEPTIONS.get(pkg.name) === license) {
      appliedExceptions.push(`${pkg.name}@${versions}  [${license}]`);
      exercisedExceptions.add(pkg.name);
      continue;
    }
    if (!allowed) {
      offenders.push(`${pkg.name}@${versions}  [${license}]`);
    }
  }
}

for (const applied of appliedExceptions.sort()) {
  console.log(`check-licenses: documented exception applied (NOT allowlisted): ${applied}`);
}

// L-2 (2026-09-07). Reported, never fatal - see the header note.
for (const name of [...PACKAGE_EXCEPTIONS.keys()].sort()) {
  if (!exercisedExceptions.has(name)) {
    console.log(
      `check-licenses: exception for "${name}" matched nothing in the installed tree - ` +
        'it is a standing permission with no subject and should be removed.',
    );
  }
}

if (offenders.length > 0) {
  console.error('check-licenses: packages with licenses outside the allowlist:');
  for (const offender of offenders) {
    console.error(`  ${offender}`);
  }
  process.exit(1);
}

console.log(
  `check-licenses: OK (${checkedNames} packages / ${checkedVersions} installed versions; ` +
    `${checkedNames - appliedExceptions.length} allowlisted, ` +
    `${appliedExceptions.length} under a documented exception)`,
);
