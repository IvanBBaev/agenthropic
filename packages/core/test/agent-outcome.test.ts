/**
 * Contract table for {@link classifyAgentOutcomeCause} — the cause half of the
 * ONE honest agent-terminal signal (the structural half, "does this
 * `tool_use_id` name a real spawn block?", is the parser's and is exercised in
 * `parse-session.test.ts`).
 *
 * Every positive row below is a message text OBSERVED in the corpus (33
 * parent-recorded error results out of 1276), not a guess, and each is asserted
 * against the anchor that classified it. The negative rows lock the anchoring
 * itself: a cause phrase that appears mid-sentence, or a near-miss prefix, must
 * land in `unclassified` rather than silently joining an existing bucket —
 * that abstention is the whole reason the patterns are anchored at all.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_OUTCOME_CAUSES, classifyAgentOutcomeCause } from '../src/index';

// The literal texts, verbatim from the corpus, with their measured frequencies.
const CONCURRENCY_LIMIT =
  'Concurrent subagent limit reached. You can run 20 subagents at once. Do not retry. ' +
  'If the user asked for more, tell them the limit was reached.';
const USER_INTERRUPT = '[Request interrupted by user for tool use]';
const PERMISSION_FAILED = 'Tool permission request failed: the permission stream closed';
const DISPATCH_UNAVAILABLE =
  'claude-sonnet-5[1m] is temporarily unavailable (timed out), so auto mode cannot determine ' +
  'the safety of Agent right now. Wait a moment and then try this action again.';
const TERMINATED_EARLY =
  "Agent terminated early due to an API error: You've hit your session limit · resets 12pm " +
  '(America/Los_Angeles)';

describe('classifyAgentOutcomeCause (observed corpus texts)', () => {
  it.each([
    // 19/33 — the spawn was refused outright; the agent never existed.
    [CONCURRENCY_LIMIT, 'concurrency_limit'],
    // 7/33 — a human stopped it; resolves to a REAL transcript.
    [USER_INTERRUPT, 'user_interrupt'],
    // 3/33 — the permission stream closed before an answer.
    [PERMISSION_FAILED, 'permission_failed'],
    // 2/33 — dispatch-time model unavailability, matched on an interior phrase
    // because the message opens with the model name.
    [DISPATCH_UNAVAILABLE, 'dispatch_unavailable'],
    // 2/33 — the one unambiguous 'error': the agent ran and was killed.
    [TERMINATED_EARLY, 'terminated_early'],
  ])('classifies %j as %s', (message, cause) => {
    expect(classifyAgentOutcomeCause(message)).toBe(cause);
  });
});

describe('classifyAgentOutcomeCause (abstention)', () => {
  it.each([
    // A never-before-seen failure text: recorded, never bucketed by guesswork.
    ['Something entirely new went wrong while dispatching the agent'],
    // The empty message the caller substitutes for a non-string `content`.
    [''],
    // Prefix-anchored causes must NOT match mid-sentence — this is exactly the
    // substring join gate #5 forbids.
    ['The parent reported: Concurrent subagent limit reached. Retrying anyway.'],
    ['note: [Request interrupted by user for tool use]'],
    ['warning — Tool permission request failed: denied'],
    ['Downstream said Agent terminated early due to an API error'],
    // Near misses on each anchor: the phrasing is close, the anchor is absent.
    ['Concurrent subagent limit reached without a trailing period'],
    ['[Request was interrupted by user for tool use]'],
    ['Tool permission request failed without the colon'],
    ['claude-sonnet-5[1m] is temporarily unavailable (timed out).'],
    ['Agent terminated late due to an API error'],
  ])('leaves %j unclassified', (message) => {
    expect(classifyAgentOutcomeCause(message)).toBe('unclassified');
  });
});

describe('AGENT_OUTCOME_CAUSES', () => {
  it('lists every cause in the shared union, in the documented order', () => {
    // Pinned as a literal list rather than derived: the migration-17 CHECK and
    // the shared `AgentOutcomeCause` union carry the same six literals, and a
    // drift in any of the three has to fail somewhere loud.
    expect(AGENT_OUTCOME_CAUSES).toEqual([
      'concurrency_limit',
      'user_interrupt',
      'permission_failed',
      'dispatch_unavailable',
      'terminated_early',
      'unclassified',
    ]);
  });

  it('is exactly the set the classifier can produce', () => {
    // Guards against a cause that exists as a runtime value but no pattern can
    // ever return (or the reverse: a pattern returning an unlisted literal).
    const produced = new Set(
      [
        CONCURRENCY_LIMIT,
        USER_INTERRUPT,
        PERMISSION_FAILED,
        DISPATCH_UNAVAILABLE,
        TERMINATED_EARLY,
        'an unrecognised failure',
      ].map(classifyAgentOutcomeCause),
    );

    expect([...produced].sort()).toEqual([...AGENT_OUTCOME_CAUSES].sort());
  });
});
