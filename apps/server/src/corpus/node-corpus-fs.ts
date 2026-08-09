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
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import type { CorpusFs, LstatInfo } from './fs-port';
import { OversizeError } from './fs-port';

type NodeError = Error & { code?: string };

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
      const fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) {
          // TOCTOU: the lstat'd regular file became a dir/fifo/socket before open.
          const err = new Error(`not a regular file: ${absPath}`) as NodeError;
          // A directory opened O_RDONLY|O_NOFOLLOW fstats as a dir → EISDIR. A
          // fifo or socket never reaches here (the open itself blocks or
          // errors), but a character device does: it opens cleanly and fstats as
          // neither file nor directory → ENOTREG. Both arms are integration
          // tested against real syscalls.
          err.code = st.isDirectory() ? 'EISDIR' : 'ENOTREG';
          throw err;
        }
        if (st.size > maxBytes) {
          throw new OversizeError(absPath, st.size, maxBytes);
        }
        return readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    },
  };
}
