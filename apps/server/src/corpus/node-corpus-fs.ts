/**
 * WP-IN5 production {@link CorpusFs} — the SOLE module bound to `node:fs`, and
 * bound to its READ family only. It imports no write / rename / unlink / chmod /
 * writeFile / open-for-write symbol, so "the adapter cannot mutate the corpus"
 * is enforced structurally, not by convention (the `gate:spawner`-style intent:
 * a capability you never import cannot be misused).
 *
 * {@link CorpusFs.readFileConfined} is the security-critical primitive: it opens
 * with `O_NOFOLLOW` so a symlink swapped in after the caller's `lstat` cannot be
 * followed (TOCTOU defence), re-checks via `fstat` on the OPEN descriptor that
 * the target is a regular file within the size cap, and always closes the fd.
 *
 * SEC-8 (2026-11-19): both confined reads also open with `O_NONBLOCK`. A FIFO
 * swapped in after the caller's `lstat` would otherwise block `open` until a
 * writer appeared, hanging the ingest pass; with `O_NONBLOCK` a read-only open
 * of a FIFO returns at once and the `fstat` guard rejects it as `ENOTREG`. On a
 * regular file the flag changes nothing.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { CorpusFs, LstatInfo, TailRead } from './fs-port';
import { OversizeError } from './fs-port';

type NodeError = Error & { code?: string };

/**
 * Flags of both confined opens: read-only, never follow a symlink, never wait
 * on a FIFO (SEC-8).
 */
export const CONFINED_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * The shared post-open guard of both confined reads: `fstat` the OPEN
 * descriptor (TOCTOU defence — the path may have been swapped since the
 * caller's lstat) and enforce the size cap. Returns the file's byte size and
 * modification time from that one fstat.
 */
function confinedStat(
  fd: number,
  absPath: string,
  maxBytes: number,
): { sizeBytes: number; mtimeMs: number } {
  const st = fstatSync(fd);
  if (!st.isFile()) {
    // TOCTOU: the lstat'd regular file became a dir/fifo/socket before open.
    const err = new Error(`not a regular file: ${absPath}`) as NodeError;
    // A directory opened O_RDONLY|O_NOFOLLOW fstats as a dir → EISDIR. A
    // fifo (opened O_NONBLOCK, so it does not wait for a writer) or a
    // character device opens cleanly and fstats as neither file nor
    // directory → ENOTREG; a socket never reaches here (its open errors).
    // Both arms are integration tested against real syscalls.
    err.code = st.isDirectory() ? 'EISDIR' : 'ENOTREG';
    throw err;
  }
  if (st.size > maxBytes) {
    throw new OversizeError(absPath, st.size, maxBytes);
  }
  return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
}

export function nodeCorpusFs(): CorpusFs {
  return {
    readDirNames(absDir: string): string[] {
      return readdirSync(absDir);
    },

    lstat(absPath: string): LstatInfo {
      const st = lstatSync(absPath);
      return {
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        isSymbolicLink: st.isSymbolicLink(),
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      };
    },

    realpath(absPath: string): string {
      return realpathSync(absPath);
    },

    readFileConfined(absPath: string, maxBytes: number): string {
      // O_NOFOLLOW: if `absPath` is (or was swapped to) a symlink, openSync
      // fails with ELOOP instead of following it out of the corpus root.
      // O_NONBLOCK: a FIFO opens at once and is rejected by the fstat guard.
      const fd = openSync(absPath, CONFINED_OPEN_FLAGS);
      try {
        confinedStat(fd, absPath, maxBytes);
        return readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    },

    readFileTailConfined(absPath: string, fromByte: number, maxBytes: number): TailRead {
      const fd = openSync(absPath, CONFINED_OPEN_FLAGS);
      try {
        const { sizeBytes, mtimeMs } = confinedStat(fd, absPath, maxBytes);
        const start = Math.min(fromByte, sizeBytes);
        const data = new Uint8Array(sizeBytes - start);
        // One positional read satisfies a regular file under the 64MiB cap; if
        // the file shrank between fstat and read, the short result is
        // truncated honestly rather than padded with zero bytes.
        const read = readSync(fd, data, 0, data.length, start);
        return { data: data.subarray(0, read), sizeBytes, mtimeMs };
      } finally {
        closeSync(fd);
      }
    },
  };
}
