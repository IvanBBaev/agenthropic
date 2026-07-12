// WP-F6 / CD-9 - license allowlist gate.
//
// Lists every installed dependency (prod + dev, whole workspace) via
// `pnpm licenses list --json` and exits 1 if any package's license falls
// outside the allowlist. SPDX OR-expressions pass if at least one branch is
// allowlisted; AND-expressions require every part to be allowlisted.
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
const byLicense = JSON.parse(raw);

const offenders = [];
let checkedPackages = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  const allowed = isAllowedExpression(license);
  for (const pkg of packages) {
    if (pkg.name.startsWith('@agenthropic/')) continue; // workspace-local, private
    checkedPackages += 1;
    if (PACKAGE_EXCEPTIONS.get(pkg.name) === license) continue;
    if (!allowed) {
      const versions = pkg.versions ? pkg.versions.join(', ') : (pkg.version ?? '?');
      offenders.push(`${pkg.name}@${versions}  [${license}]`);
    }
  }
}

if (offenders.length > 0) {
  console.error('check-licenses: packages with licenses outside the allowlist:');
  for (const offender of offenders) {
    console.error(`  ${offender}`);
  }
  process.exit(1);
}

console.log(`check-licenses: OK (${checkedPackages} installed packages, all licenses allowlisted)`);
