/**
 * Shared types for the synthetic fixture corpus.
 *
 * Every fixture models one of the four structural join paths of
 * docs/analysis/parser-spec.md section 4 (plus the N3 usage-dedup case from
 * section 5.2). All content is SYNTHETIC — invented ids, hex, timestamps and
 * prose; nothing is copied from real transcripts.
 */

/** One on-disk file of a fixture, expressed as JSONL lines (or a single JSON line for `.meta.json`). */
export interface FixtureFile {
  /** Path relative to the synthetic session directory, e.g. `subagents/agent-3fa9c2d1.jsonl`. */
  readonly relativePath: string;
  /** File content, one JSON document per entry. */
  readonly lines: readonly string[];
}

export interface Fixture {
  readonly name: FixtureName;
  /** What the fixture exercises and which parser-spec join path it maps to. */
  readonly description: string;
  readonly files: readonly FixtureFile[];
}

export const FIXTURE_NAMES = [
  'flat-tool-use',
  'nested-workflow',
  'task-notification-recovery',
  'queue-operation',
  'usage-dedup',
  'depth-2-sync',
  'legacy-bare-explore',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** Serialize a record as a single JSONL line (guarantees per-line JSON validity). */
export function jsonLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}
