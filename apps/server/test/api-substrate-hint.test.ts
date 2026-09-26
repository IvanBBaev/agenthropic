/**
 * M-18 - the substrate provider's DB slug hint (`slugOf`), tested directly
 * against the in-memory {@link CorpusFs} fake so every claim is about fs
 * OPERATIONS, not timing:
 *
 * - the hit path never enumerates: the fake's ROOT readdir is rigged to throw,
 *   so any enumeration attempt would surface as `unreadable-root` - a resolved
 *   lookup is therefore PROOF the corpus sweep was skipped;
 * - a stale or hostile hint silently falls back to enumeration, which stays
 *   the correctness anchor - the hint can cost speed, never answers;
 * - containment holds against a hostile DB value: a traversal-shaped slug is
 *   dropped BEFORE any path is built, verified by recording every path the
 *   provider hands to the fs port.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFixture } from '@agenthropic/test-fixtures';
import { createSubstrateProvider, type SubstrateProvider } from '../src/api/substrate-provider';
import { start } from '../src/index';
import { TEST_TOKEN } from './helpers';
import type { CorpusFs } from '../src/corpus/index';
import {
  dir,
  file,
  makeFakeCorpusFs,
  symlink,
  type FakeFsOptions,
  type TreeSpec,
} from './corpus/fake-corpus-fs';

const ROOT = '/fake/projects';
const SLUG = '-Users-synthetic-hint-project';
/** The `task-notification-recovery` fixture's session id. */
const SESSION_ID = '33333333-4444-4555-8666-777777777777';
const AGENT_HEX = 'c0ffee42';

/** The fixture corpus as an in-memory tree: bare `<uuid>.jsonl` main + `<uuid>/subagents/**`. */
function fixtureSlugDir(): TreeSpec {
  const fixture = getFixture('task-notification-recovery');
  const contents = new Map(fixture.files.map((f) => [f.relativePath, f.lines.join('\n') + '\n']));
  const main = contents.get(`${SESSION_ID}.jsonl`);
  const agent = contents.get(`subagents/agent-${AGENT_HEX}.jsonl`);
  if (main === undefined || agent === undefined) {
    throw new Error('fixture layout changed; update this test');
  }
  return {
    [`${SESSION_ID}.jsonl`]: file(main),
    [SESSION_ID]: dir({
      subagents: dir({ [`agent-${AGENT_HEX}.jsonl`]: file(agent) }),
    }),
  };
}

function providerOver(
  tree: TreeSpec,
  slugOf: ((sessionId: string) => string | null) | undefined,
  fsOptions: FakeFsOptions = {},
): SubstrateProvider {
  // Explicit env only - the provider must never see the real ~/.claude.
  const fs = makeFakeCorpusFs(ROOT, tree, fsOptions);
  return createSubstrateProvider({
    env: { CLAUDE_PROJECTS_DIR: ROOT },
    fs,
    ...(slugOf === undefined ? {} : { slugOf }),
  });
}

/** Wrap a {@link CorpusFs} so every directory LISTING is recorded (probes and reads are not). */
function readdirLoggingFs(inner: CorpusFs, listed: string[]): CorpusFs {
  return {
    ...inner,
    readDirNames(absDir) {
      listed.push(absDir);
      return inner.readDirNames(absDir);
    },
  };
}

/** Wrap a {@link CorpusFs} so every path handed to the port is recorded. */
function recordingFs(inner: CorpusFs, paths: string[]): CorpusFs {
  return {
    readDirNames(absDir) {
      paths.push(absDir);
      return inner.readDirNames(absDir);
    },
    lstat(absPath) {
      paths.push(absPath);
      return inner.lstat(absPath);
    },
    realpath(absPath) {
      paths.push(absPath);
      return inner.realpath(absPath);
    },
    readFileConfined(absPath, maxBytes) {
      paths.push(absPath);
      return inner.readFileConfined(absPath, maxBytes);
    },
    readFileTailConfined(absPath, fromByte, maxBytes) {
      paths.push(absPath);
      return inner.readFileTailConfined(absPath, fromByte, maxBytes);
    },
  };
}

describe('substrate provider slug hint (M-18)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves via the hint without enumerating the corpus', () => {
    // The rigged root readdir makes enumeration IMPOSSIBLE (it would yield
    // 'unreadable-root'), so a resolved lookup proves the hit path alone
    // found the session.
    const asked: string[] = [];
    const provider = providerOver(
      { [SLUG]: dir(fixtureSlugDir()) },
      (id) => {
        asked.push(id);
        return SLUG;
      },
      { rootReaddirCode: 'EACCES' },
    );
    const lookup = provider.loadSession(SESSION_ID);
    expect(lookup.kind).toBe('resolved');
    if (lookup.kind !== 'resolved') {
      throw new Error('unreachable');
    }
    expect(lookup.substrate.session.sessionId).toBe(SESSION_ID);
    expect(lookup.substrate.boundaries).toHaveLength(1);
    expect(asked).toEqual([SESSION_ID]);
  });

  it('the same corpus without a hint would have required enumeration', () => {
    // The proof pair for the test above: identical tree and fs rigging, no
    // slugOf - the provider must enumerate and hit the rigged root readdir.
    const provider = providerOver({ [SLUG]: dir(fixtureSlugDir()) }, undefined, {
      rootReaddirCode: 'EACCES',
    });
    expect(provider.loadSession(SESSION_ID)).toEqual({ kind: 'unreadable-root' });
  });

  it('a hint that resolves an empty remnant reports no-substrate, still without enumerating', () => {
    const provider = providerOver(
      { [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: file('') }) },
      () => SLUG,
      { rootReaddirCode: 'EACCES' },
    );
    expect(provider.loadSession(SESSION_ID)).toEqual({ kind: 'no-substrate' });
  });

  it('a stale hint (session moved to another slug) falls back to enumeration and resolves', () => {
    const provider = providerOver(
      {
        [SLUG]: dir(fixtureSlugDir()),
        // The hinted slug EXISTS as a real dir but no longer holds the session.
        'stale-slug': dir({}),
      },
      () => 'stale-slug',
    );
    expect(provider.loadSession(SESSION_ID).kind).toBe('resolved');
  });

  it('a hint naming a directory that no longer exists falls back and resolves', () => {
    const provider = providerOver({ [SLUG]: dir(fixtureSlugDir()) }, () => 'vanished-slug');
    expect(provider.loadSession(SESSION_ID).kind).toBe('resolved');
  });

  it('a null hint (session unknown to the DB) falls back and resolves', () => {
    const provider = providerOver({ [SLUG]: dir(fixtureSlugDir()) }, () => null);
    expect(provider.loadSession(SESSION_ID).kind).toBe('resolved');
  });

  it('a hostile slug hint never becomes a path and containment holds', () => {
    // A crafted DB row must be dropped BEFORE any path is built from it. The
    // recording port captures every path the provider touches; none may leave
    // the root and none may embed the hostile value.
    const hostileSlugs = ['../../../etc/passwd', '..', '.', 'a/b', 'a\\b', ''];
    for (const hostile of hostileSlugs) {
      const paths: string[] = [];
      const fs = recordingFs(makeFakeCorpusFs(ROOT, { [SLUG]: dir(fixtureSlugDir()) }), paths);
      const provider = createSubstrateProvider({
        env: { CLAUDE_PROJECTS_DIR: ROOT },
        fs,
        slugOf: () => hostile,
      });
      expect(provider.loadSession(SESSION_ID).kind).toBe('resolved');
      for (const path of paths) {
        expect(path === ROOT || path.startsWith(`${ROOT}/`)).toBe(true);
        expect(path).not.toContain('..');
        expect(path).not.toContain('\\');
      }
    }
  });

  it('a symlinked slug directory declines the hint (an intermediate symlink is never followed)', () => {
    // readFileConfined's O_NOFOLLOW guards only the FINAL path component, so
    // the hint path must reject a symlinked slug dir itself - mirroring
    // enumeration's `probeLstat` + `isRealDir(st)` pair. Fallback enumeration
    // then answers from the real slug dir.
    const paths: string[] = [];
    const fs = recordingFs(
      makeFakeCorpusFs(ROOT, {
        [SLUG]: dir(fixtureSlugDir()),
        'link-slug': symlink('/somewhere/outside'),
      }),
      paths,
    );
    const provider = createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      fs,
      slugOf: () => 'link-slug',
    });
    expect(provider.loadSession(SESSION_ID).kind).toBe('resolved');
    // The symlink was lstat'ed (that IS the rejection) but never read through.
    expect(paths.filter((p) => p.includes('link-slug/'))).toEqual([]);
  });

  it('a symlinked main transcript declines the hint (and enumeration skips it too)', () => {
    const provider = providerOver(
      { [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: symlink() }) },
      () => SLUG,
    );
    expect(provider.loadSession(SESSION_ID)).toEqual({ kind: 'session-not-found' });
  });

  it('a main transcript that is a directory declines the hint (and enumeration skips it too)', () => {
    const provider = providerOver(
      { [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: dir({}) }) },
      () => SLUG,
    );
    expect(provider.loadSession(SESSION_ID)).toEqual({ kind: 'session-not-found' });
  });

  // An entry the hint names and the probe CANNOT LOOK AT is not a stale hint.
  // Declining it silently would send the lookup into enumeration, which either
  // hits the same errno or - worse - lists every OTHER session and lets the
  // fallback answer "not found" for a session nobody managed to look at: the
  // confident lie the unreadable-root arm exists to prevent, one level down.
  it('a slug directory that cannot be probed (EACCES) is reported unreadable, never declined', () => {
    const listed: string[] = [];
    const fs = readdirLoggingFs(
      makeFakeCorpusFs(
        ROOT,
        { [SLUG]: dir(fixtureSlugDir(), { throwLstat: 'EACCES' }) },
        { rootReaddirCode: 'EACCES' },
      ),
      listed,
    );
    const provider = createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      fs,
      slugOf: () => SLUG,
    });
    expect(provider.loadSession(SESSION_ID)).toEqual({
      kind: 'session-unreadable',
      path: SLUG,
      code: 'EACCES',
    });
    // No fallback: the root was never listed (the rigged root readdir would
    // have turned any attempt into 'unreadable-root' as a second witness).
    expect(listed).toEqual([]);
  });

  it('a main transcript that cannot be probed (EPERM) is reported unreadable at its corpus-relative path', () => {
    const listed: string[] = [];
    const fs = readdirLoggingFs(
      makeFakeCorpusFs(
        ROOT,
        { [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: file('{}\n', { throwLstat: 'EPERM' }) }) },
        { rootReaddirCode: 'EACCES' },
      ),
      listed,
    );
    const provider = createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      fs,
      slugOf: () => SLUG,
    });
    expect(provider.loadSession(SESSION_ID)).toEqual({
      kind: 'session-unreadable',
      path: `${SLUG}/${SESSION_ID}.jsonl`,
      code: 'EPERM',
    });
    expect(listed).toEqual([]);
  });

  it('a hinted entry that VANISHED (ENOENT / ENOTDIR) is a stale hint and still falls back', () => {
    // The `gone` probe outcome is the ONE errno family that keeps the old
    // behaviour: nothing is there to be denied, so enumeration answers.
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const goneDir = providerOver(
        { [SLUG]: dir(fixtureSlugDir()), 'gone-slug': dir({}, { throwLstat: code }) },
        () => 'gone-slug',
      );
      expect(goneDir.loadSession(SESSION_ID).kind).toBe('resolved');
    }
    const goneMain = providerOver(
      {
        [SLUG]: dir(fixtureSlugDir()),
        'moved-slug': dir({ [`${SESSION_ID}.jsonl`]: file('', { throwLstat: 'ENOENT' }) }),
      },
      () => 'moved-slug',
    );
    expect(goneMain.loadSession(SESSION_ID).kind).toBe('resolved');
  });

  it('start() wires the DB as the hint source end to end', async () => {
    // The unit tests above prove the hint SEAM; this proves the composition
    // root actually plugs `getSessionProjectSlug(db, ...)` into it. A valid
    // uuid the DB has never seen exercises the whole chain — auth gate, route,
    // provider, DB hint (null), fallback enumeration over a real (empty)
    // corpus — and must come back as the honest 404, not a 500 or 503.
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-hintwire-'));
    try {
      const corpusRoot = join(dir, 'projects');
      mkdirSync(corpusRoot, { recursive: true });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const server = await start({
        DASHBOARD_TOKEN: TEST_TOKEN,
        DASHBOARD_PORT: '0',
        DASHBOARD_DB_PATH: join(dir, 'agent.db'),
        CLAUDE_PROJECTS_DIR: corpusRoot,
        DASHBOARD_POLL_INTERVAL_MS: '600000', // park the poll loop far away
      });
      try {
        const response = await server.app.inject({
          method: 'GET',
          url: `/api/sessions/${SESSION_ID}/cost-analysis`,
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Session not found.' });
      } finally {
        await server.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-canonical session id never reaches slugOf and never becomes a path component', () => {
    // Only the exact shape enumeration itself would have produced (a
    // lowercase session UUID) may become a path; anything else skips the
    // hint entirely - the DB is not even asked.
    const asked: string[] = [];
    const paths: string[] = [];
    const fs = recordingFs(makeFakeCorpusFs(ROOT, { [SLUG]: dir(fixtureSlugDir()) }), paths);
    const provider = createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      fs,
      slugOf: (id) => {
        asked.push(id);
        return SLUG;
      },
    });
    expect(provider.loadSession('../../evil').kind).toBe('session-not-found');
    expect(asked).toEqual([]);
    for (const path of paths) {
      expect(path).not.toContain('evil');
    }
  });
});
