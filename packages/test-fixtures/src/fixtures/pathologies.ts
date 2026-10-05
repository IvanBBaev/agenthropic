/**
 * The WP-X1 pathology manifest: which synthetic fixtures exhibit each of the
 * four hostile pathologies the parser was proven against (parser-spec
 * section 1: post-compaction block eviction, live-crash / no-`Stop`
 * snapshot, same-slug concurrency, dual-layout depth-2).
 *
 * Owner decision D14(a) (2026-09-30) made the synthetic corpus the CI corpus,
 * so "all four pathologies each represented (manifest self-test)" is proven
 * here: `checkPathologyManifest` reports a pathology with no fixture and an
 * entry that names a fixture the registry does not ship, and the package's
 * self-test runs it against this manifest and the real registry.
 */
import { FIXTURE_NAMES, type FixtureName } from './types.js';

export const WP_X1_PATHOLOGIES = [
  'post-compaction-eviction',
  'crashed-no-stop',
  'same-slug-concurrency',
  'dual-layout-depth-2',
] as const;

export type Pathology = (typeof WP_X1_PATHOLOGIES)[number];

export interface PathologyEntry {
  /** What the pathology is and what a consumer must get right on it. */
  readonly description: string;
  /** The fixture(s) that exhibit it — a pair when one session cannot. */
  readonly fixtures: readonly FixtureName[];
}

export type PathologyManifest = Readonly<Record<Pathology, PathologyEntry>>;

export const PATHOLOGY_MANIFEST: PathologyManifest = {
  'post-compaction-eviction': {
    description:
      'A mid-session compaction (compact_boundary) evicted the parent-side spawn block; ' +
      'the edge must be recovered from the task-notification path instead.',
    fixtures: ['task-notification-recovery'],
  },
  'crashed-no-stop': {
    description:
      'The process died mid-turn: the transcripts just stop, the spawn has no tool_result ' +
      'and no Stop/SubagentStop follows. The edge still resolves; nothing is marked terminal.',
    fixtures: ['crashed-no-stop'],
  },
  'same-slug-concurrency': {
    description:
      'Two instances run at the same time in the same project (one slug, interleaved ' +
      'timestamps, look-alike spawns). Keyed on session uuid they stay two separate trees.',
    fixtures: ['concurrent-instance-a', 'concurrent-instance-b'],
  },
  'dual-layout-depth-2': {
    description:
      'Subagents in both on-disk layouts (flat subagents/ and nested workflows/) and a ' +
      'depth-2 grandchild whose parent is the depth-1 agent, not the main root.',
    fixtures: ['depth-2-sync', 'nested-workflow'],
  },
};

/**
 * Validate a manifest against a set of known fixture names. Returns one
 * human-readable issue per defect; an empty array means every pathology has
 * at least one fixture and every named fixture exists.
 */
export function checkPathologyManifest(
  manifest: Readonly<Partial<Record<string, { readonly fixtures: readonly string[] }>>>,
  known: readonly string[] = FIXTURE_NAMES,
): string[] {
  const issues: string[] = [];
  const knownSet = new Set(known);
  for (const pathology of WP_X1_PATHOLOGIES) {
    const entry = manifest[pathology];
    if (entry === undefined || entry.fixtures.length === 0) {
      issues.push(`pathology "${pathology}" has no fixture`);
      continue;
    }
    for (const fixture of entry.fixtures) {
      if (!knownSet.has(fixture)) {
        issues.push(`pathology "${pathology}" names missing fixture "${fixture}"`);
      }
    }
  }
  return issues;
}
