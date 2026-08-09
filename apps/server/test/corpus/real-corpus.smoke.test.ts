/**
 * WP-IN5 "real fs, synthetic corpus" seam test — the ONE place where the
 * production {@link nodeCorpusFs} binding drives the real enumerator and the
 * real artifact walk over a corpus that actually exists on disk. Every other
 * test in `test/corpus/` drives the in-memory fake, so this file is what proves
 * the two agree: the fake's semantics (lstat bits, `O_NOFOLLOW` → `ELOOP`,
 * POSIX relative paths, the JSONL tail-trim) are the semantics of real macOS /
 * Linux I/O, not a convenient fiction.
 *
 * SAFETY: the suite has ZERO dependency on the machine's real
 * `~/.claude/projects`. The corpus is built by US under a throwaway
 * `mkdtemp` root, `CLAUDE_PROJECTS_DIR` is passed via an INJECTED env object
 * (never `process.env`), and the root is removed in `afterEach`. Nothing is
 * written outside the temp dir, so the suite passes identically on a fresh
 * machine with no corpus at all and in CI.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubstrateFile } from '@agenthropic/core';
import { resolveCorpusRoot } from '../../src/corpus/corpus-paths';
import { buildSessionSubstrate, enumerateSessions } from '../../src/corpus/disk-substrate';
import {
  DEFAULT_READ_LIMITS,
  type BuiltSubstrate,
  type CorpusFs,
  type SessionEnumeration,
  type SessionRef,
} from '../../src/corpus/fs-port';
import { nodeCorpusFs } from '../../src/corpus/node-corpus-fs';
import { dir, file, materializeTree, symlink } from './fake-corpus-fs';

/** Slug dir A — a full session: main transcript + the complete artifact set. */
const SLUG_A = '-Users-dev-Development-agenthropic';
/** Slug dir B — a bare main transcript, plus an orphan session dir (no main). */
const SLUG_B = '-Users-dev-Development-kiko';

const SESSION_A = '11111111-2222-4333-8444-555555555555';
const SESSION_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** A `<uuid>/` dir with artifacts but NO `<uuid>.jsonl` — must never enumerate. */
const SESSION_ORPHAN = '99999999-8888-4777-8666-555555555555';

const MAIN_A_CONTENT = '{"m":1}\n{"m":2}\n';
const AGENT_CONTENT = '{"a":1}\n{"b":2}\n';
const META_CONTENT = '{"toolUseId":"toolu_01AbC"}';
const JOURNAL_CONTENT = '{"j":1}\n';
const WORKFLOW_AGENT_CONTENT = '{"w":1}\n';

let tmpDir: string;
let corpusDir: string;
let fs: CorpusFs;

/**
 * Materialize a corpus shaped exactly like the real thing: two project slugs,
 * a session-dir-that-is-not-a-session, a depth-3 workflow agent, and the two
 * decoys the walk must refuse (a non-artifact file and a symlink whose target
 * is a REAL readable file OUTSIDE the corpus root — following it would leak).
 */
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agenthropic-corpus-smoke-'));
  corpusDir = join(tmpDir, 'corpus');
  const linkTargetAbs = join(tmpDir, 'outside', 'link-target.jsonl');

  materializeTree(tmpDir, {
    // Outside the corpus root on purpose: the symlink below points HERE.
    outside: dir({ 'link-target.jsonl': file('{"leaked":true}\n') }),
    corpus: dir({
      [SLUG_A]: dir({
        [`${SESSION_A}.jsonl`]: file(MAIN_A_CONTENT),
        // A `<uuid>/` DIRECTORY beside the `<uuid>.jsonl` FILE. Only the file
        // keys the session; the dir merely holds the artifacts.
        [SESSION_A]: dir({
          subagents: dir({
            'agent-3fa9c2d1.jsonl': file(AGENT_CONTENT),
            'agent-3fa9c2d1.meta.json': file(META_CONTENT),
            'journal.jsonl': file(JOURNAL_CONTENT),
            // Decoy 1: classified 'other' → recorded as 'non-artifact'.
            'notes.txt': file('scratch notes, not a transcript\n'),
            // Decoy 2: named so it WOULD classify as an 'agent' artifact if the
            // walk ever followed it — proves the skip preempts classification.
            'agent-deadbeef.jsonl': symlink(linkTargetAbs),
            workflows: dir({
              wf_001: dir({ 'agent-7b2e5a10.jsonl': file(WORKFLOW_AGENT_CONTENT) }),
            }),
          }),
        }),
      }),
      [SLUG_B]: dir({
        [`${SESSION_B}.jsonl`]: file('{"m":1}\n'),
        // Decoy 3: a `.jsonl` at the slug root whose stem is not a session UUID.
        'not-a-uuid.jsonl': file('{"x":1}\n'),
        // Decoy 4: artifacts with no root transcript — an orphan, not a session.
        [SESSION_ORPHAN]: dir({
          subagents: dir({ 'agent-c0ffee01.jsonl': file('{"o":1}\n') }),
        }),
      }),
    }),
  });

  fs = nodeCorpusFs();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Resolve the synthetic root through the real `realpath` (macOS `/var` → `/private/var`). */
function realRoot(): string {
  const root = resolveCorpusRoot({ CLAUDE_PROJECTS_DIR: corpusDir }, fs);
  expect(root).not.toBeNull();
  return root!;
}

/** Assert the `sessions` arm of an enumeration and return its refs. */
function refsOf(enumeration: SessionEnumeration): readonly SessionRef[] {
  if (enumeration.kind !== 'sessions') {
    expect.unreachable(`expected enumerated sessions, got ${enumeration.kind}`);
  }
  return enumeration.refs;
}

function refFor(refs: readonly SessionRef[], sessionId: string): SessionRef {
  const found = refs.find((ref) => ref.sessionId === sessionId);
  expect(found, `no SessionRef for ${sessionId}`).toBeDefined();
  return found!;
}

function fileAt(built: BuiltSubstrate, relativePath: string): SubstrateFile {
  const found = built.substrate.files.find((f) => f.relativePath === relativePath);
  expect(found, `substrate has no file at ${relativePath}`).toBeDefined();
  return found!;
}

function sortedRelativePaths(built: BuiltSubstrate): string[] {
  return built.substrate.files.map((f) => f.relativePath).sort();
}

describe('resolveCorpusRoot on real disk', () => {
  it('canonicalizes CLAUDE_PROJECTS_DIR to an existing absolute root', () => {
    const root = realRoot();
    expect(root.endsWith('corpus')).toBe(true);
    // Enumeration keys off the CANONICAL root, so every later abs path is
    // symlink-free — on macOS the mkdtemp path itself is behind /var → /private/var.
    expect(refsOf(enumerateSessions(fs, root)).length).toBeGreaterThan(0);
  });

  it('returns null for a root that does not exist (fresh machine, no corpus)', () => {
    expect(resolveCorpusRoot({ CLAUDE_PROJECTS_DIR: join(tmpDir, 'absent') }, fs)).toBeNull();
  });
});

describe('enumerateSessions on real disk', () => {
  it('finds exactly the two `<uuid>.jsonl` main transcripts across both slugs', () => {
    const root = realRoot();
    const refs = refsOf(enumerateSessions(fs, root));

    expect(refs.map((r) => r.sessionId).sort()).toEqual([SESSION_A, SESSION_B].sort());
  });

  it('reports the slug basename verbatim with the main and session-dir abs paths', () => {
    const root = realRoot();
    const refs = refsOf(enumerateSessions(fs, root));

    expect(refFor(refs, SESSION_A)).toEqual({
      sessionId: SESSION_A,
      projectSlug: SLUG_A,
      mainAbsPath: join(root, SLUG_A, `${SESSION_A}.jsonl`),
      sessionDirAbs: join(root, SLUG_A, SESSION_A),
    });
    expect(refFor(refs, SESSION_B)).toEqual({
      sessionId: SESSION_B,
      projectSlug: SLUG_B,
      mainAbsPath: join(root, SLUG_B, `${SESSION_B}.jsonl`),
      // Session B has no `<uuid>/` dir on disk; the ref still names where it would be.
      sessionDirAbs: join(root, SLUG_B, SESSION_B),
    });
  });

  it('never enumerates a `<uuid>/` directory as a session (only the bare `<uuid>.jsonl` file)', () => {
    const root = realRoot();
    const refs = refsOf(enumerateSessions(fs, root));

    // SESSION_ORPHAN exists on disk as a real `<uuid>/` dir holding a real agent
    // transcript, but has no root `<uuid>.jsonl` — the core spec rule says that
    // is not a session, so it must be absent from the enumeration entirely.
    expect(refs.map((r) => r.sessionId)).not.toContain(SESSION_ORPHAN);
    // And SESSION_A is keyed ONCE — by its file, not additionally by its dir.
    expect(refs.filter((r) => r.sessionId === SESSION_A)).toHaveLength(1);
  });

  it('ignores a slug-root `.jsonl` whose stem is not a canonical session uuid', () => {
    const root = realRoot();
    const refs = refsOf(enumerateSessions(fs, root));

    expect(refs.map((r) => r.sessionId)).not.toContain('not-a-uuid');
  });
});

describe('buildSessionSubstrate on real disk', () => {
  function buildA(): BuiltSubstrate {
    const root = realRoot();
    const built = buildSessionSubstrate(
      fs,
      refFor(refsOf(enumerateSessions(fs, root)), SESSION_A),
      DEFAULT_READ_LIMITS,
    );
    if (built.kind !== 'built') {
      expect.unreachable(`expected a built substrate, got ${built.kind}`);
    }
    return built;
  }

  it('feeds the main transcript plus every section-2 artifact, at POSIX relative paths', () => {
    const built = buildA();

    expect(sortedRelativePaths(built)).toEqual(
      [
        `${SESSION_A}.jsonl`,
        'subagents/agent-3fa9c2d1.jsonl',
        'subagents/agent-3fa9c2d1.meta.json',
        'subagents/journal.jsonl',
        // Depth 3 under the session dir — the real walker reaches it, not just the fake.
        'subagents/workflows/wf_001/agent-7b2e5a10.jsonl',
      ].sort(),
    );
    expect(built.projectSlug).toBe(SLUG_A);
  });

  it('tail-trims JSONL through real disk but keeps the unterminated meta sidecar line', () => {
    const built = buildA();

    // A terminated JSONL round-trips to exactly its complete records: the final
    // split segment (here the '' after the last \n) is always popped.
    expect(fileAt(built, 'subagents/agent-3fa9c2d1.jsonl').lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(fileAt(built, `${SESSION_A}.jsonl`).lines).toEqual(['{"m":1}', '{"m":2}']);
    expect(fileAt(built, 'subagents/journal.jsonl').lines).toEqual(['{"j":1}']);
    expect(fileAt(built, 'subagents/workflows/wf_001/agent-7b2e5a10.jsonl').lines).toEqual([
      '{"w":1}',
    ]);
    // The sidecar is a single unterminated object — its sole line must survive.
    expect(fileAt(built, 'subagents/agent-3fa9c2d1.meta.json').lines).toEqual([META_CONTENT]);
  });

  it('refuses a real symlink artifact with reason `symlink` and never reads its target', () => {
    const built = buildA();

    // The link is named `agent-deadbeef.jsonl` and points at a REAL, readable
    // file outside the corpus root. The real lstat/O_NOFOLLOW path must record
    // it as skipped BEFORE classification — proving the security posture holds
    // on real disk, not only against the fake's ELOOP simulation.
    expect(built.skipped).toContainEqual({
      relativePath: 'subagents/agent-deadbeef.jsonl',
      reason: 'symlink',
    });
    expect(sortedRelativePaths(built)).not.toContain('subagents/agent-deadbeef.jsonl');
    expect(JSON.stringify(built.substrate.files)).not.toContain('leaked');
  });

  it('records a non-artifact file as skipped rather than ingesting it', () => {
    const built = buildA();

    expect(built.skipped).toContainEqual({
      relativePath: 'subagents/notes.txt',
      reason: 'non-artifact',
    });
  });

  it('skips nothing else — the two decoys are the complete skip set', () => {
    const built = buildA();

    expect([...built.skipped].map((s) => s.relativePath).sort()).toEqual([
      'subagents/agent-deadbeef.jsonl',
      'subagents/notes.txt',
    ]);
  });

  it('builds a main-only session with no artifacts and no skips', () => {
    const root = realRoot();
    const built = buildSessionSubstrate(
      fs,
      refFor(refsOf(enumerateSessions(fs, root)), SESSION_B),
      DEFAULT_READ_LIMITS,
    );

    if (built.kind !== 'built') {
      expect.unreachable(`expected a built substrate, got ${built.kind}`);
    }
    expect(sortedRelativePaths(built)).toEqual([`${SESSION_B}.jsonl`]);
    expect(built.skipped).toEqual([]);
    expect(built.projectSlug).toBe(SLUG_B);
  });
});
