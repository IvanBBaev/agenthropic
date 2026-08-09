/**
 * Disk adapters for the annotation tooling. Strictly read-only: nothing here
 * writes, moves or repairs anything, which matters because the substrate it
 * points at may be a real `~/.claude/projects` session tree.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ANNOTATION_SUFFIX, parseAnnotation } from './parse.js';
import type { SessionAnnotation } from './types.js';

/** One file, already split into JSONL lines (a `SubstrateFile` satisfies this). */
export interface SubstrateFileLike {
  readonly relativePath: string;
  readonly lines: readonly string[];
}

/** A whole session's files (a `SessionSubstrate` / `Fixture` satisfies this). */
export interface SessionSubstrateLike {
  readonly files: readonly SubstrateFileLike[];
}

/**
 * Loads and validates every `*.hierarchy.md` in a directory, sorted by name.
 * A missing directory yields an empty list - an unlabeled corpus is a legitimate
 * state that must report `n = 0`, not crash.
 *
 * @throws {import('./types.js').AnnotationError} on the first malformed file.
 */
export function readAnnotationDir(dir: string): SessionAnnotation[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(ANNOTATION_SUFFIX))
    .sort()
    .map((name) => parseAnnotation(name, readFileSync(join(dir, name), 'utf8')));
}

function walk(root: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(join(root, entry.name), relativePath, out);
    } else {
      out.push(relativePath);
    }
  }
}

/**
 * Reads one on-disk session tree into a parser substrate.
 *
 * Expects the Claude Code layout: `<dir>/<sessionId>.jsonl` for the main
 * transcript, next to a `<dir>/<sessionId>/` subtree for the subagent,
 * sidecar, workflow and journal artifacts. Relative paths are reported the way
 * the parser expects them - the main transcript at the top level, everything
 * else relative to the session subtree.
 *
 * @param isArtifact - the caller's classifier, so the definition of "artifact"
 * stays single-sourced from the parser rather than re-implemented here.
 * @returns `null` when the session's main transcript is not present, so a
 * corpus that is simply not on this machine degrades to "unavailable" instead
 * of a failure.
 */
export function readSessionTree(
  dir: string,
  sessionId: string,
  isArtifact: (relativePath: string) => boolean,
): SessionSubstrateLike | null {
  const mainName = `${sessionId}.jsonl`;
  const mainPath = join(dir, mainName);
  if (!existsSync(mainPath)) {
    return null;
  }

  const files: SubstrateFileLike[] = [
    { relativePath: mainName, lines: readFileSync(mainPath, 'utf8').split('\n') },
  ];

  const subtree = join(dir, sessionId);
  if (existsSync(subtree)) {
    const relativePaths: string[] = [];
    walk(subtree, '', relativePaths);
    for (const relativePath of relativePaths.sort()) {
      if (isArtifact(relativePath)) {
        files.push({
          relativePath,
          lines: readFileSync(join(subtree, relativePath), 'utf8').split('\n'),
        });
      }
    }
  }

  return { files };
}
