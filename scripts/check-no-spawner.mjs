// WP-F5 - static no-spawner / no-wide-bind / no-eval gate.
//
// Scans the whole apps/* and packages/* trees (source, tests AND package-root
// config files such as vite.config.ts / vitest.config.ts), plus scripts/,
// hooks/, and the repo-root config files (e.g. eslint.config.mjs), for patterns
// that would violate the project's security invariants (no subprocess surface,
// no wide bind, no WebSocket server, no dynamic code evaluation). Exits 1 and
// lists offenders if any pattern matches.
//
// SCOPE / THREAT MODEL (be honest about the limits of a regex scanner):
//   This gate stops the *idiomatic, honest* ways a spawner / wide bind / WS
//   server / dynamic-eval could be reintroduced during ordinary development or
//   an unreviewed refactor - the whole subprocess API family, `@fastify/
//   websocket` and `{ websocket: true }`, indirect eval and data:/concatenated
//   dynamic import, and the all-interfaces IPv4/IPv6 binds. It is NOT, and
//   cannot be, a defence against a developer who is *deliberately* obfuscating
//   (runtime-assembled strings, char-code arrays, base64). Those are caught by
//   the runtime backstop (`enforceLoopbackOrExit` / loopback-only bind, no
//   spawner in the dependency graph) and by code review - which remain the real
//   controls. This static gate is defence-in-depth, not the last line.
//
// Two escape hatches, both explicit and auditable:
//   - ALLOWLIST: whole files that legitimately contain the patterns - only this
//     policy file itself (it DEFINES the patterns). check-licenses.mjs is NOT
//     whole-file exempt: its one sanctioned `pnpm licenses` subprocess is
//     opted out line-by-line with inline markers, so any *new* forbidden line
//     added to that file is still caught. Allowlisted files are LOGGED on every
//     run, never silent.
//   - Inline marker `spawner-gate-allow`: a single line may opt out when it
//     legitimately names a forbidden string (e.g. a test asserting the guard
//     REJECTS `0.0.0.0`, or the sanctioned `pnpm licenses` argv). Use sparingly;
//     each use is visible in the diff.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Whole trees are scanned (not just src/) so package-root config files - the
// exact place a dev-server bind would be widened - are covered.
const SCAN_ROOTS = ['apps', 'packages', 'scripts', 'hooks'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const PRUNE_DIRS = new Set(['node_modules', 'dist', 'coverage']);

// Files exempt from scanning, keyed by repo-relative path. Logged every run.
// Only this policy file is whole-file exempt (it DEFINES every forbidden
// pattern as a literal). check-licenses.mjs is intentionally NOT here: its
// sanctioned subprocess lines carry inline `spawner-gate-allow` markers, so the
// file is still scanned and any newly added forbidden line is caught.
const ALLOWLIST = new Map([
  ['scripts/check-no-spawner.mjs', 'this gate DEFINES the forbidden patterns'],
]);

// A line carrying this marker opts out (for legitimate mentions, e.g. tests
// that assert a guard rejects a forbidden value).
const INLINE_ALLOW = 'spawner-gate-allow';

/** @type {Array<[string, RegExp]>} */
const FORBIDDEN_PATTERNS = [
  // --- Subprocess surface -------------------------------------------------
  // The whole child_process API family, not just the two names first shipped.
  // `.exec(` / `\.exec\(` is deliberately NOT here: better-sqlite3's
  // `db.exec(sql)` is a legitimate, pervasive call - only child_process-specific
  // identifiers are safe to forbid outright.
  ['child_process module', /child_process/],
  ['execa package', /\bexeca\b/],
  ['.spawn( call', /\.spawn\(/],
  ['spawnSync call', /\bspawnSync\b/],
  ['execSync call', /\bexecSync\b/],
  ['execFile / execFileSync call', /\bexecFile/],
  ['fork( call', /\bfork\(/],
  // Bracket-form access to a subprocess method - `cp['spawn'](...)` - a common
  // half-hearted way to dodge a dot-form matcher.
  [
    'bracket-form subprocess call',
    /\[\s*['"](spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)['"]\s*\]/,
  ],
  // --- Dynamic code evaluation -------------------------------------------
  ['eval( call', /\beval\(/],
  ['indirect eval ((0, eval))', /\(\s*0\s*,\s*eval\s*\)/],
  // Bare `Function(` (not only `new Function(`) - `Function('return ...')()` is
  // an eval by another name.
  ['Function( constructor', /\bFunction\s*\(/],
  ['dynamic import of data: URI', /import\(\s*['"]data:/],
  ['dynamic import with concatenated specifier', /import\(\s*['"][^'"]*['"]\s*\+/],
  // --- Wide network bind --------------------------------------------------
  // Wide-bind forms: literal 0.0.0.0, `host: true`, `host: ''`, and the IPv6
  // all-interfaces binds `host: '::'` / `host: '::0'` all bind every interface.
  // `host: '::1'` (loopback) intentionally does NOT match (a digit other than 0
  // follows `::`, and the quote does not immediately follow).
  ['non-loopback bind (0.0.0.0)', /0\.0\.0\.0/],
  ['wide bind (host: true)', /host\s*:\s*true/],
  ['wide bind (host: empty string)', /host\s*:\s*(['"])\1/],
  ['wide bind (host: "::" / "::0")', /host\s*:\s*['"]::0?['"]/],
  // --- WebSocket (realtime transport is SSE, never WS - CD-5) --------------
  // The `WebSocketServer` identifier, any import/require whose specifier
  // contains "websocket" (catches `@fastify/websocket`, `uWebSockets.js`), the
  // `ws` / socket.io packages (incl. deep imports), and the `{ websocket: true }`
  // Fastify route option that turns a normal route into a WS upgrade.
  ['WebSocketServer', /WebSocketServer/],
  ['websocket import', /\bfrom\s+['"][^'"]*websocket[^'"]*['"]/i],
  ['websocket require', /require\(\s*['"][^'"]*websocket[^'"]*['"]\s*\)/i],
  ['ws/socket.io import', /\bfrom\s+['"](ws|socket\.io)(\/[^'"]*)?['"]/],
  ['ws/socket.io require', /require\(\s*['"](ws|socket\.io)(\/[^'"]*)?['"]\s*\)/],
  ['websocket route option', /websocket\s*:\s*true/i],
];

/** @param {string} dir @returns {string[]} */
function collectSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      files.push(...collectSourceFiles(join(dir, entry.name)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const scanDirs = [];
for (const root of SCAN_ROOTS) {
  const full = join(repoRoot, root);
  if (existsSync(full) && statSync(full).isDirectory()) {
    scanDirs.push(full);
  }
}

// Repo-root config files (e.g. eslint.config.mjs) run in CI/dev but live above
// SCAN_ROOTS. Scan the top level of the repo root too - NON-recursively, so we
// pick up those config files without re-walking (and double-counting) the
// SCAN_ROOTS subtrees or descending into node_modules.
const filesToScan = [];
for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
  if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
    filesToScan.push(join(repoRoot, entry.name));
  }
}
for (const dir of scanDirs) {
  filesToScan.push(...collectSourceFiles(dir));
}

const offenders = [];
const skippedAllowlisted = [];
let scannedFiles = 0;
for (const file of filesToScan) {
  const rel = relative(repoRoot, file);
  if (ALLOWLIST.has(rel)) {
    skippedAllowlisted.push(rel);
    continue;
  }
  scannedFiles += 1;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.includes(INLINE_ALLOW)) return;
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        offenders.push(`${rel}:${index + 1}  [${label}]  ${line.trim()}`);
      }
    }
  });
}

for (const rel of skippedAllowlisted.sort()) {
  console.log(`check-no-spawner: allowlisted (not scanned): ${rel}  (${ALLOWLIST.get(rel)})`);
}

if (offenders.length > 0) {
  console.error('check-no-spawner: FORBIDDEN patterns found:');
  for (const offender of offenders) {
    console.error(`  ${offender}`);
  }
  process.exit(1);
}

console.log(
  `check-no-spawner: OK (${scannedFiles} files scanned across ${scanDirs.length} roots ` +
    `+ repo-root config; ${skippedAllowlisted.length} allowlisted)`,
);
