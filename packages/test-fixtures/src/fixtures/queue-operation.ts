/**
 * Fixture `queue-operation` — parser-spec section 4, recovery path N2.
 *
 * A `run_in_background` Agent spawn whose parent-side tool_use block is never
 * materialized: the main transcript instead carries a `type:"queue-operation"`
 * record with `<task-id>` / `<tool-use-id>` tags. The edge joins that record
 * to the child's inline `agentId` and `meta.toolUseId`. Without this path
 * every backgrounded subagent silently vanishes from the DAG.
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '44444444-5555-4666-8777-888888888888';
export const QUEUED_TOOL_USE_ID = 'toolu_01SynthQueued0001';
export const QUEUED_TASK_ID = 'task_synth_background_0001';
const AGENT_HEX = 'ba5eba11';

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
    meta: { toolUseId: QUEUED_TOOL_USE_ID, taskId: QUEUED_TASK_ID, layout: 'flat' },
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

export const queueOperation: Fixture = {
  name: 'queue-operation',
  description:
    'Recovery join path N2: a type:"queue-operation" record carrying <task-id>/<tool-use-id> ' +
    'tags for a run_in_background Agent spawn (no parent tool_use block exists), joined to ' +
    "the child's inline agentId and meta.toolUseId.",
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    { relativePath: `subagents/agent-${AGENT_HEX}.jsonl`, lines: childLines },
  ],
};
