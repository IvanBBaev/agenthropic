/**
 * WP-A3 - the tokenRef resolver. `file:` cases run against REAL temp files with
 * real chmod modes, so the permission rule is proven on the actual filesystem
 * rather than on a mocked stat.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  redactSecret,
  resolveTokenRef,
  TokenRefError,
  type TokenRefFs,
} from '../src/alerts/token-ref';

const SECRET = '424242:SECRET-value_from-the-file';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenthropic-token-ref-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function secretFile(name: string, content: string, mode: number): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function rejection(ref: string, deps?: Parameters<typeof resolveTokenRef>[1]): TokenRefError {
  try {
    resolveTokenRef(ref, deps);
  } catch (err) {
    expect(err).toBeInstanceOf(TokenRefError);
    return err as TokenRefError;
  }
  throw new Error(`expected ${ref} to be rejected`);
}

describe('resolveTokenRef - env:', () => {
  it('reads the named variable from the injected env', () => {
    expect(resolveTokenRef('env:TG_TOKEN', { env: { TG_TOKEN: SECRET } })).toBe(SECRET);
  });

  it('defaults to process.env', () => {
    vi.stubEnv('AGENTHROPIC_TEST_TG_TOKEN', SECRET);
    expect(resolveTokenRef('env:AGENTHROPIC_TEST_TG_TOKEN')).toBe(SECRET);
  });

  it('rejects an unset variable, naming the ref', () => {
    const err = rejection('env:MISSING', { env: {} });
    expect(err.name).toBe('TokenRefError');
    expect(err.message).toBe(
      'tokenRef "env:MISSING" rejected: environment variable is unset or empty',
    );
  });

  it('rejects an empty variable', () => {
    expect(rejection('env:EMPTY', { env: { EMPTY: '' } }).message).toMatch(/unset or empty/);
  });

  it('rejects an invalid variable name', () => {
    expect(rejection('env:1BAD', { env: { '1BAD': SECRET } }).message).toMatch(
      /invalid environment variable name/,
    );
    expect(rejection('env:', { env: {} }).message).toMatch(/invalid environment variable name/);
  });
});

describe('resolveTokenRef - file:', () => {
  it('reads a 0600 file owned by the process uid and trims one trailing newline', () => {
    const path = secretFile('ok', `${SECRET}\n`, 0o600);
    expect(resolveTokenRef(`file:${path}`)).toBe(SECRET);
  });

  it('trims a trailing CRLF too, and accepts a file without a newline', () => {
    expect(resolveTokenRef(`file:${secretFile('crlf', `${SECRET}\r\n`, 0o600)}`)).toBe(SECRET);
    expect(resolveTokenRef(`file:${secretFile('bare', SECRET, 0o400)}`)).toBe(SECRET);
  });

  it.each([
    [0o640, '640'],
    [0o644, '644'],
    [0o604, '604'],
    [0o660, '660'],
    [0o601, '601'],
  ])('rejects mode %o (group/other bits) without leaking the content', (mode, octal) => {
    const path = secretFile(`loose-${octal}`, SECRET, mode);
    const err = rejection(`file:${path}`);
    expect(err.message).toBe(
      `tokenRef "file:${path}" rejected: mode ${octal} grants group/other access (use chmod 600)`,
    );
    expect(err.message).not.toContain(SECRET);
  });

  it('rejects a symlink even when its target is a valid 0600 file', () => {
    const target = secretFile('link-target', SECRET, 0o600);
    const link = join(dir, 'link');
    symlinkSync(target, link);
    expect(rejection(`file:${link}`).message).toMatch(/is a symbolic link$/);
  });

  it('rejects a directory', () => {
    const sub = join(dir, 'a-directory');
    mkdirSync(sub, { mode: 0o700 });
    expect(rejection(`file:${sub}`).message).toMatch(/is not a regular file$/);
  });

  it('rejects an empty file and a file holding only a newline', () => {
    expect(rejection(`file:${secretFile('empty', '', 0o600)}`).message).toMatch(/file is empty$/);
    expect(rejection(`file:${secretFile('nl', '\n', 0o600)}`).message).toMatch(/file is empty$/);
  });

  it('rejects a relative path', () => {
    expect(rejection('file:relative/token').message).toBe(
      'tokenRef "file:relative/token" rejected: path is not absolute',
    );
  });

  it('rejects a missing file', () => {
    expect(rejection(`file:${join(dir, 'nope')}`).message).toMatch(/cannot stat the file$/);
  });

  it('rejects a file owned by another uid', () => {
    const path = secretFile('foreign', SECRET, 0o600);
    const err = rejection(`file:${path}`, { uid: process.getuid!() + 1 });
    expect(err.message).toMatch(/is not owned by the server user$/);
    expect(err.message).not.toContain(SECRET);
  });

  it('reports a read failure without the underlying error text', () => {
    const fs: TokenRefFs = {
      lstatSync: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 7,
        mode: 0o100600,
      }),
      readFileSync: () => {
        throw new Error(`EACCES with ${SECRET}`);
      },
    };
    const err = rejection('file:/secret', { fs, uid: 7 });
    expect(err.message).toBe('tokenRef "file:/secret" rejected: cannot read the file');
  });

  it('uses the injected fs for a successful read', () => {
    const fs: TokenRefFs = {
      lstatSync: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 7,
        mode: 0o100400,
      }),
      readFileSync: () => `${SECRET}\n`,
    };
    expect(resolveTokenRef('file:/secret', { fs, uid: 7 })).toBe(SECRET);
  });

  it('refuses a file ref when the platform has no process uid', () => {
    const original = process.getuid;
    Object.defineProperty(process, 'getuid', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      expect(rejection('file:/secret').message).toMatch(/need a POSIX process uid$/);
    } finally {
      Object.defineProperty(process, 'getuid', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe('resolveTokenRef - grammar', () => {
  it.each(['', 'TG_TOKEN', 'vault:x', 'https://evil.example/token'])('rejects %j', (ref) => {
    expect(rejection(ref).message).toMatch(/unsupported scheme/);
  });
});

describe('redactSecret', () => {
  it('replaces every occurrence', () => {
    expect(redactSecret(`a ${SECRET} b ${SECRET}`, SECRET)).toBe('a <redacted> b <redacted>');
  });

  it('is a no-op for an empty secret or a text without it', () => {
    expect(redactSecret('HTTP 500', '')).toBe('HTTP 500');
    expect(redactSecret('HTTP 500', SECRET)).toBe('HTTP 500');
  });
});
