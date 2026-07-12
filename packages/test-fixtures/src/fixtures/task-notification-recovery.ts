/**
 * Fixture `task-notification-recovery` — parser-spec section 4, recovery path N1.
 *
 * Compaction evicted the parent-side tool_use block: the main transcript has a
 * `compact_boundary` record and deliberately NO tool_use with the spawn id.
 * The child-side `<task-notification>` message carries `<task-id>` /
 * `<tool-use-id>` tags that re-anchor the edge. Tests assert both the
 * child-side match AND the parent-side absence.
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '33333333-4444-4555-8666-777777777777';
export const EVICTED_TOOL_USE_ID = 'toolu_01SynthEvicted0001';
export const TASK_ID = 'task_synth_recover_0001';
const AGENT_HEX = 'c0ffee42';

const mainTranscript = [
  jsonLine({
    parentUuid: null,
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens: 165000 },
    uuid: 'ffffffff-0000-4000-8000-000000000001',
    timestamp: '2026-01-17T14:00:00.000Z',
  }),
  jsonLine({
    parentUuid: 'ffffffff-0000-4000-8000-000000000001',
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'user',
    message: {
      role: 'user',
      content: 'Synthetic post-compaction summary of the conversation so far.',
    },
    uuid: 'ffffffff-0000-4000-8000-000000000002',
    timestamp: '2026-01-17T14:00:01.000Z',
  }),
];

const childLines = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: AGENT_HEX,
    meta: { toolUseId: EVICTED_TOOL_USE_ID, layout: 'flat' },
    type: 'user',
    message: {
      role: 'user',
      content:
        '<task-notification>' +
        `<task-id>${TASK_ID}</task-id>` +
        `<tool-use-id>${EVICTED_TOOL_USE_ID}</tool-use-id>` +
        '</task-notification>' +
        'Synthetic task body dispatched before the compaction.',
    },
    uuid: '99999999-0000-4000-8000-000000000001',
    timestamp: '2026-01-17T13:55:00.000Z',
  }),
  jsonLine({
    parentUuid: '99999999-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: AGENT_HEX,
    type: 'assistant',
    message: {
      id: 'msg_synth_recover_child_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [{ type: 'text', text: 'Synthetic subagent output that survived compaction.' }],
      usage: {
        input_tokens: 19,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 3100,
        output_tokens: 64,
      },
    },
    uuid: '99999999-0000-4000-8000-000000000002',
    timestamp: '2026-01-17T13:55:04.000Z',
  }),
];

export const taskNotificationRecovery: Fixture = {
  name: 'task-notification-recovery',
  description:
    'Recovery join path N1: the parent-side tool_use block was evicted by compaction ' +
    '(compact_boundary present, no matching tool_use in the main transcript); the child-side ' +
    '<task-notification> carries <task-id>/<tool-use-id> that re-anchor the spawn edge.',
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    { relativePath: `subagents/agent-${AGENT_HEX}.jsonl`, lines: childLines },
  ],
};
