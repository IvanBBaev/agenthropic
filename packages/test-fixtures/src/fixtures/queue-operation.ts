/**
 * Fixture `queue-operation` — parser-spec section 4, recovery path N2.
 *
 * A `run_in_background` Agent spawn whose parent-side tool_use block is never
 * materialized: the main transcript instead carries a `type:"queue-operation"`
 * record whose `<task-id>` is the backgrounded child's agent hex and whose
 * `<tool-use-id>` is the parent spawn block id. The child's sidecar carries no
 * `toolUseId`, so the parser joins the child hex to that record's tool-use-id
 * via the queue index. Without this path every backgrounded subagent silently
 * vanishes from the DAG.
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '44444444-5555-4666-8777-888888888888';
export const QUEUED_TOOL_USE_ID = 'toolu_01SynthQueued0001';
const AGENT_HEX = 'ba5eba11';
// On real data the queue-operation's <task-id> IS the backgrounded child's
// agent hex — that is the join key the parser threads through
// queueChildToToolUse to reach the parent tool-use-id.
export const QUEUED_TASK_ID = AGENT_HEX;

const mainTranscript = [
  jsonLine({
    parentUuid: null,
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'user',
    message: {
      role: 'user',
      content: 'Synthetic prompt: run a background agent while we keep talking.',
    },
    uuid: '88888888-0000-4000-8000-000000000001',
    timestamp: '2026-01-18T08:00:00.000Z',
  }),
  jsonLine({
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'queue-operation',
    operation: 'enqueue',
    content:
      '<task-notification>' +
      `<task-id>${QUEUED_TASK_ID}</task-id>` +
      `<tool-use-id>${QUEUED_TOOL_USE_ID}</tool-use-id>` +
      '</task-notification>',
    uuid: '88888888-0000-4000-8000-000000000002',
    timestamp: '2026-01-18T08:00:02.000Z',
  }),
];

const childLines = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: AGENT_HEX,
    type: 'user',
    message: { role: 'user', content: 'Synthetic backgrounded subagent task.' },
    uuid: '77777777-0000-4000-8000-000000000001',
    timestamp: '2026-01-18T08:00:03.000Z',
  }),
  jsonLine({
    parentUuid: '77777777-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: AGENT_HEX,
    type: 'assistant',
    message: {
      id: 'msg_synth_queue_child_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-b',
      content: [{ type: 'text', text: 'Synthetic background-agent output.' }],
      usage: {
        input_tokens: 27,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 0,
        output_tokens: 73,
      },
    },
    uuid: '77777777-0000-4000-8000-000000000002',
    timestamp: '2026-01-18T08:00:07.000Z',
  }),
];

// Real sidecar for a backgrounded flat subagent whose parent block was never
// materialized: it carries NO `toolUseId`, which forces the parser off the
// sidecar-anchor path and onto the queue-operation join (queueChildToToolUse).
const childMeta = [
  jsonLine({
    agentType: 'general-purpose',
    spawnDepth: 1,
  }),
];

export const queueOperation: Fixture = {
  name: 'queue-operation',
  description:
    'Recovery join path N2: a type:"queue-operation" record carrying <task-id>/<tool-use-id> ' +
    'tags for a run_in_background Agent spawn (no parent tool_use block exists). The child ' +
    'sidecar carries no toolUseId, so the <task-id>==child-hex queue join supplies the anchor.',
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    { relativePath: `subagents/agent-${AGENT_HEX}.jsonl`, lines: childLines },
    { relativePath: `subagents/agent-${AGENT_HEX}.meta.json`, lines: childMeta },
  ],
};
