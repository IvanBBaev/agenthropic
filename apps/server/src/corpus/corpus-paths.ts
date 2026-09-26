/**
 * WP-IN5 path and containment helpers. Mostly pure; the exceptions are the
 * injected {@link CorpusFs.realpath} call in {@link resolveCorpusRoot} and the
 * `lstat` probes below. Kept separate from {@link ./disk-substrate} so the
 * containment / naming rules are unit testable in isolation and reused
 * identically by the session enumerator, the artifact walk and the change
 * fingerprint — one definition each, because a containment rule that is
 * restated per call site is a rule with a hole in it waiting to happen.
 */
import { homedir as osHomedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { CorpusFs, LstatInfo } from './fs-port';
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

/** The ONLY immediate child of `<uuid>/` that is ever walked or fingerprinted. */
export const SUBAGENTS_DIR = 'subagents';

/**
 * The three things an `lstat` probe can say about an entry the walk was handed
 * by `readdir`. `gone` and `unreadable` are DIFFERENT facts and must stay
 * distinguishable: the first means there is nothing to ingest, the second means
 * there is something the dashboard cannot see — and a caller that folded both
 * into "skip silently" ingested a session main-only, recorded nothing, and let
 * the watcher checkpoint it as complete (finding F1).
 */
export type LstatOutcome =
  | { readonly kind: 'ok'; readonly info: LstatInfo }
  /**
   * `ENOENT` — the entry vanished between `readdir` and `lstat` — or `ENOTDIR`,
   * which is the same TOCTOU vanish one level up: an intermediate directory
   * was replaced by a non-directory after it was listed, so the path no
   * longer names anything. Neither leaves content behind to miss.
   */
  | { readonly kind: 'gone' }
  /** Any other errno (`EACCES`, `EPERM`, `EIO`...): the entry exists, the probe could not look. */
  | { readonly kind: 'unreadable'; readonly code: string | undefined };

/** lstat as an explicit {@link LstatOutcome}; never throws. */
export function probeLstat(fs: CorpusFs, absPath: string): LstatOutcome {
  try {
    return { kind: 'ok', info: fs.lstat(absPath) };
  } catch (err) {
    const code = errnoCodeOf(err);
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'gone' }
      : { kind: 'unreadable', code };
  }
}

/** True when the probed entry is a real directory (a symlinked dir is false — never followed). */
export function isRealDir(st: LstatInfo): boolean {
  return st.isDirectory && !st.isSymbolicLink;
}

/**
 * What {@link resolveSubagentsDir} decided about one session's
 * `<uuid>/subagents`: walk it, there is nothing to walk, or a probe on the way
 * failed for a reason other than absence — in which case `relativePath` names
 * the subtree (session-relative, POSIX) the caller consequently did not walk,
 * ready to be recorded as an `unreadable` {@link SkippedFile}.
 */
export type SubagentsDirResolution =
  | { readonly kind: 'dir'; readonly abs: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly relativePath: string; readonly code?: string };

/**
 * Resolve `<uuid>/subagents` for one session: `dir` when it may be descended
 * into, `absent` when there is nothing to descend into, `unreadable` when the
 * probe itself failed (see {@link SubagentsDirResolution}).
 *
 * BOTH components are checked, and the session dir is the whole reason this
 * function exists. `lstat` reports on the FINAL component only — the kernel
 * silently resolves every intermediate one on the way there. So probing
 * `<uuid>/subagents` by itself answers about `<target>/subagents` whenever
 * `<uuid>` is a symlink, and answers "a real directory, not a link" — the guard
 * passes precisely in the case it exists to stop.
 *
 * Every other component of the corpus walk was already vetted: the root is
 * `realpath`d, the slug dir and the main transcript are each lstat'ed and
 * rejected when symlinked. `<uuid>/` was the one that was not, because unlike
 * the others it is never read off disk — it is synthesised by joining the
 * transcript stem onto the slug dir, so no readdir result ever passed under a
 * check. A symlink there was therefore followed transparently, and files from
 * outside the corpus root were read and persisted as this session's subagent
 * activity. Nothing downstream catches that: a confined read's `O_NOFOLLOW`
 * also guards only the final component (the targets are real files), and
 * {@link assertWithinRoot} is lexical — `resolve` plus a prefix compare, no
 * `realpath` — so the symlinked prefix satisfies it.
 *
 * Answering `absent` rather than throwing keeps the posture every other symlink
 * encounter in this reader has: not walked, not an error. A symlinked session
 * dir is a fact about someone's disk, not proof of a crafted corpus the way a
 * traversal-shaped entry NAME is.
 *
 * A probe that fails for any reason other than absence is `unreadable`, and it
 * is reported under `subagents` whichever of the two components failed: that
 * is the subtree the caller declines to walk as a result, exactly as a failed
 * `readdir` of `subagents/` is reported by the walk itself. Naming `<uuid>/`
 * would name a path the session's substrate never contains.
 */
export function resolveSubagentsDir(fs: CorpusFs, sessionDirAbs: string): SubagentsDirResolution {
  const sessionDir = probeLstat(fs, sessionDirAbs);
  if (sessionDir.kind === 'unreadable') {
    return { kind: 'unreadable', relativePath: SUBAGENTS_DIR, code: sessionDir.code };
  }
  if (sessionDir.kind === 'gone' || !isRealDir(sessionDir.info)) {
    return { kind: 'absent' };
  }
  const subagentsAbs = join(sessionDirAbs, SUBAGENTS_DIR);
  const subagents = probeLstat(fs, subagentsAbs);
  if (subagents.kind === 'unreadable') {
    return { kind: 'unreadable', relativePath: SUBAGENTS_DIR, code: subagents.code };
  }
  if (subagents.kind === 'gone' || !isRealDir(subagents.info)) {
    return { kind: 'absent' };
  }
  return { kind: 'dir', abs: subagentsAbs };
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
