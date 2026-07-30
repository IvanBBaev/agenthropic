/**
 * In-memory {@link CorpusFs} fake + a real-fs `materializeTree` helper for the
 * WP-IN5 corpus tests. The fake models the exact hazard surface the disk
 * adapter must survive (symlinks, non-regular entries, oversize files, EACCES,
 * a directory whose `readdir` throws mid-walk, a crafted traversal name) WITHOUT
 * ever touching the real `~/.claude/projects`. Node kinds map to `lstat` bits
 * and to `readFileConfined`'s `O_NOFOLLOW` semantics:
 *
 *  - `file`     → isFile; read returns its content (or throws `throwCode`).
 *  - `dir`      → isDirectory; `readDirNames` lists its children.
 *  - `symlink`  → isSymbolicLink; `readFileConfined` throws `ELOOP` (O_NOFOLLOW).
 *  - `fifo`     → none of the three bits (a non-regular entry); read throws `ENOTREG`.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CorpusFs, LstatInfo } from '../../src/corpus/fs-port';
import { OversizeError } from '../../src/corpus/fs-port';

export interface FileSpec {
  readonly type: 'file';
  readonly content: string;
  /** When set, `readFileConfined` throws a coded fs error (e.g. `EACCES`, `ELOOP`). */
  readonly throwCode?: string;
  /** Byte size override (defaults to the UTF-8 length of `content`), for oversize tests. */
  readonly size?: number;
  /** `lstat().mtimeMs` for this file (defaults to 0), for tail-follow fingerprint tests. */
  readonly mtimeMs?: number;
}
export interface DirSpec {
  readonly type: 'dir';
  readonly children: TreeSpec;
  /** When set, `readDirNames` on this directory throws a coded fs error. */
  readonly throwReaddir?: string;
  /**
   * Names `readDirNames` reports but that resolve to nothing — models a TOCTOU
   * vanish (an entry listed by `readdir` whose subsequent `lstat` throws ENOENT).
   */
  readonly phantoms?: readonly string[];
}
export interface SymlinkSpec {
  readonly type: 'symlink';
  readonly target?: string;
}
export interface FifoSpec {
  readonly type: 'fifo';
}
export type NodeSpec = FileSpec | DirSpec | SymlinkSpec | FifoSpec;
export interface TreeSpec {
  readonly [name: string]: NodeSpec;
}

export function file(
  content: string,
  opts: { throwCode?: string; size?: number; mtimeMs?: number } = {},
): FileSpec {
  return { type: 'file', content, ...opts };
}
export function dir(
  children: TreeSpec,
  opts: { throwReaddir?: string; phantoms?: readonly string[] } = {},
): DirSpec {
  return { type: 'dir', children, ...opts };
}
export function symlink(target = '/somewhere/else'): SymlinkSpec {
  return { type: 'symlink', target };
}
export function fifo(): FifoSpec {
  return { type: 'fifo' };
}

type CodedError = Error & { code?: string };

function codedError(code: string, message: string): CodedError {
  const err = new Error(message) as CodedError;
  err.code = code;
  return err;
}

export interface FakeFsOptions {
  /** Force `readDirNames(root)` to throw this code (simulate an unreadable root). */
  readonly rootReaddirCode?: string;
  /** Force EVERY `realpath` call to throw this code (e.g. `EACCES` for the rethrow path). */
  readonly realpathThrow?: string;
}

/**
 * Construct an injectable read-only {@link CorpusFs} over an in-memory tree
 * mounted at `root` (a POSIX absolute path). `tree` is the CONTENTS of `root`.
 */
export function makeFakeCorpusFs(
  root: string,
  tree: TreeSpec,
  options: FakeFsOptions = {},
): CorpusFs {
  const resolve = (absPath: string): NodeSpec => {
    if (absPath === root) {
      return { type: 'dir', children: tree };
    }
    if (!absPath.startsWith(root + '/')) {
      throw codedError('ENOENT', `outside fake root: ${absPath}`);
    }
    const segs = absPath.slice(root.length + 1).split('/');
    let current: TreeSpec = tree;
    let found: NodeSpec | undefined;
    for (const [idx, seg] of segs.entries()) {
      const node: NodeSpec | undefined = current[seg];
      if (node === undefined) {
        throw codedError('ENOENT', `no such node: ${absPath}`);
      }
      if (idx === segs.length - 1) {
        found = node;
        break;
      }
      if (node.type !== 'dir') {
        throw codedError('ENOTDIR', `not a directory: ${absPath}`);
      }
      current = node.children;
    }
    // `segs` is always non-empty here, so the loop assigns `found`.
    return found as NodeSpec;
  };

  return {
    readDirNames(absDir: string): string[] {
      if (absDir === root) {
        if (options.rootReaddirCode !== undefined) {
          throw codedError(options.rootReaddirCode, `readdir root: ${absDir}`);
        }
        return Object.keys(tree);
      }
      const node = resolve(absDir);
      if (node.type !== 'dir') {
        throw codedError('ENOTDIR', `not a directory: ${absDir}`);
      }
      if (node.throwReaddir !== undefined) {
        throw codedError(node.throwReaddir, `readdir failed: ${absDir}`);
      }
      return [...Object.keys(node.children), ...(node.phantoms ?? [])];
    },

    lstat(absPath: string): LstatInfo {
      const node = resolve(absPath);
      const isFile = node.type === 'file';
      return {
        isFile,
        isDirectory: node.type === 'dir',
        isSymbolicLink: node.type === 'symlink',
        sizeBytes: isFile ? (node.size ?? Buffer.byteLength(node.content, 'utf8')) : 0,
        mtimeMs: isFile ? (node.mtimeMs ?? 0) : 0,
      };
    },

    realpath(absPath: string): string {
      if (options.realpathThrow !== undefined) {
        throw codedError(options.realpathThrow, `realpath failed: ${absPath}`);
      }
      resolve(absPath); // throws ENOENT when the node is absent
      return absPath;
    },

    readFileConfined(absPath: string, maxBytes: number): string {
      const node = resolve(absPath);
      // O_NOFOLLOW: the final component is NOT followed — a symlink surfaces as ELOOP.
      if (node.type === 'symlink') {
        throw codedError('ELOOP', `symlink not followed: ${absPath}`);
      }
      if (node.type === 'dir') {
        throw codedError('EISDIR', `is a directory: ${absPath}`);
      }
      if (node.type === 'fifo') {
        throw codedError('ENOTREG', `not a regular file: ${absPath}`);
      }
      if (node.throwCode !== undefined) {
        throw codedError(node.throwCode, `read failed: ${absPath}`);
      }
      const size = node.size ?? Buffer.byteLength(node.content, 'utf8');
      if (size > maxBytes) {
        throw new OversizeError(absPath, size, maxBytes);
      }
      return node.content;
    },
  };
}

/**
 * Write a {@link TreeSpec} to real disk under `rootDir` for the `node-corpus-fs`
 * tests (the only place the production `node:fs` binding is exercised). `dir`,
 * `file` and `symlink` nodes are materialized; `fifo` nodes are ignored (a real
 * FIFO blocks on `O_RDONLY` open, so that arm is covered by the fake instead).
 */
export function materializeTree(rootDir: string, tree: TreeSpec): void {
  mkdirSync(rootDir, { recursive: true });
  for (const [name, node] of Object.entries(tree)) {
    const target = join(rootDir, name);
    if (node.type === 'dir') {
      materializeTree(target, node.children);
    } else if (node.type === 'file') {
      writeFileSync(target, node.content);
    } else if (node.type === 'symlink') {
      symlinkSync(node.target ?? '/nonexistent-target', target);
    }
  }
}
