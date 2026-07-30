/**
 * WP-IN5 pure path helpers — no I/O of their own beyond the single injected
 * {@link CorpusFs.realpath} call in {@link resolveCorpusRoot}. Kept separate
 * from {@link ./disk-substrate} so the containment / naming rules are unit
 * testable in isolation and reused identically by both the session enumerator
 * and the artifact walk.
 */
import { homedir as osHomedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { CorpusFs } from './fs-port';
import { ContainmentError, errnoCodeOf } from './fs-port';

/** Strict Claude-Code session id: lowercase 8-4-4-4-12 hex, nothing else. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True only for a canonical lowercase session UUID (the `<uuid>.jsonl` stem). */
export function isSessionUuid(name: string): boolean {
  return SESSION_UUID_RE.test(name);
}

/**
 * True when a directory-entry name is a plain, in-place basename. Rejects the
 * empty string, the `.`/`..` traversal entries, and any name carrying a POSIX
 * or Windows path separator — the names a real `readdir` never returns but a
 * crafted corpus might. A false result is treated by the callers as a hard
 * {@link ContainmentError}, not a benign skip.
 */
export function isSafeEntryName(name: string): boolean {
  return (
    name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  );
}

/**
 * Resolve the canonical corpus root: `CLAUDE_PROJECTS_DIR` when set, else
 * `<home>/.claude/projects`, then canonicalized via {@link CorpusFs.realpath}
 * so every later containment check compares against a symlink-free absolute
 * path. Returns `null` when the root does not exist (ENOENT) — a fresh machine
 * with no corpus yet is a normal, empty-result condition, not an error.
 */
export function resolveCorpusRoot(
  env: Record<string, string | undefined>,
  fs: CorpusFs,
  homedir: () => string = osHomedir,
): string | null {
  const root = env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
  try {
    return fs.realpath(root);
  } catch (err) {
    if (errnoCodeOf(err) === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Assert `candidateAbs` resolves at or beneath `realRoot`. The candidate is
 * `path.resolve`d first (collapsing any residual `.`/`..`), then required to be
 * the root itself or to sit under `root + sep`. Throws {@link ContainmentError}
 * otherwise. Belt-and-braces with {@link isSafeEntryName}: even if a bad name
 * slipped through, a resolved path outside the root is stopped here.
 */
export function assertWithinRoot(realRoot: string, candidateAbs: string): void {
  const resolved = resolve(candidateAbs);
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
    throw new ContainmentError(resolved, realRoot);
  }
}

/**
 * Split raw file content into transcript lines. In a `.jsonl` file every
 * complete record is newline-TERMINATED, so the final segment `split` yields is
 * never a record: it is either the empty string (file ends in a newline) or a
 * half-written record from a live Claude Code append. Both are dropped, so the
 * result is exactly the complete records. Sidecars (`*.meta.json`, a single
 * unterminated object) are exempt — their sole line must be kept.
 */
export function splitTranscriptLines(content: string, isJsonl: boolean): string[] {
  const lines = content.split('\n');
  if (isJsonl) {
    lines.pop();
  }
  return lines;
}

/** Normalize an OS-native relative path to POSIX separators for classification/storage. */
export function toPosix(relativePath: string): string {
  return relativePath.split(sep).join('/');
}
