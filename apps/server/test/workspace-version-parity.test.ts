/**
 * OSS-18 - the six manifests carry one version.
 *
 * The version lives in the root `package.json` and in every workspace package
 * listed in `pnpm-workspace.yaml`. RELEASE.md §7 bumps them with one command and
 * checks them with a one-liner, but that check runs once per release. A package
 * bumped by hand between releases, or a new workspace package that starts at
 * `0.0.0`, would surface only on tag day. This test runs the same check in every
 * gate, and pins the release one-liner's file list to the workspace, so the
 * release check cannot skip a package that was added later.
 *
 * Plain line matching on purpose, as in workflow-supply-chain.test.ts: the repo
 * has no YAML parser dependency and this check does not justify one.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** The `packages:` entries of pnpm-workspace.yaml, in file order. */
function workspacePackages(): string[] {
  const yaml = readRepoFile('pnpm-workspace.yaml');
  const block = yaml.slice(yaml.indexOf('packages:\n') + 'packages:\n'.length);
  const entries: string[] = [];
  for (const line of block.split('\n')) {
    const match = /^ {2}- (\S+)$/.exec(line);
    if (match === null) break;
    entries.push(match[1] as string);
  }
  return entries;
}

function manifests(): string[] {
  return ['package.json', ...workspacePackages().map((dir) => `${dir}/package.json`)];
}

function versionOf(manifest: string): unknown {
  return (JSON.parse(readRepoFile(manifest)) as { version?: unknown }).version;
}

describe('workspace version parity (OSS-18)', () => {
  it('lists the five workspace packages as plain directories', () => {
    // A glob such as `apps/*` would make the list below depend on the disk.
    expect(workspacePackages()).toEqual([
      'apps/server',
      'apps/web',
      'packages/shared',
      'packages/core',
      'packages/test-fixtures',
    ]);
  });

  it('gives the root and every workspace package the same semver version', () => {
    const versions = manifests().map((manifest) => ({ manifest, version: versionOf(manifest) }));
    const root = versions[0]?.version;
    expect(root).toMatch(/^\d+\.\d+\.\d+$/);
    for (const entry of versions) {
      expect(entry).toEqual({ manifest: entry.manifest, version: root });
    }
  });

  it('the RELEASE.md version check reads exactly these manifests', () => {
    const release = readRepoFile('RELEASE.md');
    const check = /node -e 'const fs=require\("fs"\);const v=\[([^\]]+)\]/.exec(release);
    expect(check).not.toBeNull();
    const listed = [...(check?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect([...listed].sort()).toEqual([...manifests()].sort());
  });
});
