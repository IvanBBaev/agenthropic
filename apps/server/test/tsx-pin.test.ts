/**
 * ARC-2 - `tsx` is pinned to one exact version, and the installed copy is that
 * version.
 *
 * Every checksum in every existing `schema_version` row was produced by the
 * tsx/esbuild transform (see the `//` note in apps/server/package.json and
 * test/migrations-checksum-stability.test.ts). A printer change in a tsx bump
 * would make every existing database refuse to boot with "was edited after
 * being applied". The stability test catches that once the bump is installed;
 * this test keeps the bump from arriving silently in the first place: a caret
 * or tilde range lets `pnpm up` or a lockfile refresh move tsx, an exact
 * version does not.
 *
 * Residual, stated plainly: tsx's own dependency on esbuild is a range chosen
 * by tsx, so esbuild is held by the lockfile alone (CI installs with
 * `--frozen-lockfile`). The stability test is the backstop for that half.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/** The packages that run code under tsx: the server run path and the fixture tooling. */
const TSX_CONSUMERS = ['apps/server', 'packages/test-fixtures'] as const;

interface PackageManifest {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(file: string): PackageManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as PackageManifest;
}

function declaredTsx(packageDir: string): string | undefined {
  const manifest = readManifest(path.join(REPO_ROOT, packageDir, 'package.json'));
  return manifest.devDependencies?.tsx ?? manifest.dependencies?.tsx;
}

describe('tsx exact pin (ARC-2)', () => {
  it.each(TSX_CONSUMERS)('%s declares tsx as an exact version', (packageDir) => {
    expect(declaredTsx(packageDir)).toMatch(EXACT_SEMVER);
  });

  it('every consumer pins the same version', () => {
    expect(new Set(TSX_CONSUMERS.map(declaredTsx)).size).toBe(1);
  });

  it('the installed tsx is the pinned version', () => {
    const requireFromServer = createRequire(path.join(REPO_ROOT, 'apps/server/package.json'));
    const installed = readManifest(requireFromServer.resolve('tsx/package.json')).version;
    expect(installed).toBe(declaredTsx('apps/server'));
  });
});
