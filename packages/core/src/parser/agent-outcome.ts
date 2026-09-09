/**
 * Agent-outcome classification — the ONE honest agent-terminal signal the
 * transcripts carry, read from the PARENT-side `Agent`/`Workflow`
 * `tool_result`.
 *
 * WHY THIS SHAPE AND NOTHING ELSE
 *
 * Four candidate signals exist in a real corpus; three of them are traps, and
 * they were measured before this module was written (2555 transcripts,
 * 422,461 JSONL records):
 *
 *  - `stop_reason` is NOT a failure oracle. Corpus-wide it is only `tool_use`
 *    (122,679), `end_turn` (3,050), `stop_sequence` (829) and `refusal` (2);
 *    876 of 1252 subagent transcripts simply END on `tool_use`. Reading that
 *    as failure would report ~70% of all agents failed.
 *  - Tool-level `is_error: true` on ANY tool is noise — 862 of 2552 files carry
 *    one. A failed grep and a missing file are not a failed agent. This is the
 *    forbidden heuristic.
 *  - `isApiErrorMessage: true` marks a failed TURN, not a failed AGENT (780
 *    records across 435 files; the sessions continue straight past them).
 *  - What IS left: a `tool_result` with `is_error: true` whose `tool_use_id`
 *    names a MATERIALIZED `Agent`/`Workflow` spawn block. Corpus-wide that is
 *    1421 ok against 33 errors, in five legible causes — small, structural, and
 *    attributable to exactly one child.
 *
 * THE `ok` FIGURE READ `1243` UNTIL 2026-09-02 AND WAS WRONG. It came from a
 * scan that collected `Task`/`Agent` spawns but not `Workflow` ones — and so
 * did the `30` it was originally paired with. When the error count was later
 * corrected to 33 the number beside it was left behind, so the two halves of
 * one ratio were being quoted from two different measurements. Re-measured
 * whole on 2026-09-02 (2693 transcripts, 461,334 records, 0 unparseable):
 * 1454 spawn results, 1421 ok / 33 error, causes 19 / 7 / 3 / 2 / 2.
 *
 * Across three scans of a corpus that kept growing, the `ok` side moved
 * 1243 -> 1369 -> 1421 while the error count and, more importantly, the CAUSE
 * SET did not move at all. That stability — not the absolute figures, which
 * are stale the day after they are taken — is the property this module rests
 * on, and it is why the classifier matches on prefixes and drops anything new
 * into `unclassified` instead of widening a bucket to fit it.
 *
 * Matching is anchored on the message PREFIX (or, for the dispatch case, on a
 * fixed interior phrase), never on `is_error` alone, so a new failure text
 * lands in `unclassified` rather than silently joining an existing bucket.
 */
import type { AgentOutcomeCause } from '@agenthropic/shared';

/**
 * Every cause, as a runtime value, pinned to the shared union by `satisfies`
 * (the {@link LEGACY_EXPLORE_EDGE_SOURCE} idiom): a drift in the shared type
 * fails compilation here, and the migration-17 CHECK lists the same literals.
 */
export const AGENT_OUTCOME_CAUSES = [
  'concurrency_limit',
  'user_interrupt',
  'permission_failed',
  'dispatch_unavailable',
  'terminated_early',
  'unclassified',
] as const satisfies readonly AgentOutcomeCause[];

/**
 * The measured cause patterns, in match order. Each is the literal text a real
 * `tool_result` carried; none of them is a guess.
 */
const CAUSE_PATTERNS: ReadonlyArray<readonly [RegExp, AgentOutcomeCause]> = [
  // 19/33 — the spawn was refused outright; the agent never existed.
  [/^Concurrent subagent limit reached\./, 'concurrency_limit'],
  // 7/33 — a human stopped it. Resolves to a REAL transcript, and is the
  // reason a structural "did a transcript exist?" gate alone is not enough.
  [/^\[Request interrupted by user/, 'user_interrupt'],
  // 3/33 — the permission stream closed before an answer; nothing was started.
  [/^Tool permission request failed:/, 'permission_failed'],
  // 2/33 — dispatch-time model unavailability. Phrased with the model name
  // first ("claude-sonnet-5[1m] is temporarily unavailable (timed out), so auto
  // mode cannot determine ..."), so this one matches an interior phrase.
  [
    / is temporarily unavailable \(timed out\), so auto mode cannot determine/,
    'dispatch_unavailable',
  ],
  // 2/33 — the ONLY unambiguous 'error': the agent ran and was terminated.
  [/^Agent terminated early due to an API error/, 'terminated_early'],
];

/**
 * Classify one error `tool_result`'s text. Total and pure: an unrecognised (or
 * non-string, hence empty) message yields `unclassified`, which is recorded but
 * never promoted to an 'error' status.
 *
 * The caller is responsible for the structural half of the rule — only a
 * `tool_use_id` that names a real `Agent`/`Workflow` spawn block may reach
 * here. That gate is what keeps the forbidden any-tool `is_error` heuristic out.
 */
export function classifyAgentOutcomeCause(message: string): AgentOutcomeCause {
  for (const [pattern, cause] of CAUSE_PATTERNS) {
    if (pattern.test(message)) {
      return cause;
    }
  }
  return 'unclassified';
}
