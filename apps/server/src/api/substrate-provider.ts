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
  type LstatInfo,
  type ReadLimits,
  type SessionRef,
} from '../corpus/index';

/** One session's parsed reconstruction plus its compaction boundaries. */
export interface ResolvedSessionSubstrate {
  readonly session: ParsedSession;
  readonly boundaries: readonly CompactionBoundary[];
}

/**
 * The result of one lookup. Four of the five arms carry no substrate — and
 * they are four DIFFERENT facts that the route answers with DIFFERENT HTTP
 * statuses. This used to be `ResolvedSessionSubstrate | null`, and every
 * `null` became `404 Session not found.`, which was a false statement in most
 * of the cases: with no corpus root the server has no standing to say whether
 * the session exists, a root it could not READ proves nothing either way, and
 * an empty remnant IS found — it just holds nothing to analyse. Same collapse
 * the dashboard forbids for agent status ('unknown' is never `null`), except
 * this one reached the reader as a sentence.
 */
export type SubstrateLookup =
  /** Built and parsed; the analysis can run. */
  | { readonly kind: 'resolved'; readonly substrate: ResolvedSessionSubstrate }
  /** No corpus root on this machine — nothing can be said about any session. */
  | { readonly kind: 'no-corpus-root' }
  /** The root exists but could not be read right now — retryable, not a 404. */
  | { readonly kind: 'unreadable-root' }
  /** The corpus was enumerated and holds no session with that id. */
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

/** lstat, returning `null` instead of throwing when the entry is gone/unreadable. */
function tryLstat(fs: CorpusFs, absPath: string): LstatInfo | null {
  try {
    return fs.lstat(absPath);
  } catch {
    return null;
  }
}

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
 * isRealDir); `assertWithinRoot` + a regular non-symlink file on the main
 * transcript. `assertWithinRoot` is belt-and-braces on both paths: after
 * `isSafeEntryName` (and the UUID gate) it cannot fire, exactly as on the
 * enumeration path.
 *
 * Vetting-failure verdicts deliberately DIFFER from enumeration's: there, a
 * traversal-shaped name was read off disk and proves a crafted corpus
 * (ContainmentError, never swallowed); here it came from a DB row that is
 * merely a HINT — the path is never touched and the caller falls back to
 * enumeration, which answers from disk-vetted names only.
 *
 * Returns null on ANY miss — no dep, non-canonical id, no row, unsafe slug,
 * or a stale hint (entry gone or of the wrong kind) — never a partial ref.
 */
function resolveHintedRef(
  fs: CorpusFs,
  corpusRoot: string,
  sessionId: string,
  slugOf: ((sessionId: string) => string | null) | undefined,
): SessionRef | null {
  if (slugOf === undefined || !isSessionUuid(sessionId)) {
    return null;
  }
  const slug = slugOf(sessionId);
  if (slug === null || !isSafeEntryName(slug)) {
    return null;
  }
  const slugDirAbs = join(corpusRoot, slug);
  assertWithinRoot(corpusRoot, slugDirAbs);
  const slugStat = tryLstat(fs, slugDirAbs);
  if (slugStat === null || !slugStat.isDirectory || slugStat.isSymbolicLink) {
    return null;
  }
  const mainAbsPath = join(slugDirAbs, `${sessionId}.jsonl`);
  assertWithinRoot(corpusRoot, mainAbsPath);
  const mainStat = tryLstat(fs, mainAbsPath);
  if (mainStat === null || !mainStat.isFile || mainStat.isSymbolicLink) {
    return null;
  }
  return {
    sessionId,
    projectSlug: slug,
    mainAbsPath,
    sessionDirAbs: join(slugDirAbs, sessionId),
  };
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
      // sweep. Any miss falls through to enumeration below — the hint can
      // only ever cost a lookup its speed, never its answer.
      let ref = resolveHintedRef(fs, corpusRoot, sessionId, deps.slugOf);
      if (ref === null) {
        const enumeration = enumerateSessions(fs, corpusRoot);
        if (enumeration.kind === 'unreadable-root') {
          // A listing that failed proves nothing about the session — answering
          // "not found" here would deny a session nobody looked at.
          return { kind: 'unreadable-root' };
        }
        ref = enumeration.refs.find((candidate) => candidate.sessionId === sessionId) ?? null;
        if (ref === null) {
          return { kind: 'session-not-found' };
        }
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
