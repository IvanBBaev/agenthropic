/**
 * WP-C4/C5 read-side substrate provider — the seam that lets the cost-analysis
 * endpoint reach the JSONL corpus on demand. The compaction repricing and the
 * delegation-savings estimate both need the raw session SUBSTRATE (boundaries
 * are not persisted; the parsed agent tree drives top-tier derivation), so DB
 * rows alone cannot answer them.
 *
 * Strictly READ-ONLY by construction: everything goes through the {@link CorpusFs}
 * port (no write capability exists) and the same containment-safe enumeration /
 * build path the ingest runner uses — root resolved via {@link resolveCorpusRoot},
 * names vetted by {@link enumerateSessions}, files read by
 * {@link buildSessionSubstrate}. Untrusted values become path components in
 * exactly ONE place — the {@link resolveHintedRef} fast path — and only after
 * passing the same vetting enumeration applies to names it reads off disk; any
 * hint that fails vetting is dropped WITHOUT touching the path and the lookup
 * falls back to full enumeration, where the caller-supplied id is only
 * COMPARED against enumerated refs. A {@link ContainmentError} from a crafted
 * corpus is deliberately NOT swallowed — it propagates to the route, which
 * surfaces a detail-free 500.
 *
 * Returned data carries relative paths / parsed records only — no absolute
 * corpus paths and no secrets ever leave this module.
 */
import { join } from 'node:path';
import {
  extractCompactionBoundaries,
  parseSession,
  type CompactionBoundary,
  type ParsedSession,
} from '@agenthropic/core';
import {
  DEFAULT_READ_LIMITS,
  assertWithinRoot,
  buildSessionSubstrate,
  enumerateSessions,
  isSafeEntryName,
  isSessionUuid,
  nodeCorpusFs,
  resolveCorpusRoot,
  type CorpusFs,
  type ReadLimits,
  type SessionRef,
  type SkippedFile,
} from '../corpus/index';
import { isRealDir, probeLstat } from '../corpus/corpus-paths';

/** One session's parsed reconstruction plus its compaction boundaries. */
export interface ResolvedSessionSubstrate {
  readonly session: ParsedSession;
  readonly boundaries: readonly CompactionBoundary[];
}

/**
 * A corpus entry that names (or would hold) the session and could not be
 * PROBED — `lstat` failed with something other than absence: `EACCES`,
 * `EPERM`, `EIO`... The `unreadable-root` fact one level down: the entry is
 * (or may be) there, this process just could not look at it, so the session's
 * existence is unknown and must never be spelled "not found". `path` is the
 * corpus-root-relative POSIX path of the entry the probe failed on — the slug
 * directory (`<slug>`) or the main transcript (`<slug>/<uuid>.jsonl`) — never
 * an absolute path.
 */
export interface SessionUnreadable {
  readonly kind: 'session-unreadable';
  readonly path: string;
  /** The fs error code when one was surfaced (`EACCES`, `EIO`, …). */
  readonly code: string | undefined;
}

/**
 * The result of one lookup. Six of the seven arms carry no substrate — and
 * they are six DIFFERENT facts that the route answers with DIFFERENT HTTP
 * statuses. This used to be `ResolvedSessionSubstrate | null`, and every
 * `null` became `404 Session not found.`, which was a false statement in most
 * of the cases: with no corpus root the server has no standing to say whether
 * the session exists, a root it could not READ proves nothing either way, and
 * an empty remnant IS found — it just holds nothing to analyse. Same collapse
 * the dashboard forbids for agent status ('unknown' is never `null`), except
 * this one reached the reader as a sentence.
 *
 * The two `session-un*` arms are the same collapse one level below the root:
 * a slug directory or transcript the probe could not look at (hint path, or
 * enumeration naming this very id) is `session-unreadable`; an id that is not
 * among the LISTED sessions while some slug directory went unlisted is
 * `session-unlisted`. Only when every slug directory was listed and none held
 * the id is `session-not-found` a true sentence.
 */
export type SubstrateLookup =
  /** Built and parsed; the analysis can run. */
  | { readonly kind: 'resolved'; readonly substrate: ResolvedSessionSubstrate }
  /** No corpus root on this machine — nothing can be said about any session. */
  | { readonly kind: 'no-corpus-root' }
  /** The root exists but could not be read right now — retryable, not a 404. */
  | { readonly kind: 'unreadable-root' }
  /** The entry naming the session exists (or may) but could not be probed — retryable, not a 404. */
  | SessionUnreadable
  /**
   * Every LISTED session was checked and none has the id, but `unreadableDirs`
   * slug directories could not be listed and may hold it — retryable, not a 404.
   */
  | { readonly kind: 'session-unlisted'; readonly unreadableDirs: number }
  /** The corpus was fully enumerated and holds no session with that id. */
  | { readonly kind: 'session-not-found' }
  /** The session file exists but yields nothing parseable (an empty remnant). */
  | { readonly kind: 'no-substrate' };

/** The seam the cost-analysis route depends on (absent → the route replies 503). */
export interface SubstrateProvider {
  /**
   * Resolve, build and parse one session's substrate. Always reports WHY a
   * lookup produced no substrate — see {@link SubstrateLookup}.
   *
   * @throws {SubstrateError} (from the parser) on a poisoned transcript.
   * @throws {ContainmentError} on a crafted corpus — never swallowed.
   */
  loadSession(sessionId: string): SubstrateLookup;
}

export interface SubstrateProviderDeps {
  /** Environment view; only `CLAUDE_PROJECTS_DIR` is consulted (corpus root override). */
  readonly env: Record<string, string | undefined>;
  /** Read-only filesystem port; defaults to the production {@link nodeCorpusFs}. */
  readonly fs?: CorpusFs;
  /** Home directory resolver (for the default corpus root); defaults to `os.homedir`. */
  readonly homedir?: () => string;
  /** Read-limit overrides; merged over {@link DEFAULT_READ_LIMITS}. */
  readonly limits?: Partial<ReadLimits>;
  /**
   * Optional DB-backed location hint: the persisted `sessions.project_slug`
   * for a session id, or null when no row (or no slug) exists. Purely a
   * PERFORMANCE dep — a resolved hint skips the full-corpus enumeration that
   * used to run on every cost-analysis request; a hint that is absent, stale,
   * or fails vetting silently falls back to enumeration, which stays the
   * correctness anchor. Wired by the composition root as
   * `(id) => getSessionProjectSlug(db, id)`.
   */
  readonly slugOf?: (sessionId: string) => string | null;
}

/** What the DB slug hint resolved to — see {@link resolveHintedRef}. */
type HintOutcome =
  /** Both probes passed; the ref is exactly what enumeration would have built. */
  | { readonly kind: 'hit'; readonly ref: SessionRef }
  /** No usable hint — absent, unvetted, or stale — so enumeration must answer. */
  | { readonly kind: 'declined' }
  /** A probe on the hinted path failed for a reason other than absence: this IS the answer. */
  | SessionUnreadable;

/**
 * Fast-path ref resolution from a DB slug hint, instead of enumerating the
 * whole corpus (which every cost-analysis request used to do: an O(corpus)
 * readdir/lstat sweep — hundreds of ms of frozen event loop on a real corpus —
 * to find one session whose slug the `sessions` table already knows).
 *
 * This is the ONE place a caller-supplied session id and a DB value become
 * path components, so both are admitted only in exactly the shape enumeration
 * itself would have produced, with the same checks in the same order:
 * `isSessionUuid` on the id; `isSafeEntryName` + `assertWithinRoot` + a real
 * non-symlink directory on the slug (a symlinked slug dir is never followed —
 * a confined read's O_NOFOLLOW guards only the FINAL path component, so an
 * intermediate symlink must be rejected here, mirroring enumeration's
 * `probeLstat` + `isRealDir(st)` pair); `assertWithinRoot` + a regular
 * non-symlink file on the main transcript. `assertWithinRoot` is
 * belt-and-braces on both paths: after `isSafeEntryName` (and the UUID gate)
 * it cannot fire, exactly as on the enumeration path.
 *
 * Vetting-failure verdicts deliberately DIFFER from enumeration's: there, a
 * traversal-shaped name was read off disk and proves a crafted corpus
 * (ContainmentError, never swallowed); here it came from a DB row that is
 * merely a HINT — the path is never touched and the caller falls back to
 * enumeration, which answers from disk-vetted names only.
 *
 * `declined` on any MISS — no dep, non-canonical id, no row, unsafe slug, or
 * a stale hint (entry gone, or of the wrong kind) — never a partial ref. A
 * probe that FAILED is not a miss: the entry is (or may be) there and this
 * process could not look at it, so the outcome is `session-unreadable` at the
 * corpus-relative path of the probe that failed. Enumeration cannot improve on
 * that — the same probe fails there — and would only offer to rephrase it as
 * "not found", so this outcome is final and never falls back.
 */
function resolveHintedRef(
  fs: CorpusFs,
  corpusRoot: string,
  sessionId: string,
  slugOf: ((sessionId: string) => string | null) | undefined,
): HintOutcome {
  if (slugOf === undefined || !isSessionUuid(sessionId)) {
    return { kind: 'declined' };
  }
  const slug = slugOf(sessionId);
  if (slug === null || !isSafeEntryName(slug)) {
    return { kind: 'declined' };
  }
  const slugDirAbs = join(corpusRoot, slug);
  assertWithinRoot(corpusRoot, slugDirAbs);
  const slugDir = probeLstat(fs, slugDirAbs);
  if (slugDir.kind === 'unreadable') {
    return { kind: 'session-unreadable', path: slug, code: slugDir.code };
  }
  if (slugDir.kind === 'gone' || !isRealDir(slugDir.info)) {
    return { kind: 'declined' };
  }
  const mainAbsPath = join(slugDirAbs, `${sessionId}.jsonl`);
  assertWithinRoot(corpusRoot, mainAbsPath);
  const main = probeLstat(fs, mainAbsPath);
  if (main.kind === 'unreadable') {
    return { kind: 'session-unreadable', path: `${slug}/${sessionId}.jsonl`, code: main.code };
  }
  if (main.kind === 'gone' || !main.info.isFile || main.info.isSymbolicLink) {
    return { kind: 'declined' };
  }
  return {
    kind: 'hit',
    ref: {
      sessionId,
      projectSlug: slug,
      mainAbsPath,
      sessionDirAbs: join(slugDirAbs, sessionId),
    },
  };
}

/**
 * The verdict for an id that enumeration did not list. `session-not-found` is
 * a sentence about the WHOLE corpus, so it is true only when every slug
 * directory was listed. Enumeration records each one it could not probe or
 * list as an `unreadable` skip whose path is the bare slug (no `/`), and any of
 * those may hold the session: count them and answer `session-unlisted`.
 *
 * An `unreadable` skip on a main transcript (`<slug>/<uuid>.jsonl`) hides
 * exactly the session it is named after. When that is this id, enumeration
 * has SEEN the session's file and could not probe it — the very fact the hint
 * path reports for the same disk state, so it gets the same
 * `session-unreadable` answer (a hint may cost a lookup its speed, never its
 * answer). Another id's transcript cannot hide this one and does not count.
 */
function verdictForUnlisted(skipped: readonly SkippedFile[], sessionId: string): SubstrateLookup {
  const mainSuffix = `/${sessionId}.jsonl`;
  let unreadableDirs = 0;
  for (const skip of skipped) {
    if (skip.reason !== 'unreadable') {
      continue;
    }
    if (skip.relativePath.endsWith(mainSuffix)) {
      return { kind: 'session-unreadable', path: skip.relativePath, code: skip.code };
    }
    if (!skip.relativePath.includes('/')) {
      unreadableDirs += 1;
    }
  }
  return unreadableDirs === 0
    ? { kind: 'session-not-found' }
    : { kind: 'session-unlisted', unreadableDirs };
}

/** Build the production substrate provider over the read-only corpus port. */
export function createSubstrateProvider(deps: SubstrateProviderDeps): SubstrateProvider {
  const fs = deps.fs ?? nodeCorpusFs();
  const limits: ReadLimits = { ...DEFAULT_READ_LIMITS, ...deps.limits };

  return {
    loadSession(sessionId: string): SubstrateLookup {
      // Re-resolved per call (mirrors runCorpusIngest): a corpus that appears
      // after boot becomes visible without a restart.
      const corpusRoot = resolveCorpusRoot(deps.env, fs, deps.homedir);
      if (corpusRoot === null) {
        // NOT "not found": with no corpus to enumerate, this provider has no
        // standing to say whether the session exists. It may well exist on the
        // machine whose corpus is missing here.
        return { kind: 'no-corpus-root' };
      }

      // The DB slug hint first: O(1) lstat probes instead of an O(corpus)
      // sweep. Any MISS falls through to enumeration below — the hint can
      // only ever cost a lookup its speed, never its answer. A probe that
      // FAILED is not a miss and does not fall through: enumeration would hit
      // the same wall and, when the root listing itself happens to work,
      // would spell "could not look" as "not found".
      const hinted = resolveHintedRef(fs, corpusRoot, sessionId, deps.slugOf);
      if (hinted.kind === 'session-unreadable') {
        return hinted;
      }
      let ref: SessionRef;
      if (hinted.kind === 'hit') {
        ref = hinted.ref;
      } else {
        const enumeration = enumerateSessions(fs, corpusRoot);
        if (enumeration.kind === 'unreadable-root') {
          // A listing that failed proves nothing about the session — answering
          // "not found" here would deny a session nobody looked at.
          return { kind: 'unreadable-root' };
        }
        const listed = enumeration.refs.find((candidate) => candidate.sessionId === sessionId);
        if (listed === undefined) {
          // Not among the LISTED sessions — which is "not found" only when
          // every slug directory was listed (see verdictForUnlisted).
          return verdictForUnlisted(enumeration.skipped, sessionId);
        }
        ref = listed;
      }

      const built = buildSessionSubstrate(fs, ref, limits);
      if (built.kind === 'no-substrate') {
        // The file IS there (both ref paths lstat'ed it a moment ago); it just
        // holds nothing parseable — an empty main, no agents. Reporting that
        // as "not found" would deny a file this very call has seen.
        return { kind: 'no-substrate' };
      }

      return {
        kind: 'resolved',
        substrate: {
          session: parseSession(built.substrate),
          boundaries: extractCompactionBoundaries(built.substrate),
        },
      };
    },
  };
}
