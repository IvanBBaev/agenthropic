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

/** The seam the cost-analysis route depends on (absent → the route replies 503). */
export interface SubstrateProvider {
  /**
   * Resolve, build and parse one session's substrate. Returns `null` when the
   * corpus root does not exist, no enumerated session matches `sessionId`, or
   * the session yields nothing parseable (an empty remnant).
   *
   * @throws {SubstrateError} (from the parser) on a poisoned transcript.
   * @throws {ContainmentError} on a crafted corpus — never swallowed.
   */
  loadSession(sessionId: string): ResolvedSessionSubstrate | null;
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
    loadSession(sessionId: string): ResolvedSessionSubstrate | null {
      // Re-resolved per call (mirrors runCorpusIngest): a corpus that appears
      // after boot becomes visible without a restart.
      const corpusRoot = resolveCorpusRoot(deps.env, fs, deps.homedir);
      if (corpusRoot === null) {
        return null; // no corpus on this machine → the session cannot exist
      }

      const ref = enumerateSessions(fs, corpusRoot).find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (ref === undefined) {
        return null;
      }

      const built = buildSessionSubstrate(fs, ref, limits);
      if (built === null) {
        return null; // nothing parseable survived (e.g. an empty main, no agents)
      }

      return {
        session: parseSession(built.substrate),
        boundaries: extractCompactionBoundaries(built.substrate),
      };
    },
  };
}
