/**
 * SEC-9 / OSS-10 - the CI supply-chain policy, read from the files themselves.
 *
 * A major tag such as `actions/checkout@v7` can be moved by whoever controls
 * the Action's repository, and the next CI run executes whatever it now points
 * at. A full commit SHA cannot be moved. Every `uses:` in .github/workflows is
 * therefore a 40-hex SHA with the release in a trailing comment, which is the
 * form Dependabot rewrites. Dependabot is configured for both ecosystems, and
 * CI installs from the lockfile only.
 *
 * Plain line matching on purpose: the repo has no YAML parser dependency and
 * this policy does not justify one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github/workflows');
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/;
const SHA_PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** Every `uses:` reference in a workflow, as written after `uses:`. */
function usesReferences(file: string): string[] {
  return readRepoFile(path.join('.github/workflows', file))
    .split('\n')
    .map((line) => USES_LINE.exec(line)?.[1])
    .filter((ref): ref is string => ref !== undefined);
}

describe('workflow supply chain (SEC-9)', () => {
  it('finds the workflows it is guarding', () => {
    expect(workflowFiles()).toEqual(expect.arrayContaining(['ci.yml', 'pages.yml']));
  });

  it.each(workflowFiles())('%s pins every Action to a commit SHA with its release', (file) => {
    const references = usesReferences(file);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference).toMatch(SHA_PINNED);
    }
  });

  it('pins one Action to one SHA across all workflows', () => {
    const shaByAction = new Map<string, Set<string>>();
    for (const file of workflowFiles()) {
      for (const reference of usesReferences(file)) {
        const [action = '', rest = ''] = reference.split('@');
        const shas = shaByAction.get(action) ?? new Set<string>();
        shas.add(rest);
        shaByAction.set(action, shas);
      }
    }
    for (const [action, shas] of shaByAction) {
      expect({ action, pins: shas.size }).toEqual({ action, pins: 1 });
    }
  });

  it('CI installs dependencies from the lockfile only', () => {
    const installs = readRepoFile('.github/workflows/ci.yml')
      .split('\n')
      .filter((line) => /\bpnpm install\b/.test(line));
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) {
      expect(line).toContain('--frozen-lockfile');
    }
  });

  it('Dependabot watches both the Actions and the npm workspace', () => {
    const config = readRepoFile('.github/dependabot.yml');
    expect(config).toMatch(/^version: 2$/m);
    expect(config).toMatch(/package-ecosystem: github-actions/);
    expect(config).toMatch(/package-ecosystem: npm/);
  });
});
