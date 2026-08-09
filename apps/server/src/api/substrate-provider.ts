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
 * {@link buildSessionSubstrate}. The provider never fabricates paths from the
 * caller-supplied session id: the id is only COMPARED against enumerated refs,
 * so a crafted id can never traverse anywhere. A {@link ContainmentError} from
 * a crafted corpus is deliberately NOT swallowed — it propagates to the route,
 * which surfaces a detail-free 500.
 *
 * Returned data carries relative paths / parsed records only — no absolute
 * corpus paths and no secrets ever leave this module.
 */
import {
  extractCompactionBoundaries,
  parseSession,
  type CompactionBoundary,
  type ParsedSession,
} from '@agenthropic/core';
import {
  DEFAULT_READ_LIMITS,
  buildSessionSubstrate,
  enumerateSessions,
  nodeCorpusFs,
  resolveCorpusRoot,
  type CorpusFs,
  type ReadLimits,
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

      const enumeration = enumerateSessions(fs, corpusRoot);
      if (enumeration.kind === 'unreadable-root') {
        // A listing that failed proves nothing about the session — answering
        // "not found" here would deny a session nobody looked at.
        return { kind: 'unreadable-root' };
      }
      const ref = enumeration.refs.find((candidate) => candidate.sessionId === sessionId);
      if (ref === undefined) {
        return { kind: 'session-not-found' };
      }

      const built = buildSessionSubstrate(fs, ref, limits);
      if (built.kind === 'no-substrate') {
        // The file IS there (it was enumerated a line ago); it just holds
        // nothing parseable — an empty main, no agents. Reporting that as
        // "not found" would deny a file this very call has seen.
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
