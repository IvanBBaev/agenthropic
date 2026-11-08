/**
 * R1 / OPS-1: the launchd service installer (scripts/service-install.mjs).
 * The pure core is driven with fake IO; one test writes to a temp HOME to pin
 * the file modes. Nothing here touches the real ~/Library or runs launchctl.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LABEL,
  DEFAULT_PORT_FOR_STEPS,
  TOKEN_MASK,
  buildPlist,
  checkToken,
  isMainModule,
  launchctlSteps,
  nodeMajor,
  parseArgs,
  run,
  servicePaths,
  writePlistToDisk,
  xmlEscape,
} from '../../../scripts/service-install.mjs';
import type { RunIo, ServicePaths } from '../../../scripts/service-install.mjs';
import { DEFAULT_PORT } from '../src/config';

const TOKEN = 'a-perfectly-good-token-0123456789';
const HOME = '/Users/someone';
const REPO = '/Users/someone/src/agenthropic';

function fakeIo(
  overrides: Partial<RunIo> = {},
): RunIo & { written: Array<[ServicePaths, string]> } {
  const written: Array<[ServicePaths, string]> = [];
  return {
    argv: [],
    env: { DASHBOARD_TOKEN: TOKEN },
    home: HOME,
    repoRoot: REPO,
    platform: 'darwin',
    execPath: '/opt/node22/bin/node',
    nodeVersion: 'v22.23.2',
    exists: () => true,
    writePlist: (paths, body) => {
      written.push([paths, body]);
    },
    ...overrides,
    written,
  };
}

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ write: false, help: false });
  });

  it('reads every option', () => {
    expect(
      parseArgs([
        '--write',
        '--node',
        '/n/node',
        '--db',
        '/d/a.db',
        '--port',
        '8000',
        '--label',
        'a.b-c',
        '-h',
      ]),
    ).toEqual({
      write: true,
      help: true,
      node: '/n/node',
      db: '/d/a.db',
      port: 8000,
      label: 'a.b-c',
    });
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it.each([
    [['--node'], '--node needs a value'],
    [['--db', '--write'], '--db needs a value'],
    [['--node', 'node'], 'must be an absolute path'],
    [['--port', '0'], '--port must be an integer'],
    [['--port', '70000'], '--port must be an integer'],
    [['--port', '8e3'], '--port must be an integer'],
    [['--label', 'bad label'], '--label must be reverse-DNS'],
    [['--token', 'x'], 'unknown argument "--token"'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('checkToken', () => {
  it('accepts a usable token and never echoes a bad one', () => {
    expect(checkToken(TOKEN)).toBeNull();
    expect(checkToken(undefined)).toMatch(/not set/);
    expect(checkToken('')).toMatch(/not set/);
    expect(checkToken('short-secret')).toMatch(/too short \(12 characters, need 16\)/);
    expect(checkToken(` ${TOKEN}`)).toMatch(/whitespace or a control/);
    expect(checkToken(`${TOKEN}\n`)).toMatch(/whitespace or a control/);
    expect(checkToken(`${TOKEN}\u0007x`)).toMatch(/whitespace or a control/);
    expect(checkToken(`${TOKEN}\u007fx`)).not.toContain(TOKEN);
  });
});

describe('helpers', () => {
  it('nodeMajor parses process.version strings', () => {
    expect(nodeMajor('v22.23.2')).toBe(22);
    expect(nodeMajor('26.0.0')).toBe(26);
    expect(nodeMajor('garbage')).toBeNull();
  });

  it('xmlEscape escapes the five XML specials', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('the printed default port matches the server default', () => {
    expect(DEFAULT_PORT_FOR_STEPS).toBe(DEFAULT_PORT);
  });

  it('servicePaths shares the database with a manual `pnpm start`', () => {
    const paths = servicePaths({ home: HOME, repoRoot: REPO, label: DEFAULT_LABEL });
    expect(paths.db).toBe(`${REPO}/apps/server/data/agenthropic.db`);
    expect(paths.plist).toBe(`${HOME}/Library/LaunchAgents/${DEFAULT_LABEL}.plist`);
    expect(paths.tsxLoader).toBe(`${REPO}/apps/server/node_modules/tsx/dist/loader.mjs`);
    expect(servicePaths({ home: HOME, repoRoot: REPO, label: 'x', db: '/data/a.db' }).db).toBe(
      '/data/a.db',
    );
  });

  it('launchctlSteps prints, for the operator, how to load, check, restart and remove', () => {
    const steps = launchctlSteps({ label: 'l', plist: '/p.plist', port: 9 }).join('\n');
    expect(steps).toContain("launchctl bootstrap gui/$(id -u) '/p.plist'");
    expect(steps).toContain('launchctl kickstart -k gui/$(id -u)/l');
    expect(steps).toContain("launchctl bootout gui/$(id -u)/l && rm '/p.plist'");
    expect(steps).toContain('http://127.0.0.1:9/api/health');
  });
});

describe('buildPlist', () => {
  const paths = servicePaths({ home: HOME, repoRoot: REPO, label: DEFAULT_LABEL });

  it('runs the source in ONE Node process under the tsx loader, from apps/server', () => {
    const plist = buildPlist({
      label: DEFAULT_LABEL,
      node: '/opt/node22/bin/node',
      paths,
      home: HOME,
      token: TOKEN,
    });
    expect(plist).toContain(
      `<string>/opt/node22/bin/node</string>\n      <string>--import</string>\n      <string>file://${paths.tsxLoader}</string>\n      <string>src/index.ts</string>`,
    );
    expect(plist).toContain(
      `<key>WorkingDirectory</key>\n    <string>${REPO}/apps/server</string>`,
    );
    expect(plist).toContain(`<key>DASHBOARD_DB_PATH</key>\n      <string>${paths.db}</string>`);
    expect(plist).toContain('<string>/opt/node22/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n      <false/>');
    expect(plist).toContain('<key>Umask</key>\n    <integer>63</integer>');
    expect(plist).not.toContain('DASHBOARD_PORT');
  });

  it('sets the port only when asked, and escapes values', () => {
    const plist = buildPlist({
      label: 'l',
      node: '/n',
      paths,
      home: HOME,
      token: 'x&y<z',
      port: 8123,
    });
    expect(plist).toContain('<key>DASHBOARD_PORT</key>\n      <string>8123</string>');
    expect(plist).toContain('<string>x&amp;y&lt;z</string>');
  });
});

describe('run', () => {
  it('prints usage for --help', () => {
    const result = run(fakeIo({ argv: ['--help'] }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout[0]).toMatch(/^Usage:/);
  });

  it('reports a bad argument', () => {
    const result = run(fakeIo({ argv: ['--nope'] }));
    expect(result).toEqual({
      stdout: [],
      stderr: ['service-install: unknown argument "--nope" (try --help)'],
      exitCode: 1,
    });
  });

  it('dry run masks the token and writes nothing', () => {
    const io = fakeIo();
    const result = run(io);
    expect(result.exitCode).toBe(0);
    const out = result.stdout.join('\n');
    expect(out).toContain(xmlEscape(TOKEN_MASK));
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('Dry run. Re-run with --write');
    expect(io.written).toEqual([]);
  });

  it('--write writes the real token and prints the launchctl steps', () => {
    const io = fakeIo({ argv: ['--write', '--port', '8123'] });
    const result = run(io);
    expect(result.exitCode).toBe(0);
    expect(io.written).toHaveLength(1);
    expect(io.written[0]![1]).toContain(`<string>${TOKEN}</string>`);
    expect(result.stdout.join('\n')).not.toContain(TOKEN);
    expect(result.stdout.join('\n')).toContain('http://127.0.0.1:8123/api/health');
    expect(result.stderr).toEqual([]);
  });

  it('uses the default port in the printed steps', () => {
    const result = run(fakeIo({ argv: ['--write'] }));
    expect(result.stdout.join('\n')).toContain(`http://127.0.0.1:${DEFAULT_PORT}/api/health`);
  });

  it('refuses everything that would crash the service at boot, before writing', () => {
    const io = fakeIo({
      argv: ['--write'],
      env: {},
      platform: 'linux',
      nodeVersion: 'v26.1.0',
      exists: () => false,
    });
    const result = run(io);
    expect(result.exitCode).toBe(1);
    expect(io.written).toEqual([]);
    const err = result.stderr.join('\n');
    expect(err).toContain('error: launchd is macOS only (this is linux).');
    expect(err).toContain('is Node v26.1.0; the service needs Node 22');
    expect(err).toContain('error: DASHBOARD_TOKEN is not set');
    expect(err).toContain('tsx/dist/loader.mjs is missing');
    expect(err).toContain('warning: The SPA is not built');
  });

  it('trusts --node with a warning, since its version cannot be read without running it', () => {
    const result = run(fakeIo({ argv: ['--node', '/other/node'], nodeVersion: 'v26.1.0' }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([
      'warning: /other/node is trusted to be Node 22; the boot log shows the real version.',
    ]);
    expect(result.stdout.join('\n')).toContain('<string>/other/node</string>');
  });
});

describe('writePlistToDisk', () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('creates the plist 0600 and the log and database directories 0700, even over an older 0644 file', () => {
    home = mkdtempSync(join(tmpdir(), 'svc-install-'));
    const paths = servicePaths({ home, repoRoot: join(home, 'repo'), label: 'l' });
    writePlistToDisk(paths, 'first');
    writeFileSync(paths.plist, 'loose');
    chmodSync(paths.plist, 0o644);
    writePlistToDisk(paths, 'second');
    expect(readFileSync(paths.plist, 'utf8')).toBe('second');
    expect(statSync(paths.plist).mode & 0o777).toBe(0o600);
    expect(statSync(paths.logDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'repo', 'apps', 'server', 'data')).mode & 0o777).toBe(0o700);
  });
});

describe('isMainModule', () => {
  it('compares real paths and is false for a missing or different file', () => {
    const self = new URL('../../../scripts/service-install.mjs', import.meta.url);
    expect(isMainModule(undefined, self.href)).toBe(false);
    expect(isMainModule('/no/such/file', self.href)).toBe(false);
    expect(isMainModule(new URL(self).pathname, pathToFileURL(new URL(self).pathname).href)).toBe(
      true,
    );
  });
});
