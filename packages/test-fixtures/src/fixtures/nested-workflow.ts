/**
 * Fixture `nested-workflow` — parser-spec section 4, base path 2.
 *
 * Nested layout: agents live under `workflows/wf_<id>/`; the parent edge
 * comes from directory anchoring, not from a tool_use block. The journal's
 * `started` lines carry line-order plus a content-hash `key` (not a sequence
 * number), and every member of the workflow shares one `promptId` — a batch
 * key, not an ordinal (parser-spec section 6.3 / EMP-1). The two siblings
 * here start 2 ms apart, i.e. inside one dispatch wave (UNORDERED group).
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '22222222-3333-4444-8555-666666666666';
const WORKFLOW_ID = 'wf_9f8e7d6c5b4a';
const PROMPT_ID = 'prompt_synth_batch_0001';
const AGENT_A_HEX = 'deadbe01';
const AGENT_B_HEX = 'deadbe02';

const mainTranscript = [
  jsonLine({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/synthetic/project',
    sessionId: SESSION_ID,
    version: '2.0.0',
    type: 'user',
    message: { role: 'user', content: 'Synthetic prompt: run the two-step workflow.' },
    uuid: 'cccccccc-0000-4000-8000-000000000001',
    timestamp: '2026-01-16T09:00:00.000Z',
  }),
  jsonLine({
    parentUuid: 'cccccccc-0000-4000-8000-000000000001',
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_wf_parent_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01SynthWfDispatch0001',
          name: 'Workflow',
          input: { workflow_id: WORKFLOW_ID, prompt: 'Synthetic workflow dispatch.' },
        },
      ],
      usage: {
        input_tokens: 33,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2400,
        output_tokens: 51,
      },
    },
    uuid: 'cccccccc-0000-4000-8000-000000000002',
    timestamp: '2026-01-16T09:00:04.000Z',
  }),
];

const journal = [
  jsonLine({
    type: 'started',
    key: 'a1f4e9c803b7d2650918f6a4c2e7b3d0',
    agentId: AGENT_A_HEX,
    promptId: PROMPT_ID,
    timestamp: '2026-01-16T09:00:05.000Z',
  }),
  jsonLine({
    type: 'started',
    key: '7c2b9d0e4f6a18355ae0c1d9b8f72e64',
    agentId: AGENT_B_HEX,
    promptId: PROMPT_ID,
    timestamp: '2026-01-16T09:00:05.002Z',
  }),
];

function childLines(hex: string, uuidBase: string, firstTs: string, msgId: string): string[] {
  return [
    jsonLine({
      // parentUuid is null on each nested agent's first record (spec section 6.3).
      parentUuid: null,
      isSidechain: true,
      sessionId: SESSION_ID,
      agentId: hex,
      meta: { workflowId: WORKFLOW_ID, promptId: PROMPT_ID, layout: 'nested' },
      type: 'user',
      message: { role: 'user', content: `Synthetic nested task for agent ${hex}.` },
      uuid: `${uuidBase}1`,
      timestamp: firstTs,
    }),
    jsonLine({
      parentUuid: `${uuidBase}1`,
      isSidechain: true,
      sessionId: SESSION_ID,
      agentId: hex,
      type: 'assistant',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: 'synthetic-model-b',
        content: [{ type: 'text', text: 'Synthetic nested-agent output.' }],
        usage: {
          input_tokens: 11,
          cache_creation_input_tokens: 150,
          cache_read_input_tokens: 900,
          output_tokens: 40,
        },
      },
      uuid: `${uuidBase}2`,
      timestamp: '2026-01-16T09:00:08.000Z',
    }),
  ];
}

export const nestedWorkflow: Fixture = {
  name: 'nested-workflow',
  description:
    'Nested layout, base join path 2: workflows/wf_<id>/ directory anchoring provides the ' +
    'parent edge; journal.jsonl "started" lines carry line-order + content-hash key; both ' +
    'siblings share one promptId (batch key) and start 2 ms apart (same-wave, UNORDERED).',
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    { relativePath: `workflows/${WORKFLOW_ID}/journal.jsonl`, lines: journal },
    {
      relativePath: `workflows/${WORKFLOW_ID}/agent-${AGENT_A_HEX}.jsonl`,
      lines: childLines(
        AGENT_A_HEX,
        'dddddddd-0000-4000-8000-00000000000',
        '2026-01-16T09:00:05.001Z',
        'msg_synth_wf_child_a_0001',
      ),
    },
    {
      relativePath: `workflows/${WORKFLOW_ID}/agent-${AGENT_B_HEX}.jsonl`,
      lines: childLines(
        AGENT_B_HEX,
        'eeeeeeee-0000-4000-8000-00000000000',
        '2026-01-16T09:00:05.003Z',
        'msg_synth_wf_child_b_0001',
      ),
    },
  ],
};
