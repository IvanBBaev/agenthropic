/**
 * Compaction-boundary extraction — parser-spec gate #8 (compaction resets are
 * JSONL-native: `type:'system'` / `subtype:'compact_boundary'` records carrying
 * `compactMetadata`, never a `PreCompact` hook — 30 boundaries corpus-wide, all
 * `trigger=auto`; the spike measured compaction in 63/117 sessions).
 *
 * PARSER GAP (deliberately filled here, not in `parse-session`): the
 * {@link parseSession} reconstruction does not surface `compact_boundary`
 * records — `ParsedSession` carries agents/edges/usage only. This module is a
 * NEW pure extractor over the same raw {@link SessionSubstrate} so the WP-C4
 * cost engine can segment usage at context resets without restructuring the
 * verified join model. Pure data-in/data-out; no I/O.
 *
 * Loud vs tolerant (same policy as `parse-session`):
 * - THROW {@link SubstrateError} on a non-JSON line or on a `compact_boundary`
 *   record without a string `timestamp` — a boundary that cannot be placed in
 *   time would silently corrupt cost segmentation.
 * - TOLERATE a missing/malformed `compactMetadata` (`trigger`/`preTokens`
 *   become `null`) and ignore every record that is not a compact boundary.
 */
import { classifyRelativePath, SubstrateError } from './parse-session';
import type { SessionSubstrate } from './substrate';

/** One `compact_boundary` context reset, attributed to its owning transcript. */
export interface CompactionBoundary {
  /** Owning transcript: `null` for the main transcript, the `agent-<hex>` hex for a subagent. */
  agentId: string | null;
  /** ISO-8601 timestamp of the boundary record (segmentation anchor). */
  timestamp: string;
  /** `compactMetadata.trigger` (`'auto'` on the whole real corpus), or `null` when absent. */
  trigger: string | null;
  /**
   * `compactMetadata.preTokens` — the context-token baseline at the moment of
   * compaction (what WP-S6 calls "the PreCompact baseline"), or `null` when absent.
   */
  preTokens: number | null;
}

const AGENT_FILE_PREFIX = 'agent-';
const JSONL_SUFFIX = '.jsonl';

/** Derives the owning agent id of a transcript file: `null` for main, the hex for an agent file. */
function transcriptOwner(relativePath: string): { owner: string | null } | undefined {
  const kind = classifyRelativePath(relativePath);
  if (kind === 'main') {
    return { owner: null };
  }
  if (kind === 'agent') {
    const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return { owner: basename.slice(AGENT_FILE_PREFIX.length, -JSONL_SUFFIX.length) };
  }
  return undefined; // meta / journal / other: not a transcript, cannot carry a boundary.
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts every `compact_boundary` record from the substrate's transcript
 * files (main + `agent-<hex>` — sidecars/journals are skipped), in file order
 * then line order. Consumers needing temporal order per transcript sort by
 * timestamp (see `computeCompactionAwareCost`).
 *
 * @throws {SubstrateError} on a non-JSON line in a transcript file, or on a
 *   `compact_boundary` record whose `timestamp` is missing or not a string.
 */
export function extractCompactionBoundaries(substrate: SessionSubstrate): CompactionBoundary[] {
  const boundaries: CompactionBoundary[] = [];

  for (const file of substrate.files) {
    const transcript = transcriptOwner(file.relativePath);
    if (transcript === undefined) {
      continue;
    }

    file.lines.forEach((line, index) => {
      if (line.trim() === '') {
        return; // Tolerate blank lines (e.g. a trailing newline from the disk adapter).
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new SubstrateError(
          `${file.relativePath}:${index + 1}: line is not valid JSON (${String(error)})`,
        );
      }
      if (!isJsonRecord(parsed)) {
        return; // Tolerate non-object lines — no rule for them, same as parseSession.
      }
      if (parsed['type'] !== 'system' || parsed['subtype'] !== 'compact_boundary') {
        return;
      }

      const timestamp = parsed['timestamp'];
      if (typeof timestamp !== 'string') {
        throw new SubstrateError(
          `${file.relativePath}:${index + 1}: compact_boundary record has no string timestamp — the boundary cannot be placed in time`,
        );
      }

      const metadata = isJsonRecord(parsed['compactMetadata'])
        ? parsed['compactMetadata']
        : undefined;
      const trigger = metadata?.['trigger'];
      const preTokens = metadata?.['preTokens'];

      boundaries.push({
        agentId: transcript.owner,
        timestamp,
        trigger: typeof trigger === 'string' ? trigger : null,
        preTokens: typeof preTokens === 'number' && Number.isFinite(preTokens) ? preTokens : null,
      });
    });
  }

  return boundaries;
}
