/**
 * WP-IN5 tail-follow — cheap per-session change fingerprint. `lstat`s (never
 * reads) the main `<uuid>.jsonl` and every regular file under
 * `<uuid>/subagents/**`, folding `relativePath:sizeBytes:mtimeMs` entries into
 * one deterministic string; the polling watcher re-ingests a session when its
 * fingerprint differs from the last one it handled (a failed session keeps
 * retrying until quarantine; a pricing change re-admits parked sessions - see
 * ingest/corpus-watcher.ts).
 *
 * Same posture as the substrate walk it mirrors: symlinks and non-regular
 * entries are ignored (they never ingest, so they must not perturb the
 * fingerprint), per-entry I/O hazards are skipped silently (the fingerprint
 * simply changes again once the entry stabilizes), the walk is depth-bounded,
 * and a traversal-shaped entry name throws {@link ContainmentError} — the one
 * non-swallowed signal.
 *
 * "Skipped silently" here deliberately covers BOTH `gone` and `unreadable`
 * probe outcomes, unlike the substrate walk, which records the latter. The
 * fingerprint has no reporting channel and does not need one: a session whose
 * BUILD probe fails is recorded as `unreadable` by the build itself, which the
 * watcher turns into "not checkpointed, re-read on a schedule"; and once the
 * probe recovers the entry enters this fingerprint, so the fingerprint changes
 * and the session is re-read regardless. An unreadable entry therefore costs a
 * re-ingest, never content. Files the parser would classify as 'other' (a stray
 * notes.txt) DO enter the fingerprint: their change triggers a redundant
 * re-ingest, which is harmless because ingest is idempotent.
 */
import { join, relative } from 'node:path';
import {
  assertWithinRoot,
  isSafeEntryName,
  probeLstat,
  resolveSubagentsDir,
  toPosix,
} from './corpus-paths';
import { ContainmentError, type CorpusFs, type ReadLimits, type SessionRef } from './fs-port';

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

    const probe = probeLstat(fs, abs);
    if (probe.kind !== 'ok') {
      // `gone` (vanished) or `unreadable` (EACCES/EIO...): neither enters the
      // fingerprint — see the header for why the second needs no report here.
      continue;
    }
    const st = probe.info;
    if (st.isSymbolicLink) {
      continue; // a symlink is never ingested → never fingerprinted
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
  // `gone` and `unreadable` both read as absent: enumeration is what reports
  // an unprobeable transcript, and it drops the ref before this runs.
  const main = probeLstat(fs, ref.mainAbsPath);
  const mainPart =
    main.kind !== 'ok' || !main.info.isFile || main.info.isSymbolicLink
      ? 'main:absent'
      : `main:${String(main.info.sizeBytes)}:${String(main.info.mtimeMs)}`;

  const entries: string[] = [];
  // Same gate as the substrate walk, from the same definition: a symlinked
  // `<uuid>/` must not be descended into here either, or the fingerprint would
  // track files the walk refuses to ingest and re-trigger ingest forever.
  // An `unreadable` resolution fingerprints as no subtree at all, for the
  // same reason an unreadable entry does: the build records it, and recovery
  // changes this fingerprint.
  const subagents = resolveSubagentsDir(fs, ref.sessionDirAbs);
  if (subagents.kind === 'dir') {
    collectEntries(fs, ref.sessionDirAbs, subagents.abs, 1, limits, entries);
  }
  entries.sort();

  return [mainPart, ...entries].join('\n');
}
