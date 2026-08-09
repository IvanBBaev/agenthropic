/**
 * Unit tests for the WP-IN5 disk → substrate adapter ({@link ./disk-substrate}),
 * driven end-to-end by the in-memory {@link CorpusFs} fake — no real corpus, no
 * `node:fs`. The two axes under test:
 *
 *  - {@link enumerateSessions}: a session is keyed ONLY on a project-root
 *    `<uuid>.jsonl` regular file; every per-entry hazard is a silent skip and the
 *    walk continues, while a traversal-shaped name is a hard {@link ContainmentError}.
 *  - {@link buildSessionSubstrate}: the four parser-spec section-2 artifact types
 *    survive, every other hazard lands in `skipped` with an exact {@link SkipReason},
 *    and the build reports `no-substrate` - never losing those reasons - when
 *    neither a main nor an agent transcript was produced.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSessionSubstrate, enumerateSessions } from '../../src/corpus/disk-substrate';
import { ContainmentError, DEFAULT_READ_LIMITS } from '../../src/corpus/fs-port';
import type {
  BuiltSubstrate,
  CorpusFs,
  LstatInfo,
  NoSubstrate,
  ReadLimits,
  SessionEnumeration,
  SessionRef,
  SkippedFile,
  SubstrateBuild,
} from '../../src/corpus/fs-port';
import { dir, fifo, file, makeFakeCorpusFs, symlink } from './fake-corpus-fs';
import type { NodeSpec, TreeSpec } from './fake-corpus-fs';

const ROOT = '/corpus';
const SLUG = '-Users-ivanbaev-Development-agenthropic';
const OTHER_SLUG = '-Users-ivanbaev-Development-kiko';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MAIN = `${SESSION_ID}.jsonl`;

/** A `SessionRef` shaped exactly as `enumerateSessions` would emit it. */
function refFor(sessionId: string = SESSION_ID, slug: string = SLUG): SessionRef {
  return {
    sessionId,
    projectSlug: slug,
    mainAbsPath: join(ROOT, slug, `${sessionId}.jsonl`),
    sessionDirAbs: join(ROOT, slug, sessionId),
  };
}

function fakeFs(tree: TreeSpec, options: { rootReaddirCode?: string } = {}): CorpusFs {
  return makeFakeCorpusFs(ROOT, tree, options);
}

/** The substrate of a session whose slug dir holds `main` plus the given session-dir tree. */
function treeWith(sessionDir: TreeSpec, main: NodeSpec = file('{"a":1}\n')): TreeSpec {
  return {
    [SLUG]: dir({
      [MAIN]: main,
      [SESSION_ID]: dir(sessionDir),
    }),
  };
}

function skipFor(skipped: readonly SkippedFile[], relativePath: string): SkippedFile | undefined {
  return skipped.find((entry) => entry.relativePath === relativePath);
}

function relPaths(files: readonly { relativePath: string }[]): string[] {
  return files.map((f) => f.relativePath);
}

/**
 * Assert the `built` arm and narrow to it.
 *
 * Replaces a bare `built!.substrate`. The `!` only silenced a nullable type; it
 * asserted nothing, so a fixture that quietly stopped producing a substrate
 * failed on a property access instead of on the claim the test exists to make.
 */
function builtOf(build: SubstrateBuild): BuiltSubstrate {
  if (build.kind !== 'built') {
    expect.unreachable(`expected a built substrate, got ${build.kind}`);
  }
  return build;
}

/** Assert the `no-substrate` arm and narrow to it (so `skipped` is assertable). */
function noSubstrateOf(build: SubstrateBuild): NoSubstrate {
  if (build.kind !== 'no-substrate') {
    expect.unreachable(`expected no substrate, got ${build.kind}`);
  }
  return build;
}

/** Assert the `sessions` arm of an enumeration and return its refs. */
function refsOf(enumeration: SessionEnumeration): readonly SessionRef[] {
  if (enumeration.kind !== 'sessions') {
    expect.unreachable(`expected enumerated sessions, got ${enumeration.kind}`);
  }
  return enumeration.refs;
}

describe('enumerateSessions', () => {
  it('discovers a <uuid>.jsonl main transcript in a project slug dir', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: file('{"a":1}\n') }) });

    expect(enumerateSessions(fs, ROOT)).toEqual({
      kind: 'sessions',
      refs: [
        {
          sessionId: SESSION_ID,
          projectSlug: SLUG,
          mainAbsPath: join(ROOT, SLUG, MAIN),
          sessionDirAbs: join(ROOT, SLUG, SESSION_ID),
        },
      ],
    });
  });

  it('derives projectSlug from the slug directory basename verbatim', () => {
    const weird = '-Users-x-My.Project_v2';
    const fs = fakeFs({ [weird]: dir({ [MAIN]: file('{}\n') }) });

    expect(refsOf(enumerateSessions(fs, ROOT))[0]!.projectSlug).toBe(weird);
  });

  // The two root-failure arms are DIFFERENT facts and must never collapse: a
  // root that vanished (ENOENT) genuinely holds no sessions, while a root that
  // exists but cannot be read proves nothing about what it holds. Both used to
  // return the same `[]`, indistinguishable from a real empty corpus.
  it('reports unreadable-root with the errno code when the root readdir fails', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: file('{}\n') }) }, { rootReaddirCode: 'EACCES' });

    expect(enumerateSessions(fs, ROOT)).toEqual({ kind: 'unreadable-root', code: 'EACCES' });
  });

  it('reports unreadable-root without a code when the failure carries no errno', () => {
    const base = fakeFs({ [SLUG]: dir({ [MAIN]: file('{}\n') }) });
    const hostile: CorpusFs = {
      ...base,
      readDirNames(absDir: string): string[] {
        if (absDir === ROOT) throw new Error('boom without a code');
        return base.readDirNames(absDir);
      },
    };

    expect(enumerateSessions(hostile, ROOT)).toEqual({ kind: 'unreadable-root', code: undefined });
  });

  it('treats a root that vanished (ENOENT) as genuinely holding no sessions', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: file('{}\n') }) }, { rootReaddirCode: 'ENOENT' });

    expect(enumerateSessions(fs, ROOT)).toEqual({ kind: 'sessions', refs: [] });
  });

  it('returns no sessions for an empty corpus root', () => {
    expect(refsOf(enumerateSessions(fakeFs({}), ROOT))).toEqual([]);
  });

  it('throws ContainmentError for a traversal-shaped slug name (a hard stop, not a skip)', () => {
    const fs = fakeFs({ '..': dir({}) });

    expect(() => enumerateSessions(fs, ROOT)).toThrow(ContainmentError);
  });

  it('skips a slug entry that is a stray file rather than a directory', () => {
    const fs = fakeFs({ '.DS_Store': file('junk') });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it('skips a slug entry that is a symlink', () => {
    const fs = fakeFs({ [SLUG]: symlink('/elsewhere') });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it('never follows a symlinked slug directory even when it lstats as a directory', () => {
    // A hostile fs reporting BOTH bits: isRealDir must still reject it, because
    // following it would walk straight out of the corpus root.
    const base = fakeFs({ [SLUG]: dir({ [MAIN]: file('{}\n') }) });
    const slugDirAbs = join(ROOT, SLUG);
    const hostile: CorpusFs = {
      ...base,
      lstat(absPath: string): LstatInfo {
        if (absPath === slugDirAbs) {
          return {
            isFile: false,
            isDirectory: true,
            isSymbolicLink: true,
            sizeBytes: 0,
            mtimeMs: 0,
          };
        }
        return base.lstat(absPath);
      },
    };

    expect(refsOf(enumerateSessions(hostile, ROOT))).toEqual([]);
  });

  it('skips a slug whose readdir throws but keeps walking the remaining slugs', () => {
    const fs = fakeFs({
      [OTHER_SLUG]: dir({}, { throwReaddir: 'EACCES' }),
      [SLUG]: dir({ [MAIN]: file('{}\n') }),
    });

    expect(refsOf(enumerateSessions(fs, ROOT)).map((r) => r.projectSlug)).toEqual([SLUG]);
  });

  it('ignores slug entries that are not *.jsonl files', () => {
    const fs = fakeFs({
      [SLUG]: dir({ 'notes.txt': file('x'), 'config.json': file('{}'), '.DS_Store': file('') }),
    });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it.each([
    ['not-a-uuid.jsonl', 'non-uuid stem'],
    ['AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE.jsonl', 'uppercase hex is rejected'],
    ['11111111-2222-4333-8444-55555555555.jsonl', 'too short'],
    ['111111112222433384445555555555555.jsonl', 'no dashes'],
    ['.jsonl', 'empty stem'],
  ])('ignores %s (%s)', (entry) => {
    const fs = fakeFs({ [SLUG]: dir({ [entry]: file('{}\n') }) });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it('never enumerates the <uuid>/ session directory itself as a session', () => {
    // The core spec rule: an orphan workflow dir with no root transcript is NOT
    // a session, however complete its artifacts look.
    const fs = fakeFs({
      [SLUG]: dir({
        [SESSION_ID]: dir({ subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n') }) }),
      }),
    });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it('yields exactly one session when both <uuid>.jsonl and <uuid>/ are present', () => {
    const fs = fakeFs(treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n') }) }));

    const refs = refsOf(enumerateSessions(fs, ROOT));
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sessionId).toBe(SESSION_ID);
  });

  it('skips a <uuid>.jsonl that is a symlink', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: symlink('/etc/passwd') }) });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it('skips a <uuid>.jsonl that is not a regular file', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: fifo() }) });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it('skips a <uuid>.jsonl that is actually a directory', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: dir({}) }) });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it('skips a <uuid>.jsonl that vanishes between readdir and lstat (TOCTOU)', () => {
    const fs = fakeFs({ [SLUG]: dir({}, { phantoms: [MAIN] }) });

    expect(refsOf(enumerateSessions(fs, ROOT))).toEqual([]);
  });

  it('discovers every session across multiple slugs', () => {
    const fs = fakeFs({
      [SLUG]: dir({ [MAIN]: file('{}\n'), [`${OTHER_SESSION_ID}.jsonl`]: file('{}\n') }),
      [OTHER_SLUG]: dir({ [MAIN]: file('{}\n') }),
    });

    expect(
      refsOf(enumerateSessions(fs, ROOT))
        .map((r) => `${r.projectSlug}/${r.sessionId}`)
        .sort(),
    ).toEqual(
      [
        `${SLUG}/${SESSION_ID}`,
        `${SLUG}/${OTHER_SESSION_ID}`,
        `${OTHER_SLUG}/${SESSION_ID}`,
      ].sort(),
    );
  });
});

describe('buildSessionSubstrate — main transcript', () => {
  it('builds a main-only session with a bare, slash-free relative path', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: file('{"a":1}\n{"b":2}\n') }) });

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(built.projectSlug).toBe(SLUG);
    expect(built.skipped).toEqual([]);
    expect(built.substrate.files).toEqual([{ relativePath: MAIN, lines: ['{"a":1}', '{"b":2}'] }]);
    expect(built.substrate.files[0]!.relativePath).not.toContain('/');
  });

  it('returns the projectSlug from the ref verbatim', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: file('{}\n') }) });
    const ref = { ...refFor(), projectSlug: 'literally-anything' };

    expect(builtOf(buildSessionSubstrate(fs, ref, DEFAULT_READ_LIMITS)).projectSlug).toBe(
      'literally-anything',
    );
  });

  it('records an unreadable main in skipped with its reason and fs code', () => {
    const fs = fakeFs(
      treeWith(
        { subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n') }) },
        file('', { throwCode: 'EACCES' }),
      ),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, MAIN)).toEqual({
      relativePath: MAIN,
      reason: 'unreadable',
      code: 'EACCES',
    });
    // The main is absent from files, but the agent transcript still made it.
    expect(relPaths(built.substrate.files)).toEqual(['subagents/agent-aaaa1111.jsonl']);
  });

  it('records an oversize main as oversize with no fs code', () => {
    const limits: ReadLimits = { maxFileBytes: 100, maxDepth: 4 };
    const fs = fakeFs(
      treeWith(
        { subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n') }) },
        file('{"a":1}\n', { size: 5000 }),
      ),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), limits));

    const skip = skipFor(built.skipped, MAIN);
    expect(skip?.reason).toBe('oversize');
    expect(skip?.code).toBeUndefined();
  });

  it('records a symlinked main as symlink (O_NOFOLLOW surfaces ELOOP)', () => {
    const fs = fakeFs(
      treeWith(
        { subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n') }) },
        symlink('/etc/passwd'),
      ),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, MAIN)).toEqual({
      relativePath: MAIN,
      reason: 'symlink',
      code: 'ELOOP',
    });
  });

  it('drops an unterminated final record of a live-appended main', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: file('{"a":1}\n{"b":2') }) });

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(built.substrate.files[0]!.lines).toEqual(['{"a":1}']);
  });
});

/**
 * The total-loss path. Each of these used to return a bare `null`, which threw
 * away the `skipped` list the builder had just finished computing — so the
 * operator was told LESS about a session that died completely than about one
 * that merely lost a file. Every test here therefore asserts the verdict AND
 * the surviving reason; the reason is the point.
 */
describe('buildSessionSubstrate — no substrate', () => {
  it('keeps the EACCES reason when the main is unreadable and no agent file exists', () => {
    const fs = fakeFs({ [SLUG]: dir({ [MAIN]: file('', { throwCode: 'EACCES' }) }) });

    const build = noSubstrateOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(build.projectSlug).toBe(SLUG);
    expect(build.skipped).toEqual([{ relativePath: MAIN, reason: 'unreadable', code: 'EACCES' }]);
  });

  it('keeps the ENOENT reason when the main is missing entirely', () => {
    const fs = fakeFs({ [SLUG]: dir({}) });

    const build = noSubstrateOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(build.skipped).toEqual([{ relativePath: MAIN, reason: 'unreadable', code: 'ENOENT' }]);
  });

  it('keeps the reason for a meta/journal-only remnant with no main and no agent', () => {
    const fs = fakeFs(
      treeWith(
        {
          subagents: dir({
            'journal.jsonl': file('{"j":1}\n'),
            'agent-aaaa1111.meta.json': file('{"toolUseId":"t1"}'),
          }),
        },
        file('', { throwCode: 'EACCES' }),
      ),
    );

    const build = noSubstrateOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    // The meta + journal WERE read, but neither is a transcript, so the session
    // still yields nothing analysable. What survives is why the main was lost.
    expect(build.skipped).toEqual([{ relativePath: MAIN, reason: 'unreadable', code: 'EACCES' }]);
  });

  it('still builds a session that has no main but does have an agent transcript', () => {
    const fs = fakeFs(
      treeWith(
        { subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n') }) },
        file('', { throwCode: 'ENOENT' }),
      ),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(relPaths(built.substrate.files)).toEqual(['subagents/agent-aaaa1111.jsonl']);
  });
});

describe('buildSessionSubstrate — artifact walk', () => {
  it('keeps the three nested parser-spec artifact kinds and skips everything else', () => {
    const fs = fakeFs(
      treeWith({
        subagents: dir({
          'agent-aaaa1111.jsonl': file('{"a":1}\n'),
          'agent-aaaa1111.meta.json': file('{"toolUseId":"t1"}'),
          'journal.jsonl': file('{"j":1}\n'),
          'notes.txt': file('scratch'),
        }),
      }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(relPaths(built.substrate.files).sort()).toEqual(
      [
        MAIN,
        'subagents/agent-aaaa1111.jsonl',
        'subagents/agent-aaaa1111.meta.json',
        'subagents/journal.jsonl',
      ].sort(),
    );
    expect(skipFor(built.skipped, 'subagents/notes.txt')).toEqual({
      relativePath: 'subagents/notes.txt',
      reason: 'non-artifact',
    });
  });

  it('never walks the session dir root — only subagents/', () => {
    const fs = fakeFs(
      treeWith({
        'stray-agent-aaaa1111.jsonl': file('{"a":1}\n'),
        'journal.jsonl': file('{"j":1}\n'),
      }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(relPaths(built.substrate.files)).toEqual([MAIN]);
    expect(built.skipped).toEqual([]);
  });

  it('finds an agent transcript nested under subagents/workflows/wf_<id>/', () => {
    const fs = fakeFs(
      treeWith({
        subagents: dir({
          workflows: dir({ wf_42: dir({ 'agent-bbbb2222.jsonl': file('{"a":1}\n') }) }),
        }),
      }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(relPaths(built.substrate.files)).toContain(
      'subagents/workflows/wf_42/agent-bbbb2222.jsonl',
    );
    // Traversed directories are recursed, never recorded as skipped files.
    expect(built.skipped).toEqual([]);
  });

  it('emits POSIX-separated paths relative to the session dir', () => {
    const fs = fakeFs(
      treeWith({
        subagents: dir({
          workflows: dir({ wf_42: dir({ 'agent-bbbb2222.jsonl': file('{"a":1}\n') }) }),
        }),
      }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    for (const f of built.substrate.files) {
      expect(f.relativePath).not.toContain('\\');
      expect(f.relativePath.startsWith('/')).toBe(false);
      expect(f.relativePath).not.toContain(SESSION_ID + '/');
    }
  });

  it('does not visit files deeper than limits.maxDepth', () => {
    const limits: ReadLimits = { maxFileBytes: 1024, maxDepth: 1 };
    const fs = fakeFs(
      treeWith({
        subagents: dir({
          'agent-aaaa1111.jsonl': file('{"a":1}\n'),
          workflows: dir({ wf_42: dir({ 'agent-bbbb2222.jsonl': file('{"a":1}\n') }) }),
        }),
      }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), limits));

    // Depth 1 (directly under subagents/) survives; the deeper one is never
    // visited — not ingested and not even recorded as skipped.
    expect(relPaths(built.substrate.files).sort()).toEqual(
      [MAIN, 'subagents/agent-aaaa1111.jsonl'].sort(),
    );
    expect(built.skipped).toEqual([]);
  });

  it('does not walk when subagents is a file rather than a directory', () => {
    const fs = fakeFs(treeWith({ subagents: file('not a directory') }));

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(relPaths(built.substrate.files)).toEqual([MAIN]);
    expect(built.skipped).toEqual([]);
  });

  it('does not walk when subagents is a symlink', () => {
    const fs = fakeFs(treeWith({ subagents: symlink('/elsewhere') }));

    expect(
      relPaths(builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS)).substrate.files),
    ) //
      .toEqual([MAIN]);
  });

  it('survives a subagents dir whose readdir throws mid-walk', () => {
    const fs = fakeFs(treeWith({ subagents: dir({}, { throwReaddir: 'EACCES' }) }));

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(relPaths(built.substrate.files)).toEqual([MAIN]);
    expect(built.skipped).toEqual([]);
  });

  it('throws ContainmentError for a traversal-shaped entry name inside the walk', () => {
    const fs = fakeFs(treeWith({ subagents: dir({ '..': file('x') }) }));

    expect(() => buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS)).toThrow(
      ContainmentError,
    );
  });

  it('silently skips an entry that vanishes between readdir and lstat', () => {
    const fs = fakeFs(treeWith({ subagents: dir({}, { phantoms: ['agent-aaaa1111.jsonl'] }) }));

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(relPaths(built.substrate.files)).toEqual([MAIN]);
    expect(built.skipped).toEqual([]);
  });
});

describe('buildSessionSubstrate — skip reasons in the walk', () => {
  it('records a symlinked artifact as symlink without following it', () => {
    const fs = fakeFs(
      treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': symlink('/etc/passwd') }) }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, 'subagents/agent-aaaa1111.jsonl')).toEqual({
      relativePath: 'subagents/agent-aaaa1111.jsonl',
      reason: 'symlink',
    });
  });

  it('records a non-regular artifact (fifo) as not-regular-file', () => {
    const fs = fakeFs(treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': fifo() }) }));

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, 'subagents/agent-aaaa1111.jsonl')).toEqual({
      relativePath: 'subagents/agent-aaaa1111.jsonl',
      reason: 'not-regular-file',
    });
  });

  it('records an oversize artifact as oversize', () => {
    const limits: ReadLimits = { maxFileBytes: 16, maxDepth: 4 };
    const fs = fakeFs(
      treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n', { size: 999 }) }) }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), limits));

    const skip = skipFor(built.skipped, 'subagents/agent-aaaa1111.jsonl');
    expect(skip?.reason).toBe('oversize');
    expect(skip?.code).toBeUndefined();
  });

  it('records an arbitrary read errno as unreadable and surfaces the code', () => {
    const fs = fakeFs(
      treeWith({
        subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n', { throwCode: 'EACCES' }) }),
      }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, 'subagents/agent-aaaa1111.jsonl')).toEqual({
      relativePath: 'subagents/agent-aaaa1111.jsonl',
      reason: 'unreadable',
      code: 'EACCES',
    });
  });

  it('records an ELOOP read (symlink swapped in after lstat) as symlink', () => {
    const fs = fakeFs(
      treeWith({
        subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n', { throwCode: 'ELOOP' }) }),
      }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, 'subagents/agent-aaaa1111.jsonl')).toEqual({
      relativePath: 'subagents/agent-aaaa1111.jsonl',
      reason: 'symlink',
      code: 'ELOOP',
    });
  });

  it.each([
    ['', 'zero bytes'],
    ['\n', 'a lone newline'],
    ['  \n\t\n', 'only whitespace'],
  ])('records an agent transcript of %j as empty-agent (%s)', (content) => {
    const fs = fakeFs(treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': file(content) }) }));

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, 'subagents/agent-aaaa1111.jsonl')).toEqual({
      relativePath: 'subagents/agent-aaaa1111.jsonl',
      reason: 'empty-agent',
    });
    expect(relPaths(built.substrate.files)).toEqual([MAIN]);
  });

  it('does not apply the empty-agent rule to an empty journal or meta sidecar', () => {
    const fs = fakeFs(
      treeWith({
        subagents: dir({ 'journal.jsonl': file(''), 'agent-aaaa1111.meta.json': file('') }),
      }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(built.skipped).toEqual([]);
    expect(relPaths(built.substrate.files).sort()).toEqual(
      [MAIN, 'subagents/journal.jsonl', 'subagents/agent-aaaa1111.meta.json'].sort(),
    );
  });

  // Regression: the empty-agent guard must run on the SPLIT lines, not the raw
  // content. A live append caught mid-first-record is non-blank as text but
  // yields zero complete records, which would make parseSession throw for the
  // whole session — the exact outcome the guard exists to prevent.
  it('records a single unterminated agent record (a live append) as empty-agent', () => {
    const fs = fakeFs(treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}') }) }));

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, 'subagents/agent-aaaa1111.jsonl')).toEqual({
      relativePath: 'subagents/agent-aaaa1111.jsonl',
      reason: 'empty-agent',
    });
    expect(relPaths(built.substrate.files)).toEqual([MAIN]);
  });

  it.each([
    ['', 'zero bytes'],
    ['\n', 'a lone newline'],
    ['  \n\t\n', 'only whitespace'],
    ['{"a":1}', 'a single unterminated record (a live append)'],
  ])('records a main transcript of %j as empty-main (%s)', (content) => {
    const fs = fakeFs(
      treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n') }) }, file(content)),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, MAIN)).toEqual({ relativePath: MAIN, reason: 'empty-main' });
    // The main is dropped, but the live subagent still ingests.
    expect(relPaths(built.substrate.files)).toEqual(['subagents/agent-aaaa1111.jsonl']);
  });

  it('reports no-substrate — still naming empty-main — when no agent transcript survives', () => {
    const fs = fakeFs(treeWith({}, file('')));

    const build = noSubstrateOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    // Same reason the sibling test above sees on the surviving path. It used to
    // be reported there and swallowed here.
    expect(build.skipped).toEqual([{ relativePath: MAIN, reason: 'empty-main' }]);
  });

  it.each([
    ['notes.txt', 'a stray text file'],
    ['.DS_Store', 'a finder turd'],
    ['agent-aaaa1111.json', 'an agent-ish name with the wrong extension'],
    ['agent-XYZ.jsonl', 'a non-hex agent id'],
    ['journal.txt', 'a journal with the wrong extension'],
    [`${SESSION_ID}.jsonl`, 'a nested uuid transcript (never a main)'],
  ])('records %s as non-artifact (%s)', (name) => {
    const fs = fakeFs(treeWith({ subagents: dir({ [name]: file('whatever\n') }) }));

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(skipFor(built.skipped, `subagents/${name}`)).toEqual({
      relativePath: `subagents/${name}`,
      reason: 'non-artifact',
    });
  });
});

describe('buildSessionSubstrate — line splitting through the adapter', () => {
  it('drops the terminating empty segment of a complete agent transcript', () => {
    const fs = fakeFs(
      treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n{"b":2}\n') }) }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(
      built.substrate.files.find((f) => f.relativePath === 'subagents/agent-aaaa1111.jsonl')!.lines,
    ).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('drops a half-written final record of a live-appended agent transcript', () => {
    const fs = fakeFs(
      treeWith({ subagents: dir({ 'agent-aaaa1111.jsonl': file('{"a":1}\n{"b":2') }) }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(
      built.substrate.files.find((f) => f.relativePath === 'subagents/agent-aaaa1111.jsonl')!.lines,
    ).toEqual(['{"a":1}']);
  });

  it('keeps the sole unterminated line of a .meta.json sidecar (not JSONL)', () => {
    const fs = fakeFs(
      treeWith({ subagents: dir({ 'agent-aaaa1111.meta.json': file('{"toolUseId":"t1"}') }) }),
    );

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(
      built.substrate.files.find((f) => f.relativePath === 'subagents/agent-aaaa1111.meta.json')!
        .lines,
    ).toEqual(['{"toolUseId":"t1"}']);
  });

  it('tail-trims a journal like the JSONL it is', () => {
    const fs = fakeFs(treeWith({ subagents: dir({ 'journal.jsonl': file('{"j":1}\n{"j":2') }) }));

    const built = builtOf(buildSessionSubstrate(fs, refFor(), DEFAULT_READ_LIMITS));

    expect(
      built.substrate.files.find((f) => f.relativePath === 'subagents/journal.jsonl')!.lines,
    ).toEqual(['{"j":1}']);
  });
});

describe('enumerateSessions + buildSessionSubstrate', () => {
  it('builds every enumerated session end to end', () => {
    const fs = fakeFs({
      [SLUG]: dir({
        [MAIN]: file('{"a":1}\n'),
        [SESSION_ID]: dir({
          subagents: dir({
            'agent-aaaa1111.jsonl': file('{"a":1}\n'),
            'agent-aaaa1111.meta.json': file('{"toolUseId":"t1"}'),
          }),
        }),
      }),
      [OTHER_SLUG]: dir({ [`${OTHER_SESSION_ID}.jsonl`]: file('{"b":1}\n') }),
    });

    const built = refsOf(enumerateSessions(fs, ROOT)).map((ref) =>
      builtOf(buildSessionSubstrate(fs, ref, DEFAULT_READ_LIMITS)),
    );

    expect(built.map((b) => b.projectSlug).sort()).toEqual([OTHER_SLUG, SLUG].sort());
    expect(built.flatMap((b) => relPaths(b.substrate.files)).sort()).toEqual(
      [
        MAIN,
        'subagents/agent-aaaa1111.jsonl',
        'subagents/agent-aaaa1111.meta.json',
        `${OTHER_SESSION_ID}.jsonl`,
      ].sort(),
    );
  });
});
