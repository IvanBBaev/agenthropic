/**
 * Unit tests for the pure path/naming helpers ({@link ./corpus-paths}), the
 * error/coded-error primitives of the fs-port, and instance identity. No I/O
 * beyond the single injected {@link CorpusFs.realpath}, driven by the in-memory
 * fake.
 */
import { describe, expect, it } from 'vitest';
import {
  assertWithinRoot,
  isSafeEntryName,
  isSessionUuid,
  resolveCorpusRoot,
  splitTranscriptLines,
  toPosix,
} from '../../src/corpus/corpus-paths';
import {
  ContainmentError,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_READ_LIMITS,
  errnoCodeOf,
  OversizeError,
} from '../../src/corpus/fs-port';
import { resolveIdentity } from '../../src/corpus/identity';
import { makeFakeCorpusFs } from './fake-corpus-fs';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('isSessionUuid', () => {
  it('accepts a canonical lowercase 8-4-4-4-12 hex id', () => {
    expect(isSessionUuid(VALID_UUID)).toBe(true);
  });

  it.each([
    ['11111111-2222-4333-8444-55555555555', 'too short'],
    ['11111111-2222-4333-8444-5555555555555', 'too long'],
    ['11111111-2222-4333-8444-55555555555G', 'non-hex char'],
    ['11111111-2222-4333-8444-5555555555AA', 'uppercase hex'],
    ['1111111122224333844455555555555', 'no dashes'],
    ['', 'empty'],
  ])('rejects %s (%s)', (candidate) => {
    expect(isSessionUuid(candidate)).toBe(false);
  });
});

describe('isSafeEntryName', () => {
  it('accepts a plain basename', () => {
    expect(isSafeEntryName('agent-3fa9c2d1.jsonl')).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['.', 'dot'],
    ['..', 'dotdot'],
    ['a/b', 'posix sep'],
    ['a\\b', 'win sep'],
  ])('rejects %s (%s)', (name) => {
    expect(isSafeEntryName(name)).toBe(false);
  });
});

describe('resolveCorpusRoot', () => {
  it('prefers CLAUDE_PROJECTS_DIR when set and canonicalizes it', () => {
    const fs = makeFakeCorpusFs('/custom/corpus', {});
    const root = resolveCorpusRoot({ CLAUDE_PROJECTS_DIR: '/custom/corpus' }, fs, () => '/home/x');
    expect(root).toBe('/custom/corpus');
  });

  it('falls back to <home>/.claude/projects when the env var is unset', () => {
    const fs = makeFakeCorpusFs('/home/fake/.claude/projects', {});
    const root = resolveCorpusRoot({}, fs, () => '/home/fake');
    expect(root).toBe('/home/fake/.claude/projects');
  });

  it('returns null when the root does not exist (ENOENT)', () => {
    const fs = makeFakeCorpusFs('/anything', {}, { realpathThrow: 'ENOENT' });
    expect(resolveCorpusRoot({ CLAUDE_PROJECTS_DIR: '/anything' }, fs, () => '/h')).toBeNull();
  });

  it('rethrows a non-ENOENT realpath error (e.g. EACCES)', () => {
    const fs = makeFakeCorpusFs('/anything', {}, { realpathThrow: 'EACCES' });
    expect(() => resolveCorpusRoot({ CLAUDE_PROJECTS_DIR: '/anything' }, fs)).toThrow(/realpath/);
  });

  it('uses the default os.homedir when no homedir resolver is passed', () => {
    // The default resolver runs; the fake then reports ENOENT, so the result is
    // null regardless of the machine's real home — no real-corpus dependency.
    const fs = makeFakeCorpusFs('/unused', {}, { realpathThrow: 'ENOENT' });
    expect(resolveCorpusRoot({}, fs)).toBeNull();
  });
});

describe('assertWithinRoot', () => {
  const root = '/corpus';

  it('accepts the root itself', () => {
    expect(() => assertWithinRoot(root, '/corpus')).not.toThrow();
  });

  it('accepts a path beneath the root', () => {
    expect(() => assertWithinRoot(root, '/corpus/slug/session.jsonl')).not.toThrow();
  });

  it('throws ContainmentError for a path that escapes the root', () => {
    expect(() => assertWithinRoot(root, '/corpus/../etc/passwd')).toThrow(ContainmentError);
  });

  it('throws for a sibling directory sharing a name prefix (no false containment)', () => {
    // `/corpus-evil` startsWith `/corpus` as a string but not as `/corpus` + sep.
    expect(() => assertWithinRoot(root, '/corpus-evil/x')).toThrow(ContainmentError);
  });
});

describe('splitTranscriptLines', () => {
  it('drops an unterminated final JSONL record (live-append safety)', () => {
    expect(splitTranscriptLines('{"a":1}\n{"b":2', true)).toEqual(['{"a":1}']);
  });

  it('keeps every line when a JSONL file ends in a newline', () => {
    expect(splitTranscriptLines('{"a":1}\n{"b":2}\n', true)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('never trims a non-JSONL sidecar (single-object meta with no trailing newline)', () => {
    expect(splitTranscriptLines('{"toolUseId":"x"}', false)).toEqual(['{"toolUseId":"x"}']);
  });
});

describe('toPosix', () => {
  it('leaves POSIX separators untouched', () => {
    expect(toPosix('subagents/agent-1.jsonl')).toBe('subagents/agent-1.jsonl');
  });
});

describe('fs-port primitives', () => {
  it('errnoCodeOf extracts a string code from a coded Error', () => {
    const err = Object.assign(new Error('boom'), { code: 'ENOENT' });
    expect(errnoCodeOf(err)).toBe('ENOENT');
  });

  it('errnoCodeOf returns undefined for an Error with a non-string code', () => {
    const err = Object.assign(new Error('boom'), { code: 42 });
    expect(errnoCodeOf(err)).toBeUndefined();
  });

  it('errnoCodeOf returns undefined for a non-Error value', () => {
    expect(errnoCodeOf('not-an-error')).toBeUndefined();
  });

  it('OversizeError carries its size and cap', () => {
    const err = new OversizeError('/x/big.jsonl', 1000, 100);
    expect(err.name).toBe('OversizeError');
    expect(err.sizeBytes).toBe(1000);
    expect(err.maxBytes).toBe(100);
    expect(err.message).toContain('1000');
  });

  it('ContainmentError carries the candidate and root', () => {
    const err = new ContainmentError('/outside', '/corpus');
    expect(err.name).toBe('ContainmentError');
    expect(err.candidate).toBe('/outside');
    expect(err.root).toBe('/corpus');
  });

  it('exposes provisional default read limits', () => {
    expect(DEFAULT_READ_LIMITS.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(DEFAULT_READ_LIMITS.maxDepth).toBe(DEFAULT_MAX_DEPTH);
  });
});

describe('resolveIdentity', () => {
  it('overrides the logical instance via DASHBOARD_INSTANCE', () => {
    const id = resolveIdentity({ DASHBOARD_INSTANCE: 'macmini-a' });
    expect(id.instance).toBe('macmini-a');
    expect(typeof id.hostId).toBe('string');
    expect(id.hostId.length).toBeGreaterThan(0);
  });

  it('mirrors instance to the hostname when DASHBOARD_INSTANCE is unset', () => {
    const id = resolveIdentity({});
    expect(id.instance).toBe(id.hostId);
  });
});
