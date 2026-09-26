/**
 * The substrate provider's answer when the corpus could be reached but not
 * fully READ - the one-level-down twin of the `unreadable-root` arm.
 *
 * Enumeration (since F1) records every slug directory it could not list or
 * probe, and every main transcript it could not probe, as an `unreadable`
 * skip instead of walking past it. The provider used to ignore that list: an
 * id absent from `refs` was answered `session-not-found` even when the only
 * reason it was absent was a directory nobody could look inside. That is the
 * confident lie the unreadable-root comment forbids, restated one level down -
 * and the route turned it into a `404 Session not found.`.
 *
 * Provider-level: which skips count (only `unreadable` ones, and only those
 * that could hide THIS session) and the verdicts they produce, with no slug
 * hint so the enumeration fallback is the path under test. Route-level: the
 * HTTP mapping of the two verdicts on the one route that calls `loadSession`,
 * driven through a stub provider so the assertions are about the mapping
 * alone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createSubstrateProvider,
  type SubstrateLookup,
  type SubstrateProvider,
} from '../src/api/substrate-provider';
import { buildServer } from '../src/server';
import { createMigratedTempDb, TEST_TOKEN } from './helpers';
import { dir, file, makeFakeCorpusFs, type TreeSpec } from './corpus/fake-corpus-fs';

const ROOT = '/fake/projects';
const SLUG = '-Users-synthetic-unreadable-project';
const SESSION_ID = '33333333-4444-4555-8666-777777777777';
const OTHER_ID = 'eeeeeeee-0000-4000-8000-000000000000';
/** An id no tree below ever holds. */
const ABSENT_ID = 'abababab-1111-4222-8333-444444444444';

/** A provider with NO slug hint: every lookup goes through enumeration. */
function providerOver(tree: TreeSpec): SubstrateProvider {
  // Explicit env only - the provider must never see the real ~/.claude.
  return createSubstrateProvider({
    env: { CLAUDE_PROJECTS_DIR: ROOT },
    fs: makeFakeCorpusFs(ROOT, tree),
  });
}

describe('substrate provider over a partially unreadable corpus', () => {
  it('an absent id is unlisted - not not-found - when a slug directory could not be listed', () => {
    const provider = providerOver({
      [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: file('') }),
      'locked-slug': dir({}, { throwReaddir: 'EACCES' }),
    });
    // The listed sessions do not contain the id, but a whole directory went
    // unlisted: the id may well live there. "Not found" would deny a session
    // nobody looked at.
    expect(provider.loadSession(ABSENT_ID)).toEqual({
      kind: 'session-unlisted',
      unreadableDirs: 1,
    });
  });

  it('a slug directory whose probe failed counts the same way, and the count is per directory', () => {
    const provider = providerOver({
      [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: file('') }),
      'locked-slug': dir({}, { throwReaddir: 'EACCES' }),
      'bad-inode-slug': dir({}, { throwLstat: 'EIO' }),
    });
    expect(provider.loadSession(ABSENT_ID)).toEqual({
      kind: 'session-unlisted',
      unreadableDirs: 2,
    });
  });

  it('stays session-not-found when no skip is an unreadable one', () => {
    // A corpus with nothing skipped ...
    expect(
      providerOver({ [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: file('') }) }).loadSession(ABSENT_ID),
    ).toEqual({
      kind: 'session-not-found',
    });
    // ... and one whose only skip is a `duplicate-session` (review M-14): the
    // discriminator is the skip REASON, not "the skip list is non-empty".
    const duplicated = providerOver({
      'a-slug': dir({ [`${SESSION_ID}.jsonl`]: file('') }),
      'b-slug': dir({ [`${SESSION_ID}.jsonl`]: file('') }),
    });
    expect(duplicated.loadSession(ABSENT_ID)).toEqual({ kind: 'session-not-found' });
  });

  it("stays session-not-found when the only unreadable entry is ANOTHER session's transcript", () => {
    // A main transcript whose probe failed hides exactly the session it is
    // named after. That one is not this one, so nothing here could hide it.
    const provider = providerOver({
      [SLUG]: dir({
        [`${SESSION_ID}.jsonl`]: file(''),
        [`${OTHER_ID}.jsonl`]: file('{}\n', { throwLstat: 'EPERM' }),
      }),
    });
    expect(provider.loadSession(ABSENT_ID)).toEqual({ kind: 'session-not-found' });
  });

  it("reports THIS session's unprobeable transcript as unreadable at its path, hint or no hint", () => {
    // Enumeration saw the file - its name is the id asked for - and could not
    // probe it. That is the very verdict the hint path gives for the same
    // disk state, and the hint may cost a lookup its speed, never its answer.
    const tree: TreeSpec = {
      [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: file('{}\n', { throwLstat: 'EPERM' }) }),
    };
    const expected = {
      kind: 'session-unreadable',
      path: `${SLUG}/${SESSION_ID}.jsonl`,
      code: 'EPERM',
    };
    expect(providerOver(tree).loadSession(SESSION_ID)).toEqual(expected);
    const hinted = createSubstrateProvider({
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      fs: makeFakeCorpusFs(ROOT, tree),
      slugOf: () => SLUG,
    });
    expect(hinted.loadSession(SESSION_ID)).toEqual(expected);
  });

  it('an unreadable directory elsewhere does not stop a LISTED session from being served', () => {
    const provider = providerOver({
      [SLUG]: dir({ [`${SESSION_ID}.jsonl`]: file('') }),
      'locked-slug': dir({}, { throwReaddir: 'EACCES' }),
    });
    // Found (an empty remnant, so no-substrate) - the unreadable sibling is
    // irrelevant to a session that WAS enumerated.
    expect(provider.loadSession(SESSION_ID)).toEqual({ kind: 'no-substrate' });
  });
});

describe('route mapping of the unreadable-corpus verdicts', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  /** An app whose provider answers every lookup with `lookup` - the mapping alone is under test. */
  async function appAnswering(lookup: SubstrateLookup): Promise<FastifyInstance> {
    const temp = createMigratedTempDb();
    const app = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 7,
      db: temp.db,
      substrateProvider: { loadSession: () => lookup },
    });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      temp.cleanup();
    });
    return app;
  }

  const ROUTE = `/api/sessions/${SESSION_ID}/cost-analysis`;
  const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly lookup: SubstrateLookup;
    readonly error: string;
  }> = [
    {
      name: 'session-unreadable on a slug directory (errno known)',
      lookup: { kind: 'session-unreadable', path: SLUG, code: 'EACCES' },
      error: `the corpus could not be read at "${SLUG}"; whether the session exists is unknown; retry shortly`,
    },
    {
      name: 'session-unreadable on a main transcript (errno unknown)',
      lookup: { kind: 'session-unreadable', path: `${SLUG}/${SESSION_ID}.jsonl`, code: undefined },
      error: `the corpus could not be read at "${SLUG}/${SESSION_ID}.jsonl"; whether the session exists is unknown; retry shortly`,
    },
    {
      name: 'session-unlisted with one unreadable directory',
      lookup: { kind: 'session-unlisted', unreadableDirs: 1 },
      error:
        'the session is not among the listed sessions, but 1 of the corpus directories could not be read, so whether it exists is unknown; retry shortly',
    },
    {
      name: 'session-unlisted with several unreadable directories',
      lookup: { kind: 'session-unlisted', unreadableDirs: 3 },
      error:
        'the session is not among the listed sessions, but 3 of the corpus directories could not be read, so whether it exists is unknown; retry shortly',
    },
  ];

  for (const testCase of cases) {
    it(`GET /api/sessions/:id/cost-analysis answers 503 for ${testCase.name}`, async () => {
      const app = await appAnswering(testCase.lookup);
      const response = await app.inject({ method: 'GET', url: ROUTE, headers: AUTH });
      // Same status family as `unreadable-root`: retryable, and NEVER the 404
      // that would assert an absence this request could not establish.
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: testCase.error });
      expect(response.json().error.toLowerCase()).not.toContain('not found');
    });
  }

  it('the table above covers every route that consults the provider', () => {
    // Read as TEXT (never imported): a second `loadSession` call site added
    // to the routes plugin must extend the table, or this fails.
    const routesSource = readFileSync(
      fileURLToPath(new URL('../src/api/routes.ts', import.meta.url)),
      'utf8',
    );
    expect(routesSource.match(/substrateProvider\.loadSession\(/g)).toHaveLength(1);
  });
});
