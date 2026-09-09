/**
 * Fixture `agent-outcome-errors` — WP-U10, the observed-agent-outcome
 * pipeline end to end.
 *
 * Flat layout, base join path 1 (like `flat-tool-use`): the main transcript
 * carries TWO parent-side `Agent` tool_use blocks, each answered by an
 * `is_error: true` tool_result on the SAME parent record. `parseSession`
 * emits one `outcomes` entry per errored, structurally-anchored spawn;
 * `classifyAgentOutcomeCause` sorts each into its cause by a prefix-anchored
 * pattern; the normalizer maps only `terminated_early` onto
 * `agents.status = 'error'` (`ERROR_CAUSES` in
 * `apps/server/src/ingest/normalize-session.ts`) — every other cause,
 * including `user_interrupt` here, stays the ordinary liveness status.
 *
 * THE PROPERTY THIS FIXTURE EXISTS TO PROVE: two error causes must NOT
 * collapse into the same status bucket. Of the 33 real error terminals
 * observed in the corpus this classifier was built from, 19 were
 * `concurrency_limit`, 7 `user_interrupt`, 3 `permission_failed`, 2
 * `dispatch_unavailable` and only 2 `terminated_early` — flattening any of
 * those into a single "errored" bucket would be exactly the defect this
 * two-agent shape is here to catch. (Counts re-verified 2026-09-02 over
 * 2633 transcripts; an earlier scan reported 30 in four causes because it
 * collected `Task`/`Agent` spawns but not `Workflow` ones.) So this fixture carries
 * one agent that resolves to `'error'` (terminated-early) alongside a
 * sibling that resolves to the ordinary liveness status and later ages to
 * `'unknown'` under the watchdog (user-interrupt) — never to `'error'`.
 *
 * Both message texts below are INVENTED for this fixture. Only the
 * classifier's documented anchor prefixes are shared with the real corpus
 * (`^Agent terminated early due to an API error`, `^\[Request interrupted by
 * user`) — matching them is the whole point of the fixture; everything past
 * the anchor is synthetic.
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = 'a9c0de00-1111-4222-8333-444444444444';

export const TERMINATED_TOOL_USE_ID = 'toolu_01SynthOutcomeFail0001';
export const INTERRUPT_TOOL_USE_ID = 'toolu_01SynthOutcomeStop0002';

/** The agent that ran and was killed mid-flight — resolves to `agents.status = 'error'`. */
export const TERMINATED_EARLY_AGENT_ID = 'fa11ed01';
/** The agent a human stopped — resolves to a real transcript, never `'error'`. */
export const USER_INTERRUPT_AGENT_ID = 'de1e7ed2';

// Anchor-prefix-compatible, but invented: the real corpus tail names a
// session-limit reset time and timezone, which is instance-specific data
// this synthetic fixture does not reproduce.
const TERMINATED_EARLY_TEXT =
  'Agent terminated early due to an API error: synthetic quota exhaustion invented for the ' +
  'agent-outcome-errors fixture, not observed in any real transcript.';
// The real corpus text in full: a fixed, content-free system string with no
// instance-specific data, reused verbatim (same status as an HTTP reason
// phrase, not "content from a transcript").
const USER_INTERRUPT_TEXT = '[Request interrupted by user for tool use]';

const mainTranscript = [
  jsonLine({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/synthetic/project',
    sessionId: SESSION_ID,
    version: '2.0.0',
    type: 'user',
    message: {
      role: 'user',
      content: 'Synthetic user prompt: dispatch two subagents to review the outage.',
    },
    uuid: 'a9c0de00-0000-4000-8000-000000000001',
    timestamp: '2026-01-20T10:00:00.000Z',
  }),
  jsonLine({
    parentUuid: 'a9c0de00-0000-4000-8000-000000000001',
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_outcome_parent_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [
        {
          type: 'text',
          text: 'Spawning two subagents now to review the outage in parallel.',
        },
        {
          type: 'tool_use',
          id: TERMINATED_TOOL_USE_ID,
          name: 'Agent',
          input: {
            prompt: 'Synthetic subagent task: page through the outage timeline.',
            subagent_type: 'general-purpose',
          },
        },
        {
          type: 'tool_use',
          id: INTERRUPT_TOOL_USE_ID,
          name: 'Agent',
          input: {
            prompt: 'Synthetic subagent task: draft the outage postmortem.',
            subagent_type: 'general-purpose',
          },
        },
      ],
      usage: {
        input_tokens: 48,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1400,
        output_tokens: 96,
      },
    },
    uuid: 'a9c0de00-0000-4000-8000-000000000002',
    timestamp: '2026-01-20T10:00:05.000Z',
  }),
  jsonLine({
    parentUuid: 'a9c0de00-0000-4000-8000-000000000002',
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: TERMINATED_TOOL_USE_ID,
          is_error: true,
          content: TERMINATED_EARLY_TEXT,
        },
        {
          type: 'tool_result',
          tool_use_id: INTERRUPT_TOOL_USE_ID,
          is_error: true,
          content: USER_INTERRUPT_TEXT,
        },
      ],
    },
    uuid: 'a9c0de00-0000-4000-8000-000000000003',
    timestamp: '2026-01-20T10:00:06.000Z',
  }),
];

const terminatedEarlyChildLines = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: TERMINATED_EARLY_AGENT_ID,
    type: 'user',
    message: {
      role: 'user',
      content: 'Synthetic subagent task: page through the outage timeline.',
    },
    uuid: 'fa11ed00-0000-4000-8000-000000000001',
    timestamp: '2026-01-20T10:00:07.000Z',
  }),
  jsonLine({
    parentUuid: 'fa11ed00-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: TERMINATED_EARLY_AGENT_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_outcome_child_fail_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-b',
      content: [{ type: 'text', text: 'Synthetic partial progress before termination.' }],
      usage: {
        input_tokens: 9,
        cache_creation_input_tokens: 120,
        cache_read_input_tokens: 0,
        output_tokens: 14,
      },
    },
    uuid: 'fa11ed00-0000-4000-8000-000000000002',
    timestamp: '2026-01-20T10:00:08.000Z',
  }),
];

const userInterruptChildLines = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: USER_INTERRUPT_AGENT_ID,
    type: 'user',
    message: { role: 'user', content: 'Synthetic subagent task: draft the outage postmortem.' },
    uuid: 'de1e7ed0-0000-4000-8000-000000000001',
    timestamp: '2026-01-20T10:00:07.000Z',
  }),
  jsonLine({
    parentUuid: 'de1e7ed0-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: USER_INTERRUPT_AGENT_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_outcome_child_stop_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-b',
      content: [{ type: 'text', text: 'Synthetic draft in progress before the interrupt.' }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
        output_tokens: 18,
      },
    },
    uuid: 'de1e7ed0-0000-4000-8000-000000000002',
    timestamp: '2026-01-20T10:00:08.000Z',
  }),
];

const terminatedEarlyChildMeta = [
  jsonLine({
    agentType: 'general-purpose',
    description: 'Synthetic subagent task: page through the outage timeline.',
    toolUseId: TERMINATED_TOOL_USE_ID,
    spawnDepth: 1,
  }),
];

const userInterruptChildMeta = [
  jsonLine({
    agentType: 'general-purpose',
    description: 'Synthetic subagent task: draft the outage postmortem.',
    toolUseId: INTERRUPT_TOOL_USE_ID,
    spawnDepth: 1,
  }),
];

export const agentOutcomeErrors: Fixture = {
  name: 'agent-outcome-errors',
  description:
    'Flat layout, base join path 1, two siblings: one Agent tool_use spawn answered by an ' +
    'is_error tool_result classified terminated_early (agents.status = "error", sticky), the ' +
    'other answered by an is_error tool_result classified user_interrupt (ordinary liveness ' +
    'status, ages to "unknown" under the watchdog, never "error"). Proves the two causes do not ' +
    'collapse into one status bucket (WP-U10).',
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    {
      relativePath: `subagents/agent-${TERMINATED_EARLY_AGENT_ID}.jsonl`,
      lines: terminatedEarlyChildLines,
    },
    {
      relativePath: `subagents/agent-${TERMINATED_EARLY_AGENT_ID}.meta.json`,
      lines: terminatedEarlyChildMeta,
    },
    {
      relativePath: `subagents/agent-${USER_INTERRUPT_AGENT_ID}.jsonl`,
      lines: userInterruptChildLines,
    },
    {
      relativePath: `subagents/agent-${USER_INTERRUPT_AGENT_ID}.meta.json`,
      lines: userInterruptChildMeta,
    },
  ],
};
