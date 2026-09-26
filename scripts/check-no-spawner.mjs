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
// AMENDED 2026-09-07 (findings G-1, G-2, G-3). Three ways this gate could print
// OK over source it had not actually looked at:
//   G-1 A root listed in SCAN_ROOTS that does not exist was silently dropped.
//       Renaming `hooks/` would have left the gate passing, printing a smaller
//       root count nobody reads, with a whole tree no longer covered. A missing
//       listed root is now a failure.
//   G-2 A directory entry that is neither a regular file nor a directory - a
//       symlink, above all - was skipped without a word, so a symlinked source
//       file went unscanned under a green "OK". The gate's own stated principle
//       is that exemptions are "LOGGED on every run, never silent"; this one was
//       not. Such entries are now reported and fail the run.
//   G-3 The paragraph above claims "no spawner in the dependency graph" as a
//       control, but nothing checked it: only .ts/.js-family files were read, so
//       `pnpm add execa` landed in a package.json this gate never opened. Direct
//       dependencies of every workspace package.json are now scanned by name.
//       This covers DIRECT dependencies only - a transitive subprocess dep is
//       still outside the gate, and is still the lockfile review's job.
//
// AMENDED 2026-09-23 (findings C-1, C-2). Two more ways this gate could print a
// verdict stronger than what it had established:
//   C-1 SCAN_ROOTS is a hand-maintained list, and G-1 only made a *removed*
//       root loud. A root ADDED to the repo - `tools/`, `bin/`, `e2e/` - was
//       never scanned and nothing said so: a file under it could import the
//       whole subprocess family and this gate still printed OK with a root
//       count nobody cross-checks against the tree. Every top-level directory
//       is now accounted for: it is a scan root, it is pruned, it is an
//       explicit entry in UNSCANNED_TOP_LEVEL (logged every run), or it holds
//       no source file at all. Anything else fails the run.
//   C-2 An ALLOWLIST entry whose path no longer exists produced no output
//       whatsoever, which contradicts this header's own promise that
//       "Allowlisted files are LOGGED on every run, never silent" - a renamed
//       allowlisted file left a dead exemption that nobody could see. Dead
//       entries are now reported. Non-fatal (following the L-2 precedent in
//       check-licenses.mjs): a stale exemption is a hygiene problem, not a
//       security violation, and failing CI over it would tempt people to
//       delete the report rather than the entry.
//
// AMENDED 2026-09-23 (finding L-1). G-2 made a symlink loud, but only inside
// `collectSourceFiles` - the walk of the SCAN_ROOTS trees. Two other places
// classify directory entries and neither applied the same rule, so the exact
// evasion G-2 closed was still open one directory up:
//   - the repo-root census skipped every entry that is not a real directory
//     with a bare `continue`, so both a symlinked root config file
//     (`eslint.config.mjs` pointing elsewhere - the top-level scan reads only
//     `isFile()` entries) and a symlinked TOP-LEVEL DIRECTORY (`tools ->
//     /elsewhere/tools`) were neither scanned nor reported as unregistered;
//   - `countSourceFiles` counted only regular files, so a REAL top-level
//     directory whose source files are all symlinks counted zero and bought the
//     "holds no source file at all" pass - the one branch of the C-1 census
//     that lets a directory go unscanned without a word.
//   Measured 2026-09-23 against a synthetic checkout: all three shapes printed
//   `check-no-spawner: OK` and exited 0 over a file that imported the
//   subprocess module and bound every interface. All three now feed
//   `unreadableEntries` and fail the run, exactly as a symlink inside a scan
//   root already did.
//
// AMENDED 2026-09-24 (findings GG3, GG4, GG5). Three more gaps between what
// this header claims and what the patterns matched:
//   GG3 package.json manifests were read for dependency KEYS only, and the
//       source patterns run over SOURCE_EXTENSIONS only, so a `scripts` entry
//       like `vite --host` (bare, or with a non-loopback value) passed - and the
//       CLI flag overrides the loopback host vite.config sets. Every `scripts`
//       value is now checked for the all-interfaces address and for a `--host`
//       flag not followed by an explicit loopback value.
//   GG4 Only execa was caught in source; the other subprocess wrappers were
//       caught (if at all) as direct dependencies. The dependency denylist now
//       names the common wrappers, and a source pattern flags the same names as
//       import / require / dynamic-import specifiers - so a wrapper pulled in
//       transitively and imported directly is caught too.
//   GG5 "No dynamic code evaluation" did not cover the node vm module. A quoted
//       `vm` / `node:vm` specifier is now forbidden.
//
// AMENDED 2026-09-26 (WP-F5, the no-SSRF half). The work package was always
// "static no-spawner + no-SSRF gate" (development-plan WP-F5; roadmap Phase 1:
// "no-spawner + no-SSRF static gates (F5)"), and CD-7 lists no-SSRF among the
// CI-blocking boundary conditions. Only the spawner half was ever built: this
// gate carried no outbound-network pattern, so a `fetch()` added to the server
// passed CI and the invariant rested on a grep in RELEASE.md §2 run once per
// release. v1.0 has no outbound-dial feature at all, so the strongest form of
// the rule holds and is now enforced: server-process source - `apps/server/src/`
// and `packages/*/src/`, the scope of that release grep - may not reach for an
// outbound network primitive (`fetch(`, the node http/https/http2/net/tls/dgram/
// dns modules, an HTTP client package, a WebSocket / EventSource client,
// XMLHttpRequest), and the server and library manifests may not declare an HTTP
// client package. Browser code in apps/web (which calls this server's own
// relative /api paths) and tests (which call the loopback server they started)
// are out of scope by path, not by exemption. The day v2.0's webhook dispatcher
// (WP-A4) lands, it lands as an inline-marked, reviewed exemption on the one
// line that dials an operator-configured target - never a payload URL - and the
// negative corpus (WP-A10) proves the rest. Same honesty limit as everything
// above: a regex stops the idiomatic reintroduction, not a deliberate evasion.
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
//     AMENDED 2026-09-23 (finding L-6): "both explicit and auditable" was true of
//     the first hatch, which prints a line per exemption on every run, and only
//     half true of this one, whose auditability rested entirely on somebody
//     reviewing the diff that introduced it. The gate itself said nothing.
//     Measured 2026-09-23 on a synthetic checkout: a live `host: '0.0.0.0'` in
//     application source, followed by this marker, produced output byte-identical
//     to the clean run and exit 0 - the one hatch that costs a single comment to
//     add was the one hatch the gate would not mention. Every use is now LOGGED
//     on every run, and a marker that suppressed nothing is reported as dead, on
//     the same "report, do not fail" rule C-2 applies to a dead ALLOWLIST entry.
//
// AMENDED 2026-09-23 (lane-N). Split into an exported pure core (`scanTree`
// returns findings; `formatReport` turns findings into lines and an exit code)
// and a thin CLI wrapper at the bottom, so this gate can be unit-tested by
// IMPORTING it against a throwaway fixture tree. The alternative - spawning the
// script from a test - would have needed a new inline opt-out marker, which
// enlarges the exact exception list SECURITY.md advertises as small and
// auditable: new marked lines to test the gate whose job is keeping marked lines
// rare. Every decision, message, order and exit code below is unchanged; only
// the seam is new. The wrapper itself is NOT covered by any test - it is kept
// small enough to read at a glance instead.
import { readdirSync, readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

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

// C-1: top-level directories that are deliberately NOT scanned, keyed by
// directory name, with the reason. Logged on every run (present or not), so the
// exemption is visible rather than implied by absence from SCAN_ROOTS. A
// top-level directory that is neither a scan root, nor pruned, nor listed here,
// nor empty of source files fails the gate.
const UNSCANNED_TOP_LEVEL = new Map([
  ['.git', 'git internals, not project source'],
  // .github is deliberately NOT exempt: it holds only workflow YAML today, so the
  // "no source files" rule covers it, and the day someone adds a .mjs action there
  // the gate goes loud instead of quietly exempting a file that runs in CI.
  ['.claude', 'local-only AI-harness files, never committed and never shipped'],
  ['spike', 'local-only Phase-0 spike fixtures; untracked, never built, never shipped'],
]);

// A line carrying this marker opts out (for legitimate mentions, e.g. tests
// that assert a guard rejects a forbidden value).
export const INLINE_ALLOW = 'spawner-gate-allow';

// Subprocess wrapper packages, shared by the source pattern and the dependency
// denylist below (GG4) so the two lists cannot drift apart. execa is NOT here:
// it keeps its own, broader word-boundary source pattern.
const SUBPROCESS_WRAPPERS = [
  'cross-spawn',
  'cross-spawn-async',
  'shelljs',
  'node-pty',
  'tinyexec',
  'zx',
  'nano-spawn',
  'spawndamnit',
];

// --- WP-F5 no-SSRF: outbound network primitives in server-process code --------
// Paths (repo-relative, `/`-separated) whose code runs inside the server process
// or is imported by it. Everything else is out of scope by path.
const SERVER_PROCESS_SOURCE = [/^apps\/server\/src\//, /^packages\/[^/]+\/src\//];

// HTTP client packages, shared by the source pattern and the manifest denylist so
// the two lists cannot drift apart (the GG4 rule). Several are ordinary words
// (`got`, `request`, `needle`), so they are matched only as module specifiers.
const HTTP_CLIENTS = [
  'axios',
  'undici',
  'got',
  'node-fetch',
  'cross-fetch',
  'isomorphic-fetch',
  'ky',
  'ofetch',
  'superagent',
  'request',
  'needle',
  'phin',
  'make-fetch-happen',
];

/** @type {Array<[string, RegExp]>} */
const OUTBOUND_PATTERNS = [
  // `\b` keeps `prefetch(` out; `.fetch(` on some object still matches, which is
  // the conservative direction for a rule whose v1.0 form is "no outbound dial".
  ['outbound fetch( call', /\bfetch\s*\(/],
  ['node network module', /['"`](node:)?(https?|http2|net|tls|dgram|dns)(\/[^'"`]*)?['"`]/],
  [
    'HTTP client import',
    new RegExp(
      `(?:\\bfrom\\s+|\\bimport\\s+|\\bimport\\(\\s*|\\brequire\\(\\s*)['"]` +
        `(?:${HTTP_CLIENTS.join('|')})(?:/[^'"]*)?['"]`,
    ),
  ],
  ['WebSocket / EventSource client', /\bnew\s+(WebSocket|EventSource)\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
];

/** @type {Array<[string, RegExp]>} */
const FORBIDDEN_PATTERNS = [
  // --- Subprocess surface -------------------------------------------------
  // The whole child_process API family, not just the two names first shipped.
  // `.exec(` / `\.exec\(` is deliberately NOT here: better-sqlite3's
  // `db.exec(sql)` is a legitimate, pervasive call - only child_process-specific
  // identifiers are safe to forbid outright.
  ['child_process module', /child_process/],
  ['execa package', /\bexeca\b/],
  // GG4: the other subprocess wrappers, matched only as a module specifier
  // (`from '...'`, side-effect `import '...'`, `import('...')`, `require('...')`,
  // deep paths included) - several of these names are short or generic words, so
  // a bare word-boundary match like execa's would misfire on prose.
  [
    'subprocess wrapper import',
    new RegExp(
      `(?:\\bfrom\\s+|\\bimport\\s+|\\bimport\\(\\s*|\\brequire\\(\\s*)['"]` +
        `(?:${SUBPROCESS_WRAPPERS.join('|')})(?:/[^'"]*)?['"]`,
    ),
  ],
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
  // GG5: the vm module compiles and runs strings as code. Matched as a quoted
  // specifier (bare or `node:`-prefixed), so `vm` as an ordinary word is fine.
  ['vm module', /['"`](node:)?vm['"`]/],
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

// --- G-3: forbidden DIRECT dependencies -----------------------------------
// Package names whose mere presence in a workspace package.json contradicts a
// security invariant, whether or not any source file imports them yet. Matched
// against the dependency KEY, so a scoped name like `@fastify/websocket` is
// caught by the websocket pattern.
/** @type {Array<[string, RegExp]>} */
const FORBIDDEN_DEPENDENCIES = [
  [
    'subprocess package',
    new RegExp(`^(${['execa', 'child_process', ...SUBPROCESS_WRAPPERS].join('|')})$`),
  ],
  ['websocket package', /websocket/i],
  ['ws / socket.io package', /^(ws|socket\.io|socket\.io-client)$/],
];

// --- GG3: wide bind through a package.json script ------------------------
// A `--host` CLI flag overrides the host a config file sets, so a loopback
// vite.config is no protection against `vite --host`. Only an explicit loopback
// value is accepted; a bare flag (vite then binds every interface) or any other
// value is a wide bind.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Does this script command widen the bind?
 *
 * @param {string} command
 * @returns {boolean}
 */
function scriptWidensBind(command) {
  if (/0\.0\.0\.0/.test(command)) return true;
  const tokens = command.split(/\s+/).filter((token) => token !== '');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    /** @type {string | undefined} */
    let value;
    if (token === '--host') {
      value = tokens[i + 1];
    } else if (token.startsWith('--host=')) {
      value = token.slice('--host='.length);
    } else {
      continue;
    }
    const host = (value ?? '').replace(/^['"]|['"]$/g, '');
    if (!LOOPBACK_HOSTS.has(host)) return true;
  }
  return false;
}

// Manifests whose package runs in (or is imported by) the server process. The
// root and apps/web manifests are out of scope, like their source.
const SERVER_PROCESS_MANIFESTS = [
  /^apps\/server\/package\.json$/,
  /^packages\/[^/]+\/package\.json$/,
];
const HTTP_CLIENT_DEPENDENCY = new RegExp(`^(${HTTP_CLIENTS.join('|')})$`);

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/**
 * Every source file under `dir`, recursively.
 *
 * @param {string} dir
 * @param {string[]} unreadable collector for entries that are neither a regular
 *   file nor a directory; mutated in place (G-2).
 * @returns {string[]}
 */
function collectSourceFiles(dir, unreadable) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      files.push(...collectSourceFiles(join(dir, entry.name), unreadable));
    } else if (entry.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(join(dir, entry.name));
      }
    } else {
      // G-2 (2026-09-07). Anything that is neither a regular file nor a
      // directory - in practice a symlink, which reports false for BOTH
      // isFile() and isDirectory() - used to fall out of this loop silently.
      // A symlinked source file was therefore never read, and the run still
      // ended in "OK". Record it; the caller fails the gate on it.
      unreadable.push(join(dir, entry.name));
    }
  }
  return files;
}

// --- C-1: every top-level directory must be accounted for -----------------
// SCAN_ROOTS is hand-maintained, so a directory added to the repo tomorrow is
// unscanned by default and, before this check, silently so. Census the repo
// root and classify each directory: scan root, pruned, explicitly exempt, or
// empty of source files. Anything left over is a coverage hole reported as a
// failure, because "this gate did not look here" must never read as "OK".
/**
 * @param {string} dir
 * @param {string[]} unreadable
 * @returns {number}
 */
function countSourceFiles(dir, unreadable) {
  let found = 0;
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable directory: treat as potentially holding source, so it cannot
    // buy a silent pass by being unreadable.
    return 1;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      found += countSourceFiles(join(dir, entry.name), unreadable);
    } else if (entry.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(entry.name))) found += 1;
    } else {
      // L-1 (2026-09-23). Neither a regular file nor a directory - in practice a
      // symlink, which is not followed, so what it points at is unknown. Count
      // it as source: a directory must not earn the "holds no source file at
      // all" pass on the strength of entries this census cannot see through.
      // Same rule as the unreadable-directory branch above, and the same rule
      // G-2 already applies inside the scan roots.
      unreadable.push(join(dir, entry.name));
      found += 1;
    }
  }
  return found;
}

/**
 * @param {string} dir
 * @param {boolean} atTopLevel
 * @param {string[]} manifests mutated in place.
 */
function collectManifests(dir, atTopLevel, manifests) {
  const manifest = join(dir, 'package.json');
  if (existsSync(manifest)) manifests.push(manifest);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (PRUNE_DIRS.has(entry.name)) continue;
    if (atTopLevel && UNSCANNED_TOP_LEVEL.has(entry.name)) continue;
    collectManifests(join(dir, entry.name), false, manifests);
  }
}

/**
 * Walk `rootDir` and report what is there, without printing or exiting.
 *
 * Every path in the result is relative to `rootDir`, and `rootDir` is a
 * parameter rather than this repo, so a test can point the whole gate at a
 * throwaway fixture tree. `stage` says how far the walk got: the two early
 * stages are coverage failures that stop the run before any file is read, in
 * the same order the CLI used to exit in.
 *
 * @param {string} rootDir
 * @returns {import('./check-no-spawner.d.mts').SpawnerFindings}
 */
export function scanTree(rootDir) {
  /** @type {string[]} */
  const unreadable = [];
  /** @type {import('./check-no-spawner.d.mts').SpawnerFindings} */
  const findings = {
    stage: 'scanned',
    missingRoots: [],
    unregisteredTopLevel: [],
    exemptedTopLevel: [],
    absentExemptions: [],
    skippedAllowlisted: [],
    deadAllowlistEntries: [],
    inlineAllowSites: [],
    deadInlineAllowSites: [],
    unreadableEntries: [],
    offenders: [],
    scannedFiles: 0,
    scanRoots: 0,
    scannedManifests: 0,
    outboundScannedFiles: 0,
  };

  const scanDirs = [];
  for (const root of SCAN_ROOTS) {
    const full = join(rootDir, root);
    if (existsSync(full) && statSync(full).isDirectory()) {
      scanDirs.push(full);
    } else {
      // G-1 (2026-09-07). A listed root that has been renamed or removed used to
      // vanish from scanDirs without comment, and the gate went on to print OK
      // with a quietly smaller root count. Coverage shrinking is exactly the
      // event a security gate must not report as success.
      findings.missingRoots.push(root);
    }
  }
  findings.scanRoots = scanDirs.length;
  if (findings.missingRoots.length > 0) {
    findings.stage = 'missing-roots';
    return findings;
  }

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      // L-1 (2026-09-23). A root entry that is neither a regular file nor a
      // directory is a symlink. If it points at a directory, that whole tree is
      // invisible to this census AND to the scan; if it points at a source file,
      // the `isFile()`-only top-level scan below never reads it. Either way the
      // gate has not looked, so it must not continue past it in silence.
      if (!entry.isFile()) unreadable.push(join(rootDir, entry.name));
      continue;
    }
    if (PRUNE_DIRS.has(entry.name)) continue;
    if (SCAN_ROOTS.includes(entry.name)) continue;
    if (UNSCANNED_TOP_LEVEL.has(entry.name)) {
      findings.exemptedTopLevel.push(entry.name);
      continue;
    }
    const sourceCount = countSourceFiles(join(rootDir, entry.name), unreadable);
    // A directory holding no source file at all (docs/, data/) is covered by
    // definition - there is nothing here to scan. The moment one appears, the
    // directory stops being covered and this check goes loud.
    if (sourceCount > 0) findings.unregisteredTopLevel.push([entry.name, sourceCount]);
  }
  for (const name of UNSCANNED_TOP_LEVEL.keys()) {
    if (!findings.exemptedTopLevel.includes(name)) findings.absentExemptions.push(name);
  }

  findings.unreadableEntries = unreadable.map((entry) => relative(rootDir, entry));
  if (findings.unregisteredTopLevel.length > 0) {
    findings.stage = 'unregistered-top-level';
    return findings;
  }

  // Repo-root config files (e.g. eslint.config.mjs) run in CI/dev but live above
  // SCAN_ROOTS. Scan the top level of the repo root too - NON-recursively, so we
  // pick up those config files without re-walking (and double-counting) the
  // SCAN_ROOTS subtrees or descending into node_modules.
  const filesToScan = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      filesToScan.push(join(rootDir, entry.name));
    }
  }
  for (const dir of scanDirs) {
    filesToScan.push(...collectSourceFiles(dir, unreadable));
  }

  for (const file of filesToScan) {
    const rel = relative(rootDir, file);
    if (ALLOWLIST.has(rel)) {
      findings.skippedAllowlisted.push(rel);
      continue;
    }
    findings.scannedFiles += 1;
    const serverProcess = SERVER_PROCESS_SOURCE.some((prefix) =>
      prefix.test(rel.split('\\').join('/')),
    );
    if (serverProcess) findings.outboundScannedFiles += 1;
    const patterns = serverProcess
      ? [...FORBIDDEN_PATTERNS, ...OUTBOUND_PATTERNS]
      : FORBIDDEN_PATTERNS;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes(INLINE_ALLOW)) {
        // L-6 (2026-09-23). Split in two on purpose: a marker that actually
        // suppressed a match is a standing exemption and is named with the rule
        // it suppressed, while a marker on a line no pattern would have flagged
        // is dead weight that will be copied to the next line someone wants past
        // the gate.
        const suppressed = patterns
          .filter(([, pattern]) => pattern.test(line))
          .map(([label]) => label);
        if (suppressed.length > 0) {
          findings.inlineAllowSites.push(`${rel}:${index + 1}  [${suppressed.join(', ')}]`);
        } else {
          findings.deadInlineAllowSites.push(`${rel}:${index + 1}`);
        }
        return;
      }
      for (const [label, pattern] of patterns) {
        if (pattern.test(line)) {
          findings.offenders.push(`${rel}:${index + 1}  [${label}]  ${line.trim()}`);
        }
      }
    });
  }

  // C-2 (2026-09-23). An ALLOWLIST entry that matched no file printed nothing at
  // all, so a renamed allowlisted file left an invisible dead exemption while the
  // header promised every exemption is logged. Report it; do not fail on it.
  for (const rel of ALLOWLIST.keys()) {
    if (!findings.skippedAllowlisted.includes(rel)) findings.deadAllowlistEntries.push(rel);
  }

  // --- G-3: workspace package.json direct dependencies ----------------------
  // The repo-root manifest plus every manifest below it. Read with the same
  // "missing is loud" rule as everything else: a manifest that cannot be parsed
  // is an offender, not a shrug.
  //
  // AMENDED 2026-09-23 (finding L-5). "Direct dependencies of every workspace
  // package.json are now scanned by name" (the G-3 note in the header) was the
  // claim; the code opened the root manifest and `<apps|packages>/*/package.json`
  // and nothing else. Any manifest one step off that shape was invisible, and the
  // nearest one is not hypothetical: `hooks/` is a SCAN ROOT, so a package.json
  // added there is inside the trees this gate advertises as covered. Measured
  // 2026-09-23 against a synthetic checkout, twice: `hooks/package.json` declaring
  // `execa` and `ws`, and `apps/web/plugins/relay/package.json` declaring
  // `socket.io`, each printed `check-no-spawner: OK (... 3 package.json manifests
  // checked for forbidden direct dependencies)` and exited 0. The identical
  // dependency in `apps/server/package.json` failed the run, which is what makes
  // it a coverage hole rather than a policy gap. The collector now walks the tree
  // instead of guessing its shape, under exactly the rules the rest of the gate
  // uses: `PRUNE_DIRS` at any depth, `UNSCANNED_TOP_LEVEL` at the top level (so
  // `.claude/worktrees/*` stays out, as its exemption already says), and any new
  // top-level directory still has to pass the C-1 census first.
  const manifests = [];
  collectManifests(rootDir, true, manifests);

  for (const manifest of manifests) {
    const rel = relative(rootDir, manifest);
    findings.scannedManifests += 1;
    /** @type {Record<string, unknown>} */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch (error) {
      findings.offenders.push(`${rel}  [unparseable manifest]  ${String(error)}`);
      continue;
    }
    const serverProcessManifest = SERVER_PROCESS_MANIFESTS.some((pattern) =>
      pattern.test(rel.split('\\').join('/')),
    );
    for (const field of DEPENDENCY_FIELDS) {
      const block = parsed[field];
      if (block === null || typeof block !== 'object') continue;
      for (const name of Object.keys(block)) {
        for (const [label, pattern] of FORBIDDEN_DEPENDENCIES) {
          if (pattern.test(name)) {
            findings.offenders.push(`${rel}  [${label}]  ${field}.${name}`);
          }
        }
        // WP-F5 no-SSRF: an HTTP client in a server-process package.
        if (serverProcessManifest && HTTP_CLIENT_DEPENDENCY.test(name)) {
          findings.offenders.push(`${rel}  [HTTP client package]  ${field}.${name}`);
        }
      }
    }
    // GG3: every script value, checked for a wide bind.
    const scripts = parsed.scripts;
    if (scripts !== null && typeof scripts === 'object') {
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command === 'string' && scriptWidensBind(command)) {
          findings.offenders.push(
            `${rel}  [wide bind in package.json script]  scripts.${name}: ${command}`,
          );
        }
      }
    }
  }

  findings.unreadableEntries = unreadable.map((entry) => relative(rootDir, entry));
  return findings;
}

/**
 * Render findings as the lines the gate prints and the code it exits with.
 *
 * The order below is the order the CLI printed in before this split, and the
 * strings are byte-identical to what it printed.
 *
 * @param {import('./check-no-spawner.d.mts').SpawnerFindings} findings
 * @returns {import('./check-no-spawner.d.mts').GateReport}
 */
export function formatReport(findings) {
  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];

  if (findings.stage === 'missing-roots') {
    stderr.push(
      'check-no-spawner: SCAN_ROOTS entries do not exist, so those trees would go ' +
        'unscanned while this gate reported OK:',
    );
    for (const root of findings.missingRoots) {
      stderr.push(`  ${root}/`);
    }
    stderr.push('  Fix the path, or remove the root from SCAN_ROOTS deliberately.');
    return { stdout, stderr, exitCode: 1 };
  }

  if (findings.stage === 'unregistered-top-level') {
    stderr.push(
      'check-no-spawner: top-level directories hold source files but are in neither ' +
        'SCAN_ROOTS nor UNSCANNED_TOP_LEVEL, so they would go unscanned while this ' +
        'gate reported OK:',
    );
    for (const [name, count] of [...findings.unregisteredTopLevel].sort()) {
      // L-1 (2026-09-23): the count now also includes entries this census could
      // not see through (an unreadable subdirectory, a symlink it will not
      // follow), so the label says so rather than asserting they are all files.
      stderr.push(`  ${name}/  (${count} source file(s) or unfollowed entr(y/ies))`);
    }
    stderr.push(
      '  Add it to SCAN_ROOTS to scan it, or to UNSCANNED_TOP_LEVEL with a reason ' +
        'to exempt it on the record.',
    );
    return { stdout, stderr, exitCode: 1 };
  }

  for (const rel of [...findings.skippedAllowlisted].sort()) {
    stdout.push(`check-no-spawner: allowlisted (not scanned): ${rel}  (${ALLOWLIST.get(rel)})`);
  }
  for (const rel of [...findings.deadAllowlistEntries].sort()) {
    stdout.push(
      `check-no-spawner: allowlist entry matched no file (dead exemption, not fatal): ${rel}`,
    );
  }

  // L-6 (2026-09-23). The inline hatch is now as loud as the whole-file one.
  // Printed in scan order, which is already file-then-ascending-line, and NOT
  // `.sort()`ed: a lexical sort puts `:167` ahead of `:36` in the same file, which
  // reads as a bug in the report rather than as the ordering it is. Same reason
  // the offender list below is printed in the order it was built.
  for (const site of findings.inlineAllowSites) {
    stdout.push(`check-no-spawner: inline opt-out in force (line not scanned): ${site}`);
  }
  for (const site of findings.deadInlineAllowSites) {
    stdout.push(
      `check-no-spawner: inline opt-out suppressed nothing (dead marker, not fatal): ${site}`,
    );
  }

  // C-1 (2026-09-23). Exempt top-level directories are logged present or absent,
  // for the same reason: an exemption nobody can see is not an exemption, it is a
  // blind spot.
  for (const name of [...findings.exemptedTopLevel].sort()) {
    stdout.push(
      `check-no-spawner: top-level directory exempt (not scanned): ${name}/  ` +
        `(${UNSCANNED_TOP_LEVEL.get(name)})`,
    );
  }
  for (const name of [...findings.absentExemptions].sort()) {
    stdout.push(`check-no-spawner: exemption unused, directory absent in this checkout: ${name}/`);
  }

  if (findings.unreadableEntries.length > 0) {
    // AMENDED 2026-09-23 (finding L-1). This message used to say the entries were
    // "found inside the scanned trees" and to advise moving them "outside the scan
    // roots". Since L-1 the same list also carries repo-root entries, for which
    // both halves were false: a symlink at the repo root is already outside every
    // scan root, and the advice as written described the offending state as the
    // fix. The wording now covers where the gate actually looks.
    stderr.push(
      'check-no-spawner: entries that are neither a regular file nor a directory were ' +
        'found in the scanned trees or at the repo root. They are not read, so anything ' +
        'they point at would pass unscanned:',
    );
    for (const entry of [...findings.unreadableEntries].sort()) {
      stderr.push(`  ${entry}`);
    }
    stderr.push(
      '  Replace the link with a real file, or move what it points at into the tree ' +
        'so the gate can read it.',
    );
    return { stdout, stderr, exitCode: 1 };
  }

  if (findings.offenders.length > 0) {
    stderr.push('check-no-spawner: FORBIDDEN patterns found:');
    for (const offender of findings.offenders) {
      stderr.push(`  ${offender}`);
    }
    return { stdout, stderr, exitCode: 1 };
  }

  stdout.push(
    `check-no-spawner: OK (${findings.scannedFiles} files scanned across ${findings.scanRoots} roots ` +
      `+ repo-root config; ${findings.skippedAllowlisted.length} allowlisted; ` +
      `${findings.inlineAllowSites.length} line(s) inline-exempt; ` +
      `${findings.scannedManifests} package.json manifests checked for forbidden direct dependencies ` +
      `and wide-bind scripts; ${findings.outboundScannedFiles} server-process files checked for ` +
      `outbound network calls)`,
  );
  return { stdout, stderr, exitCode: 0 };
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
  const report = formatReport(scanTree(REPO_ROOT));
  for (const line of report.stdout) console.log(line);
  for (const line of report.stderr) console.error(line);
  if (report.exitCode !== 0) process.exit(report.exitCode);
}
