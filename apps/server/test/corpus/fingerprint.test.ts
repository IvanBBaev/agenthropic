/**
 * WP-IN5 tail-follow fingerprint tests — driven entirely by the in-memory fake
 * fs. What matters is the CONTRACT the watcher leans on: the fingerprint is
 * deterministic, moves iff an ingest-relevant byte-size / mtime moved, ignores
 * entries that can never ingest (symlinks, fifos, over-depth files), survives
 * mid-walk hazards silently, and throws ContainmentError — the one loud
 * signal — on a traversal-shaped name.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintSession } from '../../src/corpus/fingerprint';
import {
  ContainmentError,
  DEFAULT_READ_LIMITS,
  type ReadLimits,
  type SessionRef,
} from '../../src/corpus/fs-port';
import { dir, file, fifo, makeFakeCorpusFs, symlink, type TreeSpec } from './fake-corpus-fs';

const ROOT = '/fake/corpus';
const SLUG = '-Users-ivan-project';
const SESSION = '11111111-2222-4333-8444-555555555555';

const LIMITS: ReadLimits = { ...DEFAULT_READ_LIMITS };

function refFor(sessionId: string): SessionRef {
  const slugAbs = join(ROOT, SLUG);
  return {
    sessionId,
    projectSlug: SLUG,
    mainAbsPath: join(slugAbs, `${sessionId}.jsonl`),
    sessionDirAbs: join(slugAbs, sessionId),
  };
}

/** Fake fs over one slug directory whose contents are `slugChildren`. */
function fsOver(slugChildren: TreeSpec): ReturnType<typeof makeFakeCorpusFs> {
  return makeFakeCorpusFs(ROOT, { [SLUG]: dir(slugChildren) });
}

describe('fingerprintSession', () => {
  it('is deterministic for an unchanged tree', () => {
    const fs = fsOver({
      [`${SESSION}.jsonl`]: file('{"a":1}\n', { mtimeMs: 100 }),
      [SESSION]: dir({
        subagents: dir({ 'agent-1.jsonl': file('{"b":2}\n', { mtimeMs: 200 }) }),
      }),
    });
    const ref = refFor(SESSION);

    expect(fingerprintSession(fs, ref, LIMITS)).toBe(fingerprintSession(fs, ref, LIMITS));
  });

  it('encodes the main transcript as size and mtime, no content read', () => {
    const fs = fsOver({ [`${SESSION}.jsonl`]: file('{"a":1}\n', { size: 42, mtimeMs: 7 }) });

    expect(fingerprintSession(fs, refFor(SESSION), LIMITS)).toBe('main:42:7');
  });

  it('changes when the main file size changes', () => {
    const before = fsOver({ [`${SESSION}.jsonl`]: file('x', { size: 10, mtimeMs: 5 }) });
    const after = fsOver({ [`${SESSION}.jsonl`]: file('x', { size: 11, mtimeMs: 5 }) });

    expect(fingerprintSession(before, refFor(SESSION), LIMITS)).not.toBe(
      fingerprintSession(after, refFor(SESSION), LIMITS),
    );
  });

  it('changes when only the mtime changes (same-size rewrite)', () => {
    const before = fsOver({ [`${SESSION}.jsonl`]: file('x', { size: 10, mtimeMs: 5 }) });
    const after = fsOver({ [`${SESSION}.jsonl`]: file('x', { size: 10, mtimeMs: 6 }) });

    expect(fingerprintSession(before, refFor(SESSION), LIMITS)).not.toBe(
      fingerprintSession(after, refFor(SESSION), LIMITS),
    );
  });

  it('changes when a subagent transcript changes and includes nested paths posix-style', () => {
    const subagents = (mtimeMs: number): TreeSpec => ({
      [`${SESSION}.jsonl`]: file('m', { mtimeMs: 1 }),
      [SESSION]: dir({
        subagents: dir({
          nested: dir({ 'deep.jsonl': file('d', { size: 3, mtimeMs }) }),
          'agent-1.jsonl': file('a', { size: 1, mtimeMs: 10 }),
        }),
      }),
    });
    const ref = refFor(SESSION);
    const before = fingerprintSession(
      makeFakeCorpusFs(ROOT, { [SLUG]: dir(subagents(20)) }),
      ref,
      LIMITS,
    );
    const after = fingerprintSession(
      makeFakeCorpusFs(ROOT, { [SLUG]: dir(subagents(21)) }),
      ref,
      LIMITS,
    );

    expect(before).not.toBe(after);
    expect(before).toContain('subagents/nested/deep.jsonl:3:20');
    expect(before).toContain('subagents/agent-1.jsonl:1:10');
  });

  it('reports an absent main transcript as main:absent (still a valid fingerprint)', () => {
    const fs = fsOver({ [SESSION]: dir({ subagents: dir({}) }) });

    expect(fingerprintSession(fs, refFor(SESSION), LIMITS)).toBe('main:absent');
  });

  it('treats a main path that is a symlink as absent (it would never be ingested)', () => {
    const fs = fsOver({ [`${SESSION}.jsonl`]: symlink('/elsewhere') });

    expect(fingerprintSession(fs, refFor(SESSION), LIMITS)).toBe('main:absent');
  });

  it('ignores symlinks and non-regular entries under subagents', () => {
    const plain = fsOver({
      [`${SESSION}.jsonl`]: file('m', { size: 1, mtimeMs: 1 }),
      [SESSION]: dir({ subagents: dir({ 'agent-1.jsonl': file('a', { size: 2, mtimeMs: 2 }) }) }),
    });
    const hazardous = fsOver({
      [`${SESSION}.jsonl`]: file('m', { size: 1, mtimeMs: 1 }),
      [SESSION]: dir({
        subagents: dir({
          'agent-1.jsonl': file('a', { size: 2, mtimeMs: 2 }),
          'link.jsonl': symlink('/elsewhere'),
          pipe: fifo(),
        }),
      }),
    });

    expect(fingerprintSession(hazardous, refFor(SESSION), LIMITS)).toBe(
      fingerprintSession(plain, refFor(SESSION), LIMITS),
    );
  });

  it('does not walk past maxDepth (an over-deep file cannot perturb the fingerprint)', () => {
    const shallow = fsOver({
      [`${SESSION}.jsonl`]: file('m', { size: 1, mtimeMs: 1 }),
      [SESSION]: dir({
        subagents: dir({ a: dir({ b: dir({ c: dir({ 'deep.jsonl': file('x') }) }) }) }),
      }),
    });

    // maxDepth 4 admits subagents/a/b/c? depth counts directories entered:
    // subagents=1, a=2, b=3, c=4 — files inside c are at depth 4's listing,
    // which IS admitted; one more level is not.
    const deeper = fsOver({
      [`${SESSION}.jsonl`]: file('m', { size: 1, mtimeMs: 1 }),
      [SESSION]: dir({
        subagents: dir({
          a: dir({ b: dir({ c: dir({ d: dir({ 'too-deep.jsonl': file('x') }) }) }) }),
        }),
      }),
    });

    expect(fingerprintSession(shallow, refFor(SESSION), LIMITS)).toContain('deep.jsonl');
    expect(fingerprintSession(deeper, refFor(SESSION), LIMITS)).not.toContain('too-deep');
  });

  it('skips a subagents subtree whose readdir throws, without failing the fingerprint', () => {
    const fs = fsOver({
      [`${SESSION}.jsonl`]: file('m', { size: 1, mtimeMs: 1 }),
      [SESSION]: dir({
        subagents: dir({
          locked: dir({}, { throwReaddir: 'EACCES' }),
          'agent-1.jsonl': file('a', { size: 2, mtimeMs: 2 }),
        }),
      }),
    });

    const fingerprint = fingerprintSession(fs, refFor(SESSION), LIMITS);
    expect(fingerprint).toContain('subagents/agent-1.jsonl:2:2');
  });

  it('skips an entry that vanishes between readdir and lstat (phantom)', () => {
    const fs = fsOver({
      [`${SESSION}.jsonl`]: file('m', { size: 1, mtimeMs: 1 }),
      [SESSION]: dir({
        subagents: dir(
          { 'agent-1.jsonl': file('a', { size: 2, mtimeMs: 2 }) },
          {
            phantoms: ['ghost.jsonl'],
          },
        ),
      }),
    });

    expect(fingerprintSession(fs, refFor(SESSION), LIMITS)).toBe(
      'main:1:1\nsubagents/agent-1.jsonl:2:2',
    );
  });

  it('throws ContainmentError on a traversal-shaped entry name under subagents', () => {
    const fs = fsOver({
      [`${SESSION}.jsonl`]: file('m'),
      [SESSION]: dir({ subagents: dir({ '..': file('evil') }) }),
    });

    expect(() => fingerprintSession(fs, refFor(SESSION), LIMITS)).toThrow(ContainmentError);
  });
});
