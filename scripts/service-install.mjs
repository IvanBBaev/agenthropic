#!/usr/bin/env node
// R1 / OPS-1 - install agenthropic as a per-user launchd service (macOS).
//
// Writes ~/Library/LaunchAgents/<label>.plist so the server starts at login and
// is restarted after a crash, then PRINTS the `launchctl` commands that load it.
// It never runs them: this repo has no subprocess surface (see
// scripts/check-no-spawner.mjs), and loading a service is the operator's call.
//
// The plist runs the TypeScript source from apps/server under tsx's loader, the
// same transform `pnpm --filter @agenthropic/server start` uses, because the
// migration checksums are pinned to it (apps/server/package.json "//"). It runs
// `node --import <tsx loader> src/index.ts`, ONE process, not the tsx CLI: the
// CLI runs the server as a child, and on SIGTERM it waits only ~30 ms for the
// child to acknowledge before it SIGKILLs it, so a loaded machine lost the
// graceful shutdown on every `launchctl bootout` (observed 2026-11-08, exit 143).
// Node is the absolute path of a Node 22 binary, never whatever `node` the
// login PATH resolves to (on this machine that is Node 26, which cannot load the
// better-sqlite3 build).
//
// The token comes from DASHBOARD_TOKEN in the environment that runs this
// script, never from argv, so it stays out of shell history and `ps`. It is
// written into the plist's EnvironmentVariables, and the plist is created 0600.
// The hooks read the same variable from Claude Code's environment, so export it
// from your shell profile too (see hooks/README.md).
//
// Usage:
//   node scripts/service-install.mjs             # dry run: print the plist, token masked
//   node scripts/service-install.mjs --write     # write the plist, print the launchctl steps
//   Options: --node <path> --db <path> --port <n> --label <label>

import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_LABEL = 'io.github.ivanbbaev.agenthropic';
export const REQUIRED_NODE_MAJOR = 22;
/** Mirrors MIN_TOKEN_LENGTH in packages/shared/src/security/index.ts. */
export const MIN_TOKEN_LENGTH = 16;
export const TOKEN_MASK = '<DASHBOARD_TOKEN from the environment>';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {readonly string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ write: boolean, help: boolean, node?: string, db?: string, port?: number, label?: string }} */
  const options = { write: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--write') {
      options.write = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--node' || flag === '--db' || flag === '--port' || flag === '--label') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      i += 1;
      if (flag === '--port') {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
          throw new Error(`--port must be an integer from 1 to 65535, got "${value}"`);
        }
        options.port = Number(value);
      } else if (flag === '--label') {
        if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)) {
          throw new Error(`--label must be reverse-DNS style (letters, digits, dots, dashes)`);
        }
        options.label = value;
      } else {
        if (!isAbsolute(value)) {
          throw new Error(`${flag} must be an absolute path, got "${value}"`);
        }
        options[flag === '--node' ? 'node' : 'db'] = value;
      }
      continue;
    }
    throw new Error(`unknown argument "${flag}" (try --help)`);
  }
  return options;
}

/**
 * The same rules the server applies at boot, so a token the server would refuse
 * is caught here instead of as a crash loop under launchd. Never echoes the value.
 * @param {string | undefined} token
 * @returns {string | null} a problem description, or null when the token is usable
 */
export function checkToken(token) {
  if (token === undefined || token.length === 0) {
    return 'DASHBOARD_TOKEN is not set. Export it before running this script.';
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return `DASHBOARD_TOKEN is too short (${token.length} characters, need ${MIN_TOKEN_LENGTH}).`;
  }
  // eslint-disable-next-line no-control-regex
  if (/^\s|\s$/.test(token) || /[\u0000-\u001f\u007f]/.test(token)) {
    return 'DASHBOARD_TOKEN has leading/trailing whitespace or a control character.';
  }
  return null;
}

/**
 * @param {string} version a `process.version` style string, e.g. "v22.23.2"
 */
export function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(version);
  return match === null ? null : Number(match[1]);
}

/** @param {string} value */
export function xmlEscape(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Every path the service needs, resolved to absolute form.
 * @param {{ home: string, repoRoot: string, label: string, db?: string }} input
 */
export function servicePaths({ home, repoRoot, label, db }) {
  const serverDir = join(repoRoot, 'apps', 'server');
  const logDir = join(home, 'Library', 'Logs', 'agenthropic');
  return {
    plist: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    serverDir,
    tsxLoader: join(serverDir, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
    // The same file `pnpm --filter @agenthropic/server start` uses (its cwd is
    // apps/server and DASHBOARD_DB_PATH defaults to data/agenthropic.db), so a
    // manual run and the service share one database.
    db: db ?? join(serverDir, 'data', 'agenthropic.db'),
    webIndex: join(repoRoot, 'apps', 'web', 'dist', 'index.html'),
    logDir,
    stdoutLog: join(logDir, 'server.log'),
    stderrLog: join(logDir, 'server.err.log'),
  };
}

/**
 * @param {{ label: string, node: string, paths: ReturnType<typeof servicePaths>, home: string, token: string, port?: number }} input
 */
export function buildPlist({ label, node, paths, home, token, port }) {
  /** @type {Array<[string, string]>} */
  const env = [
    ['DASHBOARD_TOKEN', token],
    ['DASHBOARD_DB_PATH', paths.db],
    ['HOME', home],
    // Anything that resolves `node` through PATH must still find Node 22 first.
    ['PATH', `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`],
  ];
  if (port !== undefined) {
    env.push(['DASHBOARD_PORT', String(port)]);
  }
  const s = (value) => `<string>${xmlEscape(value)}</string>`;
  const envXml = env.map(([key, value]) => `      <key>${key}</key>\n      ${s(value)}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${s(label)}
    <key>ProgramArguments</key>
    <array>
      ${s(node)}
      ${s('--import')}
      ${s(pathToFileURL(paths.tsxLoader).href)}
      ${s('src/index.ts')}
    </array>
    <key>WorkingDirectory</key>
    ${s(paths.serverDir)}
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- Restart after a crash or any non-zero exit, never after a clean stop.
         A boot that keeps failing (a config error exits 1) is retried at most
         once per ThrottleInterval; the reason is in server.err.log. -->
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    ${s(paths.stdoutLog)}
    <key>StandardErrorPath</key>
    ${s(paths.stderrLog)}
  </dict>
</plist>
`;
}

/**
 * The commands the operator runs after --write. Printed, never executed.
 * @param {{ label: string, plist: string, port: number }} input
 */
export function launchctlSteps({ label, plist, port }) {
  return [
    'Load and start the service:',
    `  launchctl bootstrap gui/$(id -u) '${plist}'`,
    'Check it:',
    `  launchctl print gui/$(id -u)/${label} | grep -E 'state|pid|last exit'`,
    `  curl -s -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:${port}/api/health`,
    'Restart after a pull:',
    `  launchctl kickstart -k gui/$(id -u)/${label}`,
    'Remove it:',
    `  launchctl bootout gui/$(id -u)/${label} && rm '${plist}'`,
  ];
}

/**
 * Everything that would make the service fail at boot, checked up front.
 * @param {{ node: string, nodeVersion: string, token: string | undefined, paths: ReturnType<typeof servicePaths>, platform: string, exists: (path: string) => boolean }} input
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function preflight({ node, nodeVersion, token, paths, platform, exists }) {
  const errors = [];
  const warnings = [];
  if (platform !== 'darwin') {
    errors.push(`launchd is macOS only (this is ${platform}).`);
  }
  const major = nodeMajor(nodeVersion);
  if (major !== REQUIRED_NODE_MAJOR) {
    errors.push(
      `${node} is Node ${nodeVersion}; the service needs Node ${REQUIRED_NODE_MAJOR}. ` +
        `Run this script with Node ${REQUIRED_NODE_MAJOR} or pass --node <path to a Node ${REQUIRED_NODE_MAJOR} binary>.`,
    );
  }
  const tokenProblem = checkToken(token);
  if (tokenProblem !== null) {
    errors.push(tokenProblem);
  }
  if (!exists(paths.tsxLoader)) {
    errors.push(`${paths.tsxLoader} is missing. Run \`pnpm install\` in the repo first.`);
  }
  if (!exists(paths.webIndex)) {
    warnings.push(
      'The SPA is not built, so the dashboard page would 404 (the API still works). ' +
        'Run `pnpm --filter @agenthropic/web build`, then restart the service.',
    );
  }
  return { errors, warnings };
}

/**
 * @param {{ argv: readonly string[], env: Record<string, string | undefined>, home: string, repoRoot: string, platform: string, execPath: string, nodeVersion: string, exists: (path: string) => boolean, writePlist: (paths: ReturnType<typeof servicePaths>, body: string) => void }} io
 * @returns {{ stdout: string[], stderr: string[], exitCode: 0 | 1 }}
 */
export function run(io) {
  const stdout = [];
  const stderr = [];
  let options;
  try {
    options = parseArgs(io.argv);
  } catch (error) {
    return { stdout, stderr: [`service-install: ${error.message}`], exitCode: 1 };
  }
  if (options.help) {
    return { stdout: [USAGE], stderr, exitCode: 0 };
  }
  const label = options.label ?? DEFAULT_LABEL;
  const node = options.node ?? io.execPath;
  // --node names another binary, whose version this process cannot read
  // without running it; the operator vouches for it, the boot log confirms it.
  const nodeVersion = options.node === undefined ? io.nodeVersion : `v${REQUIRED_NODE_MAJOR}.x`;
  const paths = servicePaths({ home: io.home, repoRoot: io.repoRoot, label, db: options.db });
  const token = io.env['DASHBOARD_TOKEN'];
  const { errors, warnings } = preflight({
    node,
    nodeVersion,
    token,
    paths,
    platform: io.platform,
    exists: io.exists,
  });
  if (options.node !== undefined) {
    warnings.push(
      `${node} is trusted to be Node ${REQUIRED_NODE_MAJOR}; the boot log shows the real version.`,
    );
  }
  for (const warning of warnings) {
    stderr.push(`warning: ${warning}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      stderr.push(`error: ${error}`);
    }
    return { stdout, stderr, exitCode: 1 };
  }
  const port = options.port ?? DEFAULT_PORT_FOR_STEPS;
  if (!options.write) {
    stdout.push(
      buildPlist({ label, node, paths, home: io.home, token: TOKEN_MASK, port: options.port }),
    );
    stdout.push(`Dry run. Re-run with --write to create ${paths.plist}.`);
    return { stdout, stderr, exitCode: 0 };
  }
  io.writePlist(
    paths,
    buildPlist({
      label,
      node,
      paths,
      home: io.home,
      token: /** @type {string} */ (token),
      port: options.port,
    }),
  );
  stdout.push(`Wrote ${paths.plist} (0600). Logs go to ${paths.logDir}.`);
  stdout.push(...launchctlSteps({ label, plist: paths.plist, port }));
  return { stdout, stderr, exitCode: 0 };
}

/** Must match DEFAULT_PORT in apps/server/src/config.ts; only used in printed commands. */
export const DEFAULT_PORT_FOR_STEPS = 7341;

const USAGE = `Usage: node scripts/service-install.mjs [--write] [--node <path>] [--db <path>] [--port <n>] [--label <label>]

Without --write, prints the launchd plist with the token masked and changes nothing.
With --write, creates ~/Library/LaunchAgents/<label>.plist (0600) and the log
directory, then prints the launchctl commands to load it. DASHBOARD_TOKEN must be
set in the environment.`;

/**
 * Creates the plist 0600 and the log and database directories 0700.
 * @param {ReturnType<typeof servicePaths>} paths
 * @param {string} body
 */
export function writePlistToDisk(paths, body) {
  mkdirSync(dirname(paths.plist), { recursive: true });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.db), { recursive: true, mode: 0o700 });
  writeFileSync(paths.plist, body, { mode: 0o600 });
  // writeFileSync keeps the mode of a file that already exists.
  chmodSync(paths.plist, 0o600);
}

/** True when `argv1` resolves to the same file as `moduleUrl` (symlink-safe). */
export function isMainModule(argv1, moduleUrl) {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const result = run({
    argv: process.argv.slice(2),
    env: process.env,
    home: homedir(),
    repoRoot: REPO_ROOT,
    platform: process.platform,
    execPath: process.execPath,
    nodeVersion: process.version,
    exists: existsSync,
    writePlist: writePlistToDisk,
  });
  for (const line of result.stdout) {
    process.stdout.write(`${line}\n`);
  }
  for (const line of result.stderr) {
    process.stderr.write(`${line}\n`);
  }
  process.exitCode = result.exitCode;
}
