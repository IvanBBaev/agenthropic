/**
 * WP-IN5 disk → substrate adapter. Two pure-ish functions over a {@link CorpusFs}:
 *
 *  - {@link enumerateSessions} keys sessions on the project-root `<uuid>.jsonl`
 *    regular file (NEVER on `<uuid>/` directories — an orphan workflow dir with
 *    no root transcript is not a session), deriving `projectSlug` from the slug
 *    directory basename VERBATIM.
 *  - {@link buildSessionSubstrate} assembles ONE {@link SessionSubstrate} per
 *    session feeding ONLY the four parser-spec section-2 artifact types: the
 *    bare `<uuid>.jsonl` main plus, under `<uuid>/subagents/**`,
 *    `agent-<hex>.jsonl`, `agent-<hex>.meta.json` and `journal.jsonl`. Every
 *    file is classified by the parser's own {@link classifyRelativePath}, so the
 *    reader's allowlist can never drift from what the parser accepts.
 *
 * Hazard posture: every per-file I/O hazard (vanished mid-walk, EACCES,
 * oversize, a non-regular entry, a symlink) is recorded as a {@link SkippedFile}
 * and the walk continues — one unreadable artifact never sinks a session. The
 * SOLE exception is {@link ContainmentError} (a traversal-shaped entry name or a
 * resolved path escaping the root): that is not swallowed, it aborts the run,
 * because it signals a crafted / compromised corpus.
 */
import { basename, join, relative } from 'node:path';
import { classifyRelativePath, type SubstrateFile } from '@agenthropic/core';
import {
  ContainmentError,
  OversizeError,
  errnoCodeOf,
  type BuiltSubstrate,
  type CorpusFs,
  type LstatInfo,
  type ReadLimits,
  type SessionRef,
  type SkipReason,
  type SkippedFile,
} from './fs-port';
import {
  assertWithinRoot,
  isSafeEntryName,
  isSessionUuid,
  splitTranscriptLines,
  toPosix,
} from './corpus-paths';

const JSONL_SUFFIX = '.jsonl';
/** Only this immediate child of `<uuid>/` is walked — never the session dir root. */
const SUBAGENTS_DIR = 'subagents';

/** Map a caught read hazard to its {@link SkipReason}. */
function reasonFor(err: unknown): SkipReason {
  if (err instanceof OversizeError) {
    return 'oversize';
  }
  // O_NOFOLLOW rejects a symlink swapped in after lstat with ELOOP.
  if (errnoCodeOf(err) === 'ELOOP') {
    return 'symlink';
  }
  return 'unreadable';
}

/** lstat, returning `null` instead of throwing when the entry is gone/unreadable. */
function tryLstat(fs: CorpusFs, absPath: string): LstatInfo | null {
  try {
    return fs.lstat(absPath);
  } catch {
    return null;
  }
}

/** True when `absPath` is a real directory (a symlinked dir returns false — never followed). */
function isRealDir(fs: CorpusFs, absPath: string): boolean {
  const st = tryLstat(fs, absPath);
  return st !== null && st.isDirectory && !st.isSymbolicLink;
}

/**
 * Enumerate every session under the canonical corpus root. A session exists iff
 * a slug directory holds a regular, non-symlink `<uuid>.jsonl` file whose stem
 * is a canonical session UUID. `<uuid>/` subdirectories are NOT sessions on
 * their own (an orphan workflow dir with no root transcript is skipped).
 *
 * Never throws on a per-entry hazard (a vanished / unreadable slug or entry is
 * simply skipped). Propagates {@link ContainmentError} for a traversal-shaped
 * name — the one non-recoverable signal.
 */
export function enumerateSessions(fs: CorpusFs, corpusRoot: string): SessionRef[] {
  const refs: SessionRef[] = [];

  let slugNames: string[];
  try {
    slugNames = fs.readDirNames(corpusRoot);
  } catch {
    return refs; // unreadable / missing root → no sessions
  }

  for (const slug of slugNames) {
    if (!isSafeEntryName(slug)) {
      throw new ContainmentError(join(corpusRoot, slug), corpusRoot);
    }
    const slugDirAbs = join(corpusRoot, slug);
    assertWithinRoot(corpusRoot, slugDirAbs);

    if (!isRealDir(fs, slugDirAbs)) {
      continue; // a stray file (e.g. .DS_Store) or a symlinked slug dir → skip
    }

    let entries: string[];
    try {
      entries = fs.readDirNames(slugDirAbs);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(JSONL_SUFFIX)) {
        continue;
      }
      const stem = entry.slice(0, -JSONL_SUFFIX.length);
      if (!isSessionUuid(stem)) {
        continue; // a non-session *.jsonl at the slug root is not a main transcript
      }
      const mainAbsPath = join(slugDirAbs, entry);
      assertWithinRoot(corpusRoot, mainAbsPath);

      const st = tryLstat(fs, mainAbsPath);
      if (st === null || !st.isFile || st.isSymbolicLink) {
        continue; // gone, a directory, or a symlinked transcript → not a session
      }

      refs.push({
        sessionId: stem,
        projectSlug: slug,
        mainAbsPath,
        sessionDirAbs: join(slugDirAbs, stem),
      });
    }
  }

  return refs;
}

/** Mutable accumulator threaded through the artifact walk. */
interface BuildState {
  readonly files: SubstrateFile[];
  readonly skipped: SkippedFile[];
  hasAgent: boolean;
}

/**
 * Depth-bounded, symlink-skipping walk of `<uuid>/subagents/**`. Every entry is
 * `lstat`ed; symlinks and non-regular entries are recorded and skipped, real
 * subdirectories are recursed (up to `maxDepth`), and every regular file is
 * classified by {@link classifyRelativePath} on the SAME relative-path string
 * that is later stored ("one string, two uses" — the stored path is exactly the
 * one the parser will re-classify). A traversal-shaped entry name throws
 * {@link ContainmentError}.
 */
function walkArtifacts(
  fs: CorpusFs,
  sessionDirAbs: string,
  dirAbs: string,
  depth: number,
  limits: ReadLimits,
  state: BuildState,
): void {
  if (depth > limits.maxDepth) {
    return; // belt-and-braces against a symlink cycle the lstat guard already blocks
  }

  let names: string[];
  try {
    names = fs.readDirNames(dirAbs);
  } catch {
    return; // directory vanished / unreadable mid-walk → benign
  }

  for (const name of names) {
    if (!isSafeEntryName(name)) {
      throw new ContainmentError(join(dirAbs, name), sessionDirAbs);
    }
    const abs = join(dirAbs, name);
    assertWithinRoot(sessionDirAbs, abs);

    const st = tryLstat(fs, abs);
    if (st === null) {
      continue; // vanished between readdir and lstat
    }
    const relPath = toPosix(relative(sessionDirAbs, abs));

    if (st.isSymbolicLink) {
      state.skipped.push({ relativePath: relPath, reason: 'symlink' });
      continue;
    }
    if (st.isDirectory) {
      walkArtifacts(fs, sessionDirAbs, abs, depth + 1, limits, state);
      continue;
    }
    if (!st.isFile) {
      state.skipped.push({ relativePath: relPath, reason: 'not-regular-file' });
      continue;
    }

    const kind = classifyRelativePath(relPath);
    if (kind !== 'agent' && kind !== 'meta' && kind !== 'journal') {
      // 'other' (a stray .txt/.js/.DS_Store) — or the structurally-impossible
      // 'main' (a bare no-slash name can never appear under subagents/). Neither
      // is a section-2 artifact, so it is recorded and skipped, never ingested.
      state.skipped.push({ relativePath: relPath, reason: 'non-artifact' });
      continue;
    }

    let content: string;
    try {
      content = fs.readFileConfined(abs, limits.maxFileBytes);
    } catch (err) {
      state.skipped.push({ relativePath: relPath, reason: reasonFor(err), code: errnoCodeOf(err) });
      continue;
    }

    if (kind === 'agent') {
      // Guard on the SPLIT lines, not the raw content: a live append caught
      // mid-first-record (`{"a":1}` with no terminating newline) is non-blank
      // as text but yields zero complete records. An agent transcript with no
      // timestamped record makes parseSession throw for the WHOLE session, so
      // it is dropped here. `parseFile` tolerates blank lines, so an all-blank
      // file is equivalent to no records.
      const lines = splitTranscriptLines(content, true);
      if (lines.every((line) => line.trim() === '')) {
        state.skipped.push({ relativePath: relPath, reason: 'empty-agent' });
        continue;
      }
      state.files.push({ relativePath: relPath, lines });
      state.hasAgent = true;
      continue;
    }

    // journal is JSONL (tail-trim a live partial); meta is a single-object
    // sidecar (no trailing newline — must not be tail-trimmed).
    state.files.push({
      relativePath: relPath,
      lines: splitTranscriptLines(content, kind === 'journal'),
    });
  }
}

/**
 * Build the substrate for one enumerated session. Producer 1 reads the main
 * `<uuid>.jsonl`; Producer 2 walks `<uuid>/subagents/**` for the three nested
 * artifact types. Returns `null` when NEITHER a main transcript NOR any agent
 * transcript survived (a meta/journal-only remnant cannot parse), so the runner
 * can skip it cleanly. Never throws except {@link ContainmentError}.
 */
export function buildSessionSubstrate(
  fs: CorpusFs,
  ref: SessionRef,
  limits: ReadLimits,
): BuiltSubstrate | null {
  const state: BuildState = { files: [], skipped: [], hasAgent: false };

  // Producer 1 — the project-root main transcript (bare `<uuid>.jsonl`).
  const mainRel = basename(ref.mainAbsPath);
  let hasMain = false;
  try {
    const content = fs.readFileConfined(ref.mainAbsPath, limits.maxFileBytes);
    // `mainRel` is `<uuid>.jsonl` by construction (enumerateSessions) → 'main'.
    // Same guard as the agent arm: a main that yields no complete record (a
    // just-created session whose first record is not flushed yet, or a live
    // append caught mid-record) would make parseSession throw for the whole
    // session. Dropping it lets any live subagents still ingest, and a session
    // with nothing else falls through to the `null` return below — reported as
    // skipped, not as a failure.
    const lines = splitTranscriptLines(content, true);
    if (lines.every((line) => line.trim() === '')) {
      state.skipped.push({ relativePath: mainRel, reason: 'empty-main' });
    } else {
      state.files.push({ relativePath: mainRel, lines });
      hasMain = true;
    }
  } catch (err) {
    state.skipped.push({ relativePath: mainRel, reason: reasonFor(err), code: errnoCodeOf(err) });
  }

  // Producer 2 — nested subagent artifacts, confined to `<uuid>/subagents/**`.
  const subagentsAbs = join(ref.sessionDirAbs, SUBAGENTS_DIR);
  if (isRealDir(fs, subagentsAbs)) {
    walkArtifacts(fs, ref.sessionDirAbs, subagentsAbs, 1, limits, state);
  }

  if (!hasMain && !state.hasAgent) {
    return null;
  }
  return {
    substrate: { files: state.files },
    projectSlug: ref.projectSlug,
    skipped: state.skipped,
  };
}
