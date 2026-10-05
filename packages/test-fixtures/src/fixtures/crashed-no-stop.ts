/**
 * Fixture `crashed-no-stop` — WP-X1 pathology "live-crash / no-Stop snapshot"
 * (parser-spec section 1, the second of the four hostile pathologies).
 *
 * Flat layout, base join path 1 (like `flat-tool-use`): the main transcript
 * carries one parent-side `Agent` tool_use block, anchored by `tool_use.id` to
 * the child's `agent-<hex>.meta.json` sidecar `toolUseId`. Then the Claude
 * Code process dies. Nothing after that point is ever written:
 *
 * - the main transcript ENDS on the assistant record that carries the spawn
 *   block — no `tool_result` for the spawn ever arrives, no further turn;
 * - the child transcript ENDS mid-turn on an assistant record whose own
 *   `Bash` tool_use (`CRASHED_PENDING_TOOL_USE_ID`) is never answered;
 * - no `Stop` / `SubagentStop` hook fires (hooks are not part of the JSONL
 *   substrate, so their absence is simply the absence of any later record).
 *
 * On disk a crash can also leave a torn, unterminated final line; the corpus
 * line splitter drops that segment before the parser sees it, so the parser's
 * view of a torn tail is exactly this shape: every remaining line is whole,
 * the transcript just stops. The fixture therefore keeps every line valid
 * JSON (the registry-wide invariant) and models the crash as the mid-turn cut.
 *
 * WHAT A CONSUMER MUST GET RIGHT: the hierarchy still resolves (the edge is a
 * structural fact that the crash does not erase), the tokens already written
 * still count, and nothing claims the session or its agent terminated —
 * no `completed`, no `error` (there is no `is_error` tool_result to classify);
 * the agents stay ordinary liveness state and age under the watchdog.
 *
 * All content is SYNTHETIC — invented ids, hex, timestamps and prose.
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = 'c7a5bed0-1111-4222-8333-444444444444';

/** The parent-side spawn block that never receives a tool_result. */
export const CRASHED_SPAWN_TOOL_USE_ID = 'toolu_01SynthCrashSpawn0001';
/** The subagent that was mid-turn when the process died. */
export const CRASHED_AGENT_ID = 'c7a5bd01';
/** The child's last tool call, left pending forever by the crash. */
export const CRASHED_PENDING_TOOL_USE_ID = 'toolu_01SynthCrashPending0002';

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
      content: 'Synthetic user prompt: dispatch a subagent to rebuild the gadget index.',
    },
    uuid: 'c7a5bed0-0000-4000-8000-000000000001',
    timestamp: '2026-01-21T09:00:00.000Z',
  }),
  // The LAST record of the main transcript: the spawn is issued, and the
  // process dies before the spawn's tool_result (or anything else) is written.
  jsonLine({
    parentUuid: 'c7a5bed0-0000-4000-8000-000000000001',
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_crash_parent_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [
        { type: 'text', text: 'Dispatching a subagent to rebuild the gadget index.' },
        {
          type: 'tool_use',
          id: CRASHED_SPAWN_TOOL_USE_ID,
          name: 'Agent',
          input: {
            prompt: 'Synthetic subagent task: rebuild the gadget index.',
            subagent_type: 'general-purpose',
          },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 38,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1100,
        output_tokens: 64,
      },
    },
    uuid: 'c7a5bed0-0000-4000-8000-000000000002',
    timestamp: '2026-01-21T09:00:04.000Z',
  }),
];

const childLines = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: CRASHED_AGENT_ID,
    type: 'user',
    message: { role: 'user', content: 'Synthetic subagent task: rebuild the gadget index.' },
    uuid: 'c7a5bd00-0000-4000-8000-000000000001',
    timestamp: '2026-01-21T09:00:05.000Z',
  }),
  jsonLine({
    parentUuid: 'c7a5bd00-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: CRASHED_AGENT_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_crash_child_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-b',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01SynthCrashListing0001',
          name: 'Bash',
          input: { command: 'ls synthetic-gadgets' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 260,
        cache_read_input_tokens: 0,
        output_tokens: 19,
      },
    },
    uuid: 'c7a5bd00-0000-4000-8000-000000000002',
    timestamp: '2026-01-21T09:00:07.000Z',
  }),
  jsonLine({
    parentUuid: 'c7a5bd00-0000-4000-8000-000000000002',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: CRASHED_AGENT_ID,
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01SynthCrashListing0001',
          content: 'gadget-a.idx\ngadget-b.idx',
        },
      ],
    },
    uuid: 'c7a5bd00-0000-4000-8000-000000000003',
    timestamp: '2026-01-21T09:00:08.000Z',
  }),
  // The LAST record of the child transcript: a second tool call is issued and
  // never answered — the process died mid-turn.
  jsonLine({
    parentUuid: 'c7a5bd00-0000-4000-8000-000000000003',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: CRASHED_AGENT_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_crash_child_0002',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-b',
      content: [
        { type: 'text', text: 'Two index files found; rebuilding the first one now.' },
        {
          type: 'tool_use',
          id: CRASHED_PENDING_TOOL_USE_ID,
          name: 'Bash',
          input: { command: 'rebuild-index synthetic-gadgets/gadget-a.idx' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 14,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 260,
        output_tokens: 31,
      },
    },
    uuid: 'c7a5bd00-0000-4000-8000-000000000004',
    timestamp: '2026-01-21T09:00:10.000Z',
  }),
];

const childMeta = [
  jsonLine({
    agentType: 'general-purpose',
    description: 'Synthetic subagent task: rebuild the gadget index.',
    toolUseId: CRASHED_SPAWN_TOOL_USE_ID,
    spawnDepth: 1,
  }),
];

export const crashedNoStop: Fixture = {
  name: 'crashed-no-stop',
  description:
    'WP-X1 pathology live-crash / no-Stop: flat layout, base join path 1, one Agent spawn whose ' +
    'tool_result never arrives; the child transcript ends mid-turn on an unanswered tool_use and ' +
    'no Stop/SubagentStop ever follows. The edge must still resolve, the written tokens must still ' +
    'count, and nothing may be marked completed or error.',
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    { relativePath: `subagents/agent-${CRASHED_AGENT_ID}.jsonl`, lines: childLines },
    { relativePath: `subagents/agent-${CRASHED_AGENT_ID}.meta.json`, lines: childMeta },
  ],
};
