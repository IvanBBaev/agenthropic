/**
 * Shared types for the synthetic fixture corpus.
 *
 * Every fixture models one join provenance of docs/analysis/parser-spec.md
 * section 4.1 (five: tool_use, directory, task_notification, queue_operation,
 * legacy_explore), the depth-2 parent (gate item 4), the N3 usage-dedup case
 * (section 5.2) or the WP-U10 outcome terminals. All content is SYNTHETIC — invented ids, hex, timestamps and
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
  'agent-outcome-errors',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** Serialize a record as a single JSONL line (guarantees per-line JSON validity). */
export function jsonLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}
