/**
 * ARC-12 - the root entry of `@agenthropic/shared` is browser-safe.
 *
 * The SPA imports the root entry, so its module graph must not reach a
 * `node:` builtin or a test double. This walks the graph from `src/index.ts`
 * through every relative import and fails on either. The node-only security
 * primitives live behind `@agenthropic/shared/node` and the fakes behind
 * `@agenthropic/shared/testing`, both declared in the package's `exports`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as root from '../src/index';
import * as nodeEntry from '../src/node';
import * as testingEntry from '../src/testing/index';

const PACKAGE_DIR = path.resolve(__dirname, '..');
const SPECIFIER = /\bfrom\s+'([^']+)'/g;

/** Every module specifier a source file imports or re-exports from. */
function specifiersOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((match) => match[1] as string);
}

/** Resolve a relative specifier the way the bundler resolution does for this package. */
function resolveRelative(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier);
  const candidate = [`${base}.ts`, path.join(base, 'index.ts')].find((file) => existsSync(file));
  if (candidate === undefined) throw new Error(`cannot resolve ${specifier} from ${from}`);
  return candidate;
}

/** The files reachable from `entry` and the bare specifiers they import. */
function moduleGraph(entry: string): { files: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
      else external.add(specifier);
    }
  }
  return {
    files: [...seen].map((file) => path.relative(PACKAGE_DIR, file)).sort(),
    external: [...external].sort(),
  };
}

describe('shared entry points (ARC-12)', () => {
  const graph = moduleGraph(path.join(PACKAGE_DIR, 'src/index.ts'));

  it('walks a real graph from the root entry', () => {
    expect(graph.files).toContain('src/index.ts');
    expect(graph.files).toContain('src/schemas/common.ts');
  });

  it('the root entry reaches no node builtin', () => {
    expect(graph.external.filter((specifier) => specifier.startsWith('node:'))).toEqual([]);
  });

  it('the root entry reaches no test double and no security module', () => {
    expect(graph.files.filter((file) => /^src\/(testing|security)\//.test(file))).toEqual([]);
  });

  it('the root entry no longer exports the moved names', () => {
    for (const name of [
      'InMemoryEventStore',
      'InMemoryAlertSink',
      'requireDashboardToken',
      'timingSafeTokenEqual',
    ]) {
      expect(Object.hasOwn(root, name)).toBe(false);
    }
  });

  it('the subpath entries export them instead', () => {
    expect(Object.keys(testingEntry).sort()).toEqual(['InMemoryAlertSink', 'InMemoryEventStore']);
    expect(Object.keys(nodeEntry).sort()).toEqual([
      'MIN_TOKEN_DISTINCT_CHARACTERS',
      'MIN_TOKEN_LENGTH',
      'assertLoopbackHost',
      'generateDashboardToken',
      'isAllowedHost',
      'isAllowedOrigin',
      'redactTokenInUrl',
      'requireDashboardToken',
      'timingSafeTokenEqual',
    ]);
  });

  it('the package exports map declares the three entries', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(manifest.exports).toEqual({
      '.': { types: './src/index.ts', default: './src/index.ts' },
      './node': { types: './src/node.ts', default: './src/node.ts' },
      './testing': { types: './src/testing/index.ts', default: './src/testing/index.ts' },
    });
  });

  it('refuses a relative import it cannot resolve', () => {
    expect(() => resolveRelative(path.join(PACKAGE_DIR, 'src/index.ts'), './missing')).toThrow(
      /cannot resolve/,
    );
  });
});
