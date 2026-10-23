// Unit tests for the three CI gate scripts: the no-spawner scan, the license
// allowlist and the Node-major guard.
//
// Until now CI proved only "the script runs and exits 0 against this repo",
// never "the script catches what it claims to catch" - the scripts exported
// nothing, so nothing could call them with a tree that is not clean, and they
// sit outside every coverage gate (`coverage.include` is `src/**`). Each gate
// now exposes a pure core - a scan/evaluate step plus a formatter - and these
// tests drive that core against fixtures built for the occasion. The gates' own
// CLI wrappers stay UNCOVERED on purpose: exercising them would mean running
// them as child processes, which needs a new inline opt-out marker in this very
// file, and the exception list that marker belongs to is advertised as small
// enough to audit by eye. The wrappers are kept trivial instead.
//
// FIXTURES ARE ASSEMBLED AT RUN TIME, ON PURPOSE. This file lives under
// `apps/server`, which the no-spawner gate scans, and that gate matches its
// forbidden tokens anywhere on a line - comments and string literals included.
// A fixture holding a forbidden token as a source literal would make the gate
// fail on its own test. So every forbidden token below is joined from harmless
// fragments at run time and written into a throwaway directory under
// `os.tmpdir()`; the scan root in every test is that directory, never this repo.
// No line here is exempted from the gate, and nothing assembled here is ever run.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pathToFileURL } from 'node:url';

import {
  INLINE_ALLOW,
  aliasedPackageName,
  formatReport as formatSpawnerReport,
  isMainModule as isSpawnerGateMain,
  scanTree,
} from '../../../scripts/check-no-spawner.mjs';
import {
  evaluateLicenses,
  formatReport as formatLicenseReport,
  isMainModule as isLicenseGateMain,
} from '../../../scripts/check-licenses.mjs';
import type { LicensesInspected } from '../../../scripts/check-licenses.mjs';
import {
  evaluateNodeVersion,
  formatReport as formatNodeReport,
  isMainModule as isNodeGateMain,
} from '../../../scripts/check-node-version.mjs';

// --- fixture plumbing ------------------------------------------------------

const SCAN_ROOTS = ['apps', 'packages', 'scripts', 'hooks'] as const;

/** Assembled, never written as a literal - see the header. */
const SUBPROCESS_TOKEN = ['child', 'process'].join('_');
const SUBPROCESS_LABEL = `${SUBPROCESS_TOKEN} module`;
const FORBIDDEN_LINE = `import { thing } from 'node:${SUBPROCESS_TOKEN}';`;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthropic-gates-'));
  tempDirs.push(dir);
  return dir;
}

interface Fixture {
  /** The fake repo root. Every scan below points here, never at this repo. */
  root: string;
  /** A directory OUTSIDE the fake repo, for symlink targets. */
  outside: string;
}

function makeFixture(roots: readonly string[] = SCAN_ROOTS): Fixture {
  const parent = makeTempDir();
  const root = join(parent, 'repo');
  const outside = join(parent, 'outside');
  mkdirSync(outside, { recursive: true });
  for (const name of roots) mkdirSync(join(root, name), { recursive: true });
  return { root, outside };
}

function write(dir: string, relativePath: string, contents: string): string {
  const full = join(dir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
  return full;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

// --- check-no-spawner ------------------------------------------------------

describe('check-no-spawner: scanTree / formatReport', () => {
  it('passes a clean tree and still names every exemption, including dead ones', () => {
    const { root } = makeFixture();
    write(root, 'apps/server/src/ok.ts', 'export const ok = 1;\n');
    // A top-level directory holding no source file is covered by definition and
    // must NOT be reported as an unregistered coverage hole.
    write(root, 'docs/note.md', '# not source\n');

    const findings = scanTree(root);
    expect(findings.stage).toBe('scanned');
    expect(findings.offenders).toEqual([]);
    expect(findings.unregisteredTopLevel).toEqual([]);
    expect(findings.scannedFiles).toBe(1);
    expect(findings.scanRoots).toBe(4);
    // The one allowlisted path is this repo's own gate file, which does not
    // exist in the fixture: a dead exemption, reported and not fatal (C-2).
    expect(findings.deadAllowlistEntries).toEqual(['scripts/check-no-spawner.mjs']);
    expect(findings.skippedAllowlisted).toEqual([]);
    expect([...findings.absentExemptions].sort()).toEqual(['.claude', '.git', 'spike']);

    const report = formatSpawnerReport(findings);
    expect(report.exitCode).toBe(0);
    expect(report.stderr).toEqual([]);
    expect(report.stdout).toContain(
      'check-no-spawner: allowlist entry matched no file (dead exemption, not fatal): ' +
        'scripts/check-no-spawner.mjs',
    );
    expect(report.stdout.at(-1)).toBe(
      'check-no-spawner: OK (1 files scanned across 4 roots + repo-root config; ' +
        '0 allowlisted; 0 line(s) inline-exempt; 0 package.json manifests checked ' +
        'for forbidden direct dependencies and wide-bind scripts; ' +
        '1 server-process files checked for outbound network calls)',
    );
  });

  it('fails on a forbidden token, naming the file, the line and the rule', () => {
    const { root } = makeFixture();
    write(root, 'apps/server/src/bad.ts', `export const ok = 1;\n${FORBIDDEN_LINE}\n`);

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([
      `apps/server/src/bad.ts:2  [${SUBPROCESS_LABEL}]  ${FORBIDDEN_LINE}`,
    ]);

    const report = formatSpawnerReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stderr[0]).toBe('check-no-spawner: FORBIDDEN patterns found:');
    expect(report.stdout.join('\n')).not.toContain('OK (');
  });

  it('honours an inline opt-out but reports it loudly, with the rule it suppressed', () => {
    const { root } = makeFixture();
    write(root, 'apps/server/src/legit.ts', `${FORBIDDEN_LINE} // ${INLINE_ALLOW}\n`);

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([]);
    expect(findings.inlineAllowSites).toEqual([
      `apps/server/src/legit.ts:1  [${SUBPROCESS_LABEL}]`,
    ]);
    expect(findings.deadInlineAllowSites).toEqual([]);

    const report = formatSpawnerReport(findings);
    expect(report.exitCode).toBe(0);
    // The point of the case: silence from the FAILURE, never silence from the
    // REPORT - the exemption is on stdout and counted in the OK line.
    expect(report.stdout).toContain(
      'check-no-spawner: inline opt-out in force (line not scanned): ' +
        `apps/server/src/legit.ts:1  [${SUBPROCESS_LABEL}]`,
    );
    expect(report.stdout.at(-1)).toContain('1 line(s) inline-exempt');
  });

  it('reports a marker that suppressed nothing as a dead marker, without failing', () => {
    const { root } = makeFixture();
    write(root, 'packages/core/src/leftover.ts', `// ${INLINE_ALLOW} left over from a rewrite\n`);

    const findings = scanTree(root);
    expect(findings.inlineAllowSites).toEqual([]);
    expect(findings.deadInlineAllowSites).toEqual(['packages/core/src/leftover.ts:1']);

    const report = formatSpawnerReport(findings);
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain(
      'check-no-spawner: inline opt-out suppressed nothing (dead marker, not fatal): ' +
        'packages/core/src/leftover.ts:1',
    );
    expect(report.stdout.at(-1)).toContain('0 line(s) inline-exempt');
  });

  it('fails on a symlink escaping the scanned tree, and never reads what it points at', () => {
    const { root, outside } = makeFixture();
    const target = write(outside, 'escaped.ts', `${FORBIDDEN_LINE}\n`);
    symlinkSync(target, join(root, 'apps/server-link.ts'));

    const findings = scanTree(root);
    expect(findings.unreadableEntries).toEqual(['apps/server-link.ts']);
    // The link is not followed, so the forbidden line behind it is invisible -
    // which is exactly why the run must fail instead of reporting OK.
    expect(findings.offenders).toEqual([]);
    expect(findings.scannedFiles).toBe(0);

    const report = formatSpawnerReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stderr[0]).toContain('neither a regular file nor a directory');
    expect(report.stderr).toContain('  apps/server-link.ts');
    expect(JSON.stringify(report)).not.toContain(SUBPROCESS_TOKEN);
  });

  it('scans a manifest deeper than two directories down (L-5)', () => {
    const { root } = makeFixture();
    write(
      root,
      'apps/web/plugins/relay/package.json',
      `${JSON.stringify({ name: 'relay', dependencies: { 'socket.io': '^4.7.5' } }, null, 2)}\n`,
    );

    const findings = scanTree(root);
    expect(findings.scannedManifests).toBe(1);
    expect(findings.offenders).toEqual([
      'apps/web/plugins/relay/package.json  [ws / socket.io package]  dependencies.socket.io',
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  it('flags an unparseable manifest instead of skipping it', () => {
    const { root } = makeFixture();
    write(root, 'packages/broken/package.json', '{ not json\n');

    const findings = scanTree(root);
    expect(findings.scannedManifests).toBe(1);
    expect(findings.offenders).toHaveLength(1);
    expect(findings.offenders[0]).toContain('packages/broken/package.json  [unparseable manifest]');
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  it('fails when a scan root is missing, before reading a single file', () => {
    const { root } = makeFixture(['apps', 'packages', 'scripts']);
    write(root, 'apps/server/src/bad.ts', `${FORBIDDEN_LINE}\n`);

    const findings = scanTree(root);
    expect(findings.stage).toBe('missing-roots');
    expect(findings.missingRoots).toEqual(['hooks']);
    // Coverage shrank, so the run stops here: nothing was scanned, and the
    // offender above is deliberately NOT reported as if the tree were clean.
    expect(findings.scannedFiles).toBe(0);
    expect(findings.offenders).toEqual([]);

    const report = formatSpawnerReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stdout).toEqual([]);
    expect(report.stderr).toContain('  hooks/');
  });

  // GG3: a `--host` flag in a package.json script overrides the loopback host a
  // vite.config sets, and manifests used to be checked for dependency keys only.
  it('fails on a package.json script that widens the bind, and passes loopback hosts (GG3)', () => {
    const { root } = makeFixture();
    const wideAddress = ['0', '0', '0', '0'].join('.');
    const scripts = {
      dev: 'vite --host 127.0.0.1',
      preview: 'vite preview --host=localhost --port 4173',
      six: "vite --host '::1'",
      plain: 'vite build',
      wideLiteral: `vite --host ${wideAddress}`,
      bare: 'vite --host',
      bareThenFlag: 'vite preview --host --port 4173',
      equalsWide: 'vite --host=192.168.1.10',
      chained: 'vite --host && echo done',
    };
    write(root, 'apps/web/package.json', `${JSON.stringify({ name: 'web', scripts }, null, 2)}\n`);

    const findings = scanTree(root);
    const label = '[wide bind in package.json script]';
    expect(findings.offenders).toEqual([
      `apps/web/package.json  ${label}  scripts.wideLiteral: vite --host ${wideAddress}`,
      `apps/web/package.json  ${label}  scripts.bare: vite --host`,
      `apps/web/package.json  ${label}  scripts.bareThenFlag: vite preview --host --port 4173`,
      `apps/web/package.json  ${label}  scripts.equalsWide: vite --host=192.168.1.10`,
      `apps/web/package.json  ${label}  scripts.chained: vite --host && echo done`,
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  // GG4: subprocess wrappers beyond the one the source patterns always named.
  it('flags subprocess wrapper packages as dependencies and as import specifiers (GG4)', () => {
    const { root } = makeFixture();
    // Assembled, never written as literals - see the header.
    const sp = ['sp', 'awn'].join('');
    const newDeps = ['tiny' + 'exec', 'z' + 'x', `nano-${sp}`, `${sp}damnit`, `cross-${sp}-async`];
    write(
      root,
      'packages/core/package.json',
      `${JSON.stringify(
        { name: 'core', dependencies: Object.fromEntries(newDeps.map((n) => [n, '1.0.0'])) },
        null,
        2,
      )}\n`,
    );
    const offending = [
      `import { x } from '${newDeps[0]}';`,
      `import '${newDeps[1]}/globals';`,
      `const run = await import('${newDeps[2]}');`,
      `const s = require("${newDeps[3]}");`,
      `import cs from '${newDeps[4]}';`,
      `import cross from 'cross-${sp}';`,
      `const sh = require('${'shell' + 'js'}');`,
      `export { pty } from '${'node-' + 'pty'}';`,
    ];
    // A name that only CONTAINS a wrapper name, or a wrapper named outside a
    // module specifier, must stay clean.
    const clean = [
      `import { a } from '${'z' + 'xcvbn'}';`,
      `const note = '${'z' + 'x'} is a word';`,
    ];
    write(root, 'packages/core/src/wrap.ts', `${[...offending, ...clean].join('\n')}\n`);

    const findings = scanTree(root);
    const label = '[subprocess wrapper import]';
    expect(findings.offenders).toEqual([
      ...offending.map((line, i) => `packages/core/src/wrap.ts:${i + 1}  ${label}  ${line}`),
      ...newDeps.map((n) => `packages/core/package.json  [subprocess package]  dependencies.${n}`),
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  // GG5: the header claims "no dynamic code evaluation", and the vm module is
  // exactly that.
  it('flags an import of the vm module, with or without the node: prefix (GG5)', () => {
    const { root } = makeFixture();
    const bare = `import vm from '${'v' + 'm'}';`;
    const prefixed = `const { runInNewContext } = require("node:${'v' + 'm'}");`;
    write(
      root,
      'apps/server/src/evil.ts',
      `${bare}\n${prefixed}\nconst vmCount = 1; // a vm is also a virtual machine\n`,
    );

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([
      `apps/server/src/evil.ts:1  [vm module]  ${bare}`,
      `apps/server/src/evil.ts:2  [vm module]  ${prefixed}`,
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  // CI-1 (2026-10-10). The two native-binding entry points on `process` (the
  // `binding` member and the internal-binding global) reach the native layer
  // underneath the child-process module (`spawn_sync`, `pipe_wrap`), and the dynamic
  // loader member (`dlopen`) loads an arbitrary shared object, so each is a
  // subprocess or native-code surface that spells no forbidden module name.
  // The header's "no subprocess surface" claim did not cover them. Every token
  // below is assembled so the gate scanning THIS file does not trip on the
  // test itself - not even in this comment.
  it('flags the native-binding and dlopen surfaces, dot or bracket form (CI-1)', () => {
    const { root } = makeFixture();
    const bindingLabel = `${['process', 'binding'].join('.')} / ${['internal', 'Binding'].join('')}`;
    const dlopenLabel = ['process', 'dlopen'].join('.');
    const dotBinding = `const wrap = ${['process', 'binding'].join('.')}('spawn_sync');`;
    const bracketBinding = `const w2 = ${['process', "['binding']"].join('')}('pipe_wrap');`;
    const internal = `const b = ${['internal', 'Binding'].join('')}('pipe_wrap');`;
    const dlopen = `${['process', 'dlopen'].join('.')}(module, '/tmp/evil.node');`;
    write(
      root,
      'apps/server/src/evil.ts',
      `${dotBinding}\n${bracketBinding}\n${internal}\n${dlopen}\nconst bindingCount = 1;\n`,
    );

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([
      `apps/server/src/evil.ts:1  [${bindingLabel}]  ${dotBinding}`,
      `apps/server/src/evil.ts:2  [${bindingLabel}]  ${bracketBinding}`,
      `apps/server/src/evil.ts:3  [${bindingLabel}]  ${internal}`,
      `apps/server/src/evil.ts:4  [${dlopenLabel}]  ${dlopen}`,
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  it('fails on a top-level directory that is neither scanned nor exempt', () => {
    const { root } = makeFixture();
    write(root, 'tools/deploy/helper.ts', 'export const helper = 1;\n');

    const findings = scanTree(root);
    expect(findings.stage).toBe('unregistered-top-level');
    expect(findings.unregisteredTopLevel).toEqual([['tools', 1]]);

    const report = formatSpawnerReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stderr).toContain('  tools/  (1 source file(s) or unfollowed entr(y/ies))');
  });
});

// --- check-no-spawner: WP-F5 no-SSRF half (2026-09-26) ----------------------
//
// These fixture lines are ordinary literals: the outbound patterns apply only to
// server-process SOURCE (`apps/server/src/`, `packages/*/src/`), and this file
// lives under `apps/server/test/`, so none of them trips the gate on this repo.

describe('check-no-spawner: no outbound network calls from server-process code', () => {
  const OUTBOUND_CASES: ReadonlyArray<[string, string]> = [
    ['outbound fetch( call', "const r = await fetch('http://example.test/');"],
    ['outbound fetch( call', 'const r = await fetch (payload.url);'],
    ['node network module', "import { request } from 'node:https';"],
    ['node network module', "import http from 'http';"],
    ['node network module', "import { connect } from 'node:net';"],
    ['node network module', "const tls = await import('node:tls');"],
    ['node network module', "import { lookup } from 'node:dns/promises';"],
    ['HTTP client import', "import axios from 'axios';"],
    ['HTTP client import', "import got from 'got';"],
    ['HTTP client import', "const { request } = require('undici');"],
    ['HTTP client import', "const f = await import('node-fetch');"],
    ['WebSocket / EventSource client', "const ws = new WebSocket('wss://example.test');"],
    ['WebSocket / EventSource client', 'const es = new EventSource(url);'],
    ['XMLHttpRequest', 'const xhr = new XMLHttpRequest();'],
  ];

  it.each(OUTBOUND_CASES)('fails [%s] in apps/server/src: %s', (label, line) => {
    const { root } = makeFixture();
    write(root, 'apps/server/src/dial.ts', `${line}\n`);

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([`apps/server/src/dial.ts:1  [${label}]  ${line}`]);
    expect(findings.outboundScannedFiles).toBe(1);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  it('covers every package library, not only the server', () => {
    const { root } = makeFixture();
    write(root, 'packages/core/src/dial.ts', "import axios from 'axios';\n");

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([
      "packages/core/src/dial.ts:1  [HTTP client import]  import axios from 'axios';",
    ]);
  });

  it('leaves browser code, tests, scripts and package-root config out of scope by path', () => {
    const { root } = makeFixture();
    const line = "const r = await fetch('http://127.0.0.1:4317/api/health');";
    write(root, 'apps/web/src/api.ts', `${line}\n`);
    write(root, 'apps/server/test/loopback.test.ts', `${line}\n`);
    write(root, 'packages/shared/test/loopback.test.ts', `${line}\n`);
    write(root, 'scripts/measure.mjs', `${line}\n`);
    write(root, 'apps/server/vitest.config.ts', "import http from 'node:http';\n");

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([]);
    expect(findings.scannedFiles).toBe(5);
    expect(findings.outboundScannedFiles).toBe(0);
    expect(formatSpawnerReport(findings).stdout.at(-1)).toContain(
      '0 server-process files checked for outbound network calls',
    );
  });

  it('does not flag ordinary words and look-alike identifiers', () => {
    const { root } = makeFixture();
    write(
      root,
      'apps/server/src/words.ts',
      [
        '// we got there; a request was made; the needle moved',
        'export const prefetch = (n: number) => n;',
        "export const label = 'network';",
        "import { createHash } from 'node:crypto';",
        "import { join } from 'node:path';",
      ].join('\n') + '\n',
    );

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([]);
    expect(findings.outboundScannedFiles).toBe(1);
  });

  it('honours an inline opt-out on an outbound line and names the rule it suppressed', () => {
    // The shape v2.0's dispatcher (WP-A4) would need: one reviewed line that
    // dials an operator-configured target, loud on every run.
    const { root } = makeFixture();
    write(
      root,
      'apps/server/src/dispatch.ts',
      `const r = await fetch(target.url); // ${INLINE_ALLOW}\n`,
    );

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([]);
    expect(findings.inlineAllowSites).toEqual([
      'apps/server/src/dispatch.ts:1  [outbound fetch( call]',
    ]);
  });

  it('refuses an HTTP client package in a server-process manifest, not in the web one', () => {
    const { root } = makeFixture();
    write(root, 'apps/server/package.json', JSON.stringify({ dependencies: { axios: '1' } }));
    write(root, 'packages/core/package.json', JSON.stringify({ devDependencies: { got: '14' } }));
    write(root, 'apps/web/package.json', JSON.stringify({ dependencies: { ky: '1' } }));
    write(root, 'package.json', JSON.stringify({ devDependencies: { undici: '6' } }));

    const findings = scanTree(root);
    expect([...findings.offenders].sort()).toEqual([
      'apps/server/package.json  [HTTP client package]  dependencies.axios',
      'packages/core/package.json  [HTTP client package]  devDependencies.got',
    ]);
    expect(findings.scannedManifests).toBe(4);
  });
});

// --- check-licenses --------------------------------------------------------

interface LicensePackage {
  name: string;
  versions?: string[];
  version?: string;
  paths?: string[];
}

type LicensePayload = Record<string, LicensePackage[]>;

function inspect(payload: LicensePayload): LicensesInspected {
  const findings = evaluateLicenses(JSON.stringify(payload));
  if (findings.status !== 'inspected') {
    throw new Error(`expected an inspected payload, got ${findings.status}`);
  }
  return findings;
}

describe('check-licenses: evaluateLicenses / formatReport', () => {
  it('rejects a parenthesised OR group ANDed with a licence outside the allowlist', () => {
    // L-2: this is the expression that used to be reassociated and then REPORTED
    // AS ALLOWLISTED. Both halves of that failure are asserted here.
    const expression = '(MIT OR Apache-2.0) AND CC-BY-NC-4.0';
    const findings = inspect({ [expression]: [{ name: 'tricky', versions: ['1.0.0'] }] });
    expect(findings.offenders).toEqual([`tricky@1.0.0  [${expression}]`]);
    expect(findings.appliedExceptions).toEqual([]);

    const report = formatLicenseReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stderr[0]).toBe('check-licenses: packages with licenses outside the allowlist:');
    expect(report.stdout.join('\n')).not.toContain('allowlisted');
  });

  it('accepts a genuine OR group when one branch is allowed', () => {
    const findings = inspect({ '(MIT OR WTFPL)': [{ name: 'genuine', versions: ['2.0.0'] }] });
    expect(findings.offenders).toEqual([]);
    expect(formatLicenseReport(findings).exitCode).toBe(0);
  });

  it('refuses an expression it cannot fully parse', () => {
    const findings = inspect({
      'Apache-2.0 WITH LLVM-exception': [{ name: 'withclause', versions: ['1.0.0'] }],
      'MIT AND': [{ name: 'trailing', versions: ['1.0.0'] }],
      '': [{ name: 'empty', versions: ['1.0.0'] }],
    });
    expect(findings.offenders).toEqual([
      'withclause@1.0.0  [Apache-2.0 WITH LLVM-exception]',
      'trailing@1.0.0  [MIT AND]',
      'empty@1.0.0  []',
    ]);
    expect(formatLicenseReport(findings).exitCode).toBe(1);
  });

  it('applies a documented exception, counts it apart, and counts versions not names', () => {
    const findings = inspect({
      'CC-BY-4.0': [{ name: 'caniuse-lite', versions: ['1.0.30001803', '1.0.30001900'] }],
    });
    expect(findings.appliedExceptions).toEqual([
      'caniuse-lite@1.0.30001803, 1.0.30001900  [CC-BY-4.0]',
    ]);
    expect(findings.offenders).toEqual([]);
    expect(findings.unusedExceptions).toEqual([]);
    expect(findings.checkedNames).toBe(1);
    expect(findings.checkedVersions).toBe(2);
    expect(findings.allowlistedNames).toBe(0);
    expect(findings.exceptionNames).toBe(1);

    const report = formatLicenseReport(findings);
    expect(report.exitCode).toBe(0);
    expect(report.stdout[0]).toBe(
      'check-licenses: documented exception applied (NOT allowlisted): ' +
        'caniuse-lite@1.0.30001803, 1.0.30001900  [CC-BY-4.0]',
    );
    expect(report.stdout.at(-1)).toBe(
      'check-licenses: OK (1 packages / 2 installed versions; 0 allowlisted, ' +
        '1 under a documented exception)',
    );
  });

  it('counts a package present under two licences at two versions as one name (II4)', () => {
    // pnpm groups by licence, so one package whose licence changed between two
    // installed versions shows up once under each licence. That is one name and
    // two installs - neither the package figure nor the allowlisted figure may
    // count it twice.
    const findings = inspect({
      MIT: [
        { name: 'relicensed', versions: ['1.0.0'] },
        { name: 'steady', versions: ['3.0.0'] },
      ],
      'Apache-2.0': [{ name: 'relicensed', versions: ['2.0.0'] }],
      'CC-BY-4.0': [{ name: 'caniuse-lite', versions: ['1.0.30001803'] }],
    });
    expect(findings.offenders).toEqual([]);
    expect(findings.checkedNames).toBe(3);
    expect(findings.checkedVersions).toBe(4);
    expect(findings.allowlistedNames).toBe(2);
    expect(findings.exceptionNames).toBe(1);

    const report = formatLicenseReport(findings);
    expect(report.exitCode).toBe(0);
    expect(report.stdout.at(-1)).toBe(
      'check-licenses: OK (3 packages / 4 installed versions; 2 allowlisted, ' +
        '1 under a documented exception)',
    );
  });

  it('will not stretch an exception to another licence for the same package', () => {
    const findings = inspect({ 'CC-BY-NC-4.0': [{ name: 'caniuse-lite', version: '1.0.0' }] });
    expect(findings.appliedExceptions).toEqual([]);
    expect(findings.offenders).toEqual(['caniuse-lite@1.0.0  [CC-BY-NC-4.0]']);
    expect(findings.unusedExceptions).toEqual(['caniuse-lite']);
    expect(formatLicenseReport(findings).exitCode).toBe(1);
  });

  it('reports an exception that matched nothing, without failing', () => {
    const findings = inspect({ MIT: [{ name: 'plain' }] });
    expect(findings.unusedExceptions).toEqual(['caniuse-lite']);
    // No `versions` and no `version` renders as `?` rather than `undefined`.
    expect(findings.checkedVersions).toBe(1);

    const report = formatLicenseReport(findings);
    expect(report.exitCode).toBe(0);
    expect(report.stdout[0]).toBe(
      'check-licenses: exception for "caniuse-lite" matched nothing in the installed tree - ' +
        'it is a standing permission with no subject and should be removed.',
    );
  });

  it('refuses to report a pass over an empty scan', () => {
    const report = formatLicenseReport(evaluateLicenses('{}'));
    expect(report.exitCode).toBe(1);
    expect(report.stderr[0]).toContain('Refusing to report a pass over an empty scan.');
  });

  it('counts workspace-local packages as nothing inspected, so an all-local scan fails', () => {
    const findings = inspect({
      'CC-BY-NC-4.0': [
        { name: '@agenthropic/server', versions: ['0.3.0'], paths: ['/repo/apps/server'] },
        { name: '@agenthropic/core', versions: ['0.3.0'], paths: ['C:\\repo\\packages\\core'] },
      ],
    });
    expect(findings.offenders).toEqual([]);
    expect(findings.checkedNames).toBe(0);
    expect(formatLicenseReport(findings).exitCode).toBe(1);
  });

  it('checks an @agenthropic/* package that is installed rather than local (AU nit)', () => {
    // The scope alone used to exempt a package. A registry package under the same
    // scope, installed into node_modules, or an entry with no paths to prove it
    // is a workspace checkout, is checked like any other dependency.
    const findings = inspect({
      'GPL-3.0': [
        {
          name: '@agenthropic/evil',
          versions: ['1.0.0'],
          paths: [
            '/repo/node_modules/.pnpm/@agenthropic+evil@1.0.0/node_modules/@agenthropic/evil',
          ],
        },
        { name: '@agenthropic/pathless', versions: ['1.0.0'] },
        { name: '@agenthropic/emptypaths', versions: ['1.0.0'], paths: [] },
        {
          name: '@agenthropic/mixed',
          versions: ['1.0.0'],
          paths: ['/repo/packages/mixed', 'C:\\repo\\node_modules\\@agenthropic\\mixed'],
        },
      ],
    });
    expect(findings.offenders).toEqual([
      '@agenthropic/evil@1.0.0  [GPL-3.0]',
      '@agenthropic/pathless@1.0.0  [GPL-3.0]',
      '@agenthropic/emptypaths@1.0.0  [GPL-3.0]',
      '@agenthropic/mixed@1.0.0  [GPL-3.0]',
    ]);
    expect(findings.checkedNames).toBe(4);
    expect(formatLicenseReport(findings).exitCode).toBe(1);
  });

  it('does not exempt an outside package because its paths avoid node_modules', () => {
    const findings = inspect({
      'GPL-3.0': [
        { name: 'agenthropic-lookalike', versions: ['1.0.0'], paths: ['/repo/vendor/x'] },
      ],
    });
    expect(findings.offenders).toEqual(['agenthropic-lookalike@1.0.0  [GPL-3.0]']);
  });

  it('refuses valid JSON of the wrong shape', () => {
    const findings = evaluateLicenses('[]');
    expect(findings).toEqual({ status: 'wrong-shape', received: 'array' });
    const report = formatLicenseReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stderr[1]).toBe('  received: array');
    expect(formatLicenseReport(evaluateLicenses('"x"')).exitCode).toBe(1);
  });

  it('reports unparseable output as unreadable rather than as broken', () => {
    const raw = ' WARN  deprecated dependency\n{"MIT":[]}';
    const findings = evaluateLicenses(raw);
    expect(findings.status).toBe('unparseable');
    const report = formatLicenseReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stderr[0]).toBe(
      'check-licenses: `pnpm licenses list --json` did not return parseable JSON',
    );
    expect(report.stderr[2]).toBe(`  first 200 characters received: ${raw.slice(0, 200)}`);
  });
});

// --- check-node-version ----------------------------------------------------

describe('check-node-version: evaluateNodeVersion / formatReport', () => {
  function nvmrc(contents: string): string {
    const dir = makeTempDir();
    return write(dir, '.nvmrc', contents);
  }

  it('accepts the running major named by .nvmrc', () => {
    const findings = evaluateNodeVersion({
      nvmrcPath: nvmrc('22\n'),
      nodeVersion: 'v22.23.2',
      execPath: '/usr/local/bin/node',
    });
    expect(findings).toEqual({ status: 'ok', wantedMajor: 22, nodeVersion: 'v22.23.2' });

    const report = formatNodeReport(findings);
    expect(report.exitCode).toBe(0);
    expect(report.stderr).toEqual([]);
    expect(report.stdout).toEqual(['check-node-version: OK (v22.23.2 matches .nvmrc 22)']);
  });

  it('compares majors only, so a pinned patch level still accepts the major', () => {
    const report = formatNodeReport(
      evaluateNodeVersion({
        nvmrcPath: nvmrc('v22.14.0\n'),
        nodeVersion: 'v22.0.0',
        execPath: '/usr/local/bin/node',
      }),
    );
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toEqual(['check-node-version: OK (v22.0.0 matches .nvmrc 22)']);
  });

  it('rejects a higher major and names the interpreter it found', () => {
    const findings = evaluateNodeVersion({
      nvmrcPath: nvmrc('22\n'),
      nodeVersion: 'v26.7.0',
      execPath: '/opt/homebrew/bin/node',
    });
    expect(findings).toEqual({
      status: 'mismatch',
      wantedMajor: 22,
      nodeVersion: 'v26.7.0',
      execPath: '/opt/homebrew/bin/node',
    });

    const report = formatNodeReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stdout).toEqual([]);
    expect(report.stderr[0]).toContain(
      'check-node-version: Node 22 required (.nvmrc), but this is v26.7.0 at ' +
        '/opt/homebrew/bin/node.',
    );
  });

  it('rejects the adjacent major too - the ABI is per major, not per range', () => {
    const report = formatNodeReport(
      evaluateNodeVersion({
        nvmrcPath: nvmrc('22\n'),
        nodeVersion: 'v23.0.0',
        execPath: '/usr/local/bin/node',
      }),
    );
    expect(report.exitCode).toBe(1);
  });

  it('treats a missing .nvmrc as loud, never as a pass', () => {
    const findings = evaluateNodeVersion({
      nvmrcPath: join(makeTempDir(), 'absent', '.nvmrc'),
      nodeVersion: 'v22.23.2',
      execPath: '/usr/local/bin/node',
    });
    expect(findings.status).toBe('unreadable');

    const report = formatNodeReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stderr[0]).toContain('check-node-version: cannot read ');
  });

  it('treats an .nvmrc alias as unparsable rather than guessing a major', () => {
    const findings = evaluateNodeVersion({
      nvmrcPath: nvmrc('lts/hydrogen\n'),
      nodeVersion: 'v22.23.2',
      execPath: '/usr/local/bin/node',
    });
    expect(findings).toEqual({ status: 'unparsable', wanted: 'lts/hydrogen' });

    const report = formatNodeReport(findings);
    expect(report.exitCode).toBe(1);
    expect(report.stderr[0]).toBe(
      'check-node-version: .nvmrc says "lts/hydrogen", which is not a Node version',
    );
  });
});

// --- CLI entry detection (II1) ---------------------------------------------

describe('gate scripts: isMainModule', () => {
  // Node resolves symlinks in `import.meta.url` but leaves `process.argv[1]`
  // as typed. A gate run through a symlinked path must still recognise itself
  // as the entry point - otherwise it skips its checks and exits 0.
  const predicates = [
    ['check-no-spawner', isSpawnerGateMain],
    ['check-licenses', isLicenseGateMain],
    ['check-node-version', isNodeGateMain],
  ] as const;

  function symlinkedModule(): { real: string; link: string; other: string } {
    const dir = makeTempDir();
    const real = write(dir, 'real/gate.mjs', 'export {};\n');
    const other = write(dir, 'real/other.mjs', 'export {};\n');
    const link = join(dir, 'linked');
    symlinkSync(join(dir, 'real'), link, 'dir');
    return { real, link: join(link, 'gate.mjs'), other };
  }

  it.each(predicates)('%s: recognises itself when run through a symlinked path', (_, isMain) => {
    const { real, link } = symlinkedModule();
    const moduleUrl = pathToFileURL(real).href;
    expect(isMain(link, moduleUrl)).toBe(true);
    expect(isMain(real, moduleUrl)).toBe(true);
  });

  it.each(predicates)('%s: rejects an unrelated entry point', (_, isMain) => {
    const { real, other } = symlinkedModule();
    expect(isMain(other, pathToFileURL(real).href)).toBe(false);
  });

  it.each(predicates)('%s: rejects a missing or nonexistent argv[1]', (_, isMain) => {
    const { real } = symlinkedModule();
    const moduleUrl = pathToFileURL(real).href;
    expect(isMain(undefined, moduleUrl)).toBe(false);
    expect(isMain(join(dirname(real), 'absent.mjs'), moduleUrl)).toBe(false);
  });

  it.each(predicates)(
    '%s: falls back to the URL comparison when a path cannot be resolved',
    (_, isMain) => {
      // Neither side exists on disk, so realpath fails and the plain string
      // comparison decides.
      const ghost = join(makeTempDir(), 'ghost.mjs');
      expect(isMain(ghost, pathToFileURL(ghost).href)).toBe(true);
    },
  );
});

// --- AU-1..AU-5 (2026-10-22): holes the hooks/scripts audit found in the gate --
// Every forbidden token below is assembled at run time - see the header - so
// the gate scanning THIS file does not trip on its own test.
describe('check-no-spawner: audit holes AU-1..AU-5 (2026-10-22)', () => {
  const sp = ['sp', 'awn'].join('');
  const ev = ['ev', 'al'].join('');
  const fk = ['fo', 'rk'].join('');
  const imp = ['imp', 'ort'].join('');
  const xv = ['exec', 've'].join('');

  // AU-1: the exec-ve member of `process` (Node 22+) replaces the running
  // process with any executable - a subprocess launch that spells no module
  // name. The dot and bracket forms are both flagged; a look-alike member on
  // another object and the bare word are not.
  it('flags the process exec-ve member in dot and bracket form, not a look-alike (AU-1)', () => {
    const { root } = makeFixture();
    const label = ['process', xv].join('.');
    const dot = `${['process', xv].join('.')}('/bin/sh', ['-c', 'id']);`;
    const spaced = `${['process', xv].join(' . ')}('/bin/sh');`;
    const bracket = `${['process', `['${xv}']`].join('')}('/bin/sh');`;
    const clean = [`const myprocess = { ${xv}: 1 };`, `const ${xv}Count = 2;`];
    write(root, 'apps/server/src/evil.ts', `${[dot, spaced, bracket, ...clean].join('\n')}\n`);

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([
      `apps/server/src/evil.ts:1  [${label}]  ${dot}`,
      `apps/server/src/evil.ts:2  [${label}]  ${spaced}`,
      `apps/server/src/evil.ts:3  [${label}]  ${bracket}`,
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  // AU-2: an npm alias installs the real package under an innocent key, so the
  // aliased name is tested against the same denylists as the key.
  it('resolves the package behind an npm alias spec (AU-2)', () => {
    expect(aliasedPackageName('npm:@scope/pkg@1')).toBe('@scope/pkg');
    expect(aliasedPackageName('npm:@scope/pkg')).toBe('@scope/pkg');
    expect(aliasedPackageName('npm:pkg')).toBe('pkg');
    expect(aliasedPackageName('npm:pkg@^2.0.0')).toBe('pkg');
    expect(aliasedPackageName(' npm:pkg@1 ')).toBe('pkg');
    expect(aliasedPackageName('^1.0.0')).toBeUndefined();
    expect(aliasedPackageName('npm:')).toBeUndefined();
    expect(aliasedPackageName('file:../pkg')).toBeUndefined();
    expect(aliasedPackageName(42)).toBeUndefined();
    expect(aliasedPackageName(undefined)).toBeUndefined();
    expect(aliasedPackageName(null)).toBeUndefined();
  });

  it('flags a forbidden package hidden behind an npm alias, naming both names (AU-2)', () => {
    const { root } = makeFixture();
    const crossSpawn = `cross-${sp}`;
    write(
      root,
      'packages/core/package.json',
      JSON.stringify({
        name: 'core',
        dependencies: { cs: `npm:${crossSpawn}@7`, x: 'npm:ws@8', 'left-pad': '^1.0.0' },
      }),
    );
    write(
      root,
      'apps/server/package.json',
      JSON.stringify({ dependencies: { h: 'npm:axios@1' }, devDependencies: { ok: 'npm:zod@3' } }),
    );
    // The web manifest is out of scope for the HTTP-client rule, alias or not.
    write(root, 'apps/web/package.json', JSON.stringify({ dependencies: { h: 'npm:axios@1' } }));

    const findings = scanTree(root);
    expect([...findings.offenders].sort()).toEqual([
      'apps/server/package.json  [HTTP client package]  dependencies.h (alias of axios)',
      `packages/core/package.json  [subprocess package]  dependencies.cs (alias of ${crossSpawn})`,
      'packages/core/package.json  [ws / socket.io package]  dependencies.x (alias of ws)',
    ]);
    expect(findings.scannedManifests).toBe(3);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  // AU-4: a backtick specifier is the same import as a quoted one, and a
  // Worker constructed with the ev-al option set to true runs a string as code
  // on a thread.
  it('flags backtick dynamic imports and the Worker eval option (AU-4)', () => {
    const { root } = makeFixture();
    const dataImport = `const m = await ${imp}(\`data:text/javascript,1\`);`;
    const concatImport = `const p = await ${imp}(\`./plugins/\` + name);`;
    const worker = `const w = new Worker(source, { ${ev}: true });`;
    const spacedWorker = `const w2 = new Worker(source, { ${ev} :true });`;
    const clean = [`const o = { ${ev}uate: true };`, `const q = await ${imp}(\`./plugins/x\`);`];
    write(
      root,
      'apps/server/src/evil.ts',
      `${[dataImport, concatImport, worker, spacedWorker, ...clean].join('\n')}\n`,
    );

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([
      `apps/server/src/evil.ts:1  [dynamic ${imp} of data: URI]  ${dataImport}`,
      `apps/server/src/evil.ts:2  [dynamic ${imp} with concatenated specifier]  ${concatImport}`,
      `apps/server/src/evil.ts:3  [Worker ${ev} option]  ${worker}`,
      `apps/server/src/evil.ts:4  [Worker ${ev} option]  ${spacedWorker}`,
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  // AU-5: whitespace before the paren is the same call.
  it('flags spawn, fork and eval calls with whitespace before the paren (AU-5)', () => {
    const { root } = makeFixture();
    const spawn = `const c = cp.${sp} ('ls');`;
    const fork = `const f = ${fk} ('./child.js');`;
    const evalCall = `const r = ${ev} ('1 + 1');`;
    const tabbed = `const t = cp.${sp}\t('ls');`;
    write(root, 'apps/server/src/evil.ts', `${[spawn, fork, evalCall, tabbed].join('\n')}\n`);

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([
      `apps/server/src/evil.ts:1  [.${sp}( call]  ${spawn}`,
      `apps/server/src/evil.ts:2  [${fk}( call]  ${fork}`,
      `apps/server/src/evil.ts:3  [${ev}( call]  ${evalCall}`,
      `apps/server/src/evil.ts:4  [.${sp}( call]  ${tabbed}`,
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });
});

// AU-3 (2026-10-22). `node_modules`, `dist` and `coverage` used to be pruned at
// ANY depth, so a source file under a directory that merely borrowed one of
// those names was never read and the run still printed OK. They are now pruned
// only next to a package.json (the scan root always counts as a package root).
describe('check-no-spawner: build/vendor dirs pruned only at a package root (AU-3)', () => {
  it('scans a dist / coverage directory that is not at a package root', () => {
    const { root } = makeFixture();
    write(root, 'apps/x/package.json', JSON.stringify({ name: 'x' }));
    write(root, 'apps/x/src/dist/evil.ts', `${FORBIDDEN_LINE}\n`);
    write(root, 'hooks/coverage/evil.mjs', `${FORBIDDEN_LINE}\n`);

    const findings = scanTree(root);
    expect(findings.stage).toBe('scanned');
    expect([...findings.offenders].sort()).toEqual([
      `apps/x/src/dist/evil.ts:1  [${SUBPROCESS_LABEL}]  ${FORBIDDEN_LINE}`,
      `hooks/coverage/evil.mjs:1  [${SUBPROCESS_LABEL}]  ${FORBIDDEN_LINE}`,
    ]);
    expect(formatSpawnerReport(findings).exitCode).toBe(1);
  });

  it('still prunes them at a package root and at the scan root', () => {
    const { root } = makeFixture();
    write(root, 'apps/x/package.json', JSON.stringify({ name: 'x' }));
    write(root, 'apps/x/node_modules/dep/index.js', `${FORBIDDEN_LINE}\n`);
    write(root, 'apps/x/dist/index.js', `${FORBIDDEN_LINE}\n`);
    write(root, 'node_modules/dep/index.js', `${FORBIDDEN_LINE}\n`);
    write(root, 'coverage/report.js', `${FORBIDDEN_LINE}\n`);

    const findings = scanTree(root);
    expect(findings.stage).toBe('scanned');
    expect(findings.offenders).toEqual([]);
    expect(findings.unregisteredTopLevel).toEqual([]);
  });

  it('counts a nested node_modules in the top-level census', () => {
    const { root } = makeFixture();
    write(root, 'foo/node_modules/a.ts', 'export const a = 1;\n');

    const findings = scanTree(root);
    expect(findings.stage).toBe('unregistered-top-level');
    expect(findings.unregisteredTopLevel).toEqual([['foo', 1]]);
  });

  it('reads a manifest under a node_modules that is not at a package root', () => {
    const { root } = makeFixture();
    const crossSpawn = `cross-${['sp', 'awn'].join('')}`;
    write(root, 'apps/x/package.json', JSON.stringify({ name: 'x' }));
    write(
      root,
      'apps/x/src/node_modules/pkg/package.json',
      JSON.stringify({ name: 'pkg', dependencies: { [crossSpawn]: '7' } }),
    );

    const findings = scanTree(root);
    expect(findings.offenders).toEqual([
      `apps/x/src/node_modules/pkg/package.json  [subprocess package]  dependencies.${crossSpawn}`,
    ]);
    expect(findings.scannedManifests).toBe(2);
  });
});
