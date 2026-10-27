/**
 * WP-A3 - the `tokenRef` resolver (AD-3, CD-10).
 *
 * A delivery target names its secret by reference, never by value:
 *
 * - `env:NAME`  - read from the process environment (launchd). Unset or empty
 *   is an error, not a silent empty token.
 * - `file:/abs` - read from a file that is an absolute path, a regular file
 *   (a symlink is rejected, it could point anywhere), owned by this process's
 *   uid, and whose mode grants NO group/other bits. Anything looser is
 *   rejected rather than read.
 *
 * Resolution happens at dispatch time (the sink calls this per send) and the
 * value lives only in memory: it is never logged, never stored, never put in
 * an error. A `TokenRefError` message names the ref - a ref is a name, not a
 * secret - and the reason, and by construction never carries the resolved
 * value or file content: no code path below interpolates either.
 *
 * Known limit: the `file:` check is lstat-then-read, so an attacker who can
 * already rename entries in the secret's directory could race a swap between
 * the two calls. Such an attacker already holds the operator's uid; the check
 * exists to catch an operator mistake (a 0644 secret, a symlink), not that.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Thrown for every resolution failure. The message never holds the secret. */
export class TokenRefError extends Error {
  constructor(ref: string, reason: string) {
    super(`tokenRef "${ref}" rejected: ${reason}`);
    this.name = 'TokenRefError';
  }
}

/** The narrow slice of `node:fs` the resolver uses - a test seam. */
export interface TokenRefFs {
  lstatSync(path: string): {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    uid: number;
    mode: number;
  };
  readFileSync(path: string, encoding: 'utf8'): string;
}

export interface TokenRefDeps {
  env?: Record<string, string | undefined>;
  fs?: TokenRefFs;
  /** The uid a `file:` secret must be owned by. Defaults to `process.getuid()`. */
  uid?: number;
}

const nodeFs: TokenRefFs = {
  lstatSync: (path) => lstatSync(path),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
};

const ENV_PREFIX = 'env:';
const FILE_PREFIX = 'file:';

/** Resolve a `tokenRef` to its secret value, or throw `TokenRefError`. */
export function resolveTokenRef(ref: string, deps: TokenRefDeps = {}): string {
  if (ref.startsWith(ENV_PREFIX)) return resolveEnv(ref, deps.env ?? process.env);
  if (ref.startsWith(FILE_PREFIX)) return resolveFile(ref, deps);
  throw new TokenRefError(ref, 'unsupported scheme (expected env: or file:)');
}

function resolveEnv(ref: string, env: Record<string, string | undefined>): string {
  const name = ref.slice(ENV_PREFIX.length);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TokenRefError(ref, 'invalid environment variable name');
  }
  const value = env[name];
  if (value === undefined || value === '') {
    throw new TokenRefError(ref, 'environment variable is unset or empty');
  }
  return value;
}

function resolveFile(ref: string, deps: TokenRefDeps): string {
  const path = ref.slice(FILE_PREFIX.length);
  if (!isAbsolute(path)) throw new TokenRefError(ref, 'path is not absolute');
  const fs = deps.fs ?? nodeFs;
  const uid = deps.uid ?? processUid(ref);

  let stat: ReturnType<TokenRefFs['lstatSync']>;
  try {
    stat = fs.lstatSync(path);
  } catch {
    throw new TokenRefError(ref, 'cannot stat the file');
  }
  if (stat.isSymbolicLink()) throw new TokenRefError(ref, 'is a symbolic link');
  if (!stat.isFile()) throw new TokenRefError(ref, 'is not a regular file');
  if (stat.uid !== uid) throw new TokenRefError(ref, 'is not owned by the server user');
  if ((stat.mode & 0o077) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    throw new TokenRefError(ref, `mode ${mode} grants group/other access (use chmod 600)`);
  }

  let content: string;
  try {
    content = fs.readFileSync(path, 'utf8');
  } catch {
    throw new TokenRefError(ref, 'cannot read the file');
  }
  const value = content.replace(/\r?\n$/, '');
  if (value === '') throw new TokenRefError(ref, 'file is empty');
  return value;
}

function processUid(ref: string): number {
  const getuid = process.getuid;
  if (getuid === undefined) {
    throw new TokenRefError(ref, 'file refs need a POSIX process uid');
  }
  return getuid.call(process);
}

/**
 * Defense in depth: replace every occurrence of `secret` in `text` with
 * `<redacted>`. A no-op for an empty secret (splitting on '' would interleave
 * the marker between every character).
 */
export function redactSecret(text: string, secret: string): string {
  if (secret === '') return text;
  return text.split(secret).join('<redacted>');
}
