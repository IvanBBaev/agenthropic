/**
 * WP-IN5 tail-follow — cheap per-session change fingerprint. `lstat`s (never
 * reads) the main `<uuid>.jsonl` and every regular file under
 * `<uuid>/subagents/**`, folding `relativePath:sizeBytes:mtimeMs` entries into
 * one deterministic string; the polling watcher re-ingests a session iff its
 * fingerprint differs from the previous tick's.
 *
 * Same posture as the substrate walk it mirrors: symlinks and non-regular
 * entries are ignored (they never ingest, so they must not perturb the
 * fingerprint), per-entry I/O hazards are skipped silently (the fingerprint
 * simply changes again once the entry stabilizes), the walk is depth-bounded,
 * and a traversal-shaped entry name throws {@link ContainmentError} — the one
 * non-swallowed signal. Files the parser would classify as 'other' (a stray
 * notes.txt) DO enter the fingerprint: their change triggers a redundant
 * re-ingest, which is harmless because ingest is idempotent.
 */
import { join, relative } from 'node:path';
import { assertWithinRoot, isSafeEntryName, toPosix } from './corpus-paths';
import {
  ContainmentError,
  type CorpusFs,
  type LstatInfo,
  type ReadLimits,
  type SessionRef,
} from './fs-port';

/** Only this immediate child of `<uuid>/` is walked — mirrors disk-substrate. */
const SUBAGENTS_DIR = 'subagents';

/** lstat, returning `null` instead of throwing when the entry is gone/unreadable. */
function tryLstat(fs: CorpusFs, absPath: string): LstatInfo | null {
  try {
    return fs.lstat(absPath);
  } catch {
    return null;
  }
}

/** Depth-bounded, symlink-skipping stat walk collecting `rel:size:mtime` entries. */
function collectEntries(
  fs: CorpusFs,
  sessionDirAbs: string,
  dirAbs: string,
  depth: number,
  limits: ReadLimits,
  entries: string[],
): void {
  if (depth > limits.maxDepth) {
    return;
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
    if (st === null || st.isSymbolicLink) {
      continue; // vanished, or a symlink (never ingested → never fingerprinted)
    }
    if (st.isDirectory) {
      collectEntries(fs, sessionDirAbs, abs, depth + 1, limits, entries);
      continue;
    }
    if (!st.isFile) {
      continue; // fifo/socket/device — never ingested
    }
    const relPath = toPosix(relative(sessionDirAbs, abs));
    entries.push(`${relPath}:${String(st.sizeBytes)}:${String(st.mtimeMs)}`);
  }
}

/**
 * Compute the change fingerprint for one enumerated session. Never reads file
 * content and never throws except {@link ContainmentError}.
 */
export function fingerprintSession(fs: CorpusFs, ref: SessionRef, limits: ReadLimits): string {
  const main = tryLstat(fs, ref.mainAbsPath);
  const mainPart =
    main === null || !main.isFile || main.isSymbolicLink
      ? 'main:absent'
      : `main:${String(main.sizeBytes)}:${String(main.mtimeMs)}`;

  const entries: string[] = [];
  const subagentsAbs = join(ref.sessionDirAbs, SUBAGENTS_DIR);
  const sub = tryLstat(fs, subagentsAbs);
  if (sub !== null && sub.isDirectory && !sub.isSymbolicLink) {
    collectEntries(fs, ref.sessionDirAbs, subagentsAbs, 1, limits, entries);
  }
  entries.sort();

  return [mainPart, ...entries].join('\n');
}
