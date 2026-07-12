/**
 * Fixture `flat-tool-use` — parser-spec section 4, base path 1.
 *
 * Flat layout: the main transcript carries an `Agent` tool_use block whose
 * `id` is the structural anchor; the child `agent-<hex>.jsonl` carries the
 * inline `agentId` and a `meta.toolUseId` byte-equal to that anchor.
 * The join must be on structural id position, never a substring grep — the
 * prose line below deliberately mentions the id in free text (gate item #5).
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const TOOL_USE_ID = 'toolu_01SynthFlatSpawn0001';
const AGENT_HEX = '3fa9c2d1';

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
      content: 'Synthetic user prompt: please dispatch a subagent to inspect the widgets.',
    },
    uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
    timestamp: '2026-01-15T10:00:00.000Z',
  }),
  jsonLine({
    parentUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_flat_parent_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [
        {
          type: 'text',
          // Prose that mentions the anchor id: a substring join would forge a
          // false edge from this line (parser-spec gate item #5).
          text: 'Spawning a subagent now; for reference the tool call is toolu_01SynthFlatSpawn0001.',
        },
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'Agent',
          input: {
            prompt: 'Synthetic subagent task: count the widgets.',
            subagent_type: 'general-purpose',
          },
        },
      ],
      usage: {
        input_tokens: 42,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1200,
        output_tokens: 87,
      },
    },
    uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
    timestamp: '2026-01-15T10:00:05.000Z',
  }),
];

const childFirstLines = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: AGENT_HEX,
    meta: { toolUseId: TOOL_USE_ID, layout: 'flat' },
    type: 'user',
    message: {
      role: 'user',
      content: 'Synthetic subagent task: count the widgets.',
    },
    uuid: 'bbbbbbbb-0000-4000-8000-000000000001',
    timestamp: '2026-01-15T10:00:06.000Z',
  }),
  jsonLine({
    parentUuid: 'bbbbbbbb-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: AGENT_HEX,
    type: 'assistant',
    message: {
      id: 'msg_synth_flat_child_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [{ type: 'text', text: 'Synthetic result: 7 widgets counted.' }],
      usage: {
        input_tokens: 15,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 0,
        output_tokens: 22,
      },
    },
    uuid: 'bbbbbbbb-0000-4000-8000-000000000002',
    timestamp: '2026-01-15T10:00:09.000Z',
  }),
];

const childMeta = [
  jsonLine({
    agentId: AGENT_HEX,
    toolUseId: TOOL_USE_ID,
    promptId: 'prompt_synth_flat_0001',
    layout: 'flat',
    model: 'synthetic-model-a',
  }),
];

export const flatToolUse: Fixture = {
  name: 'flat-tool-use',
  description:
    'Flat layout, base join path 1: parent-side Agent tool_use block in the main transcript, ' +
    'anchored by tool_use.id to the child agent-<hex>.jsonl inline agentId/meta.toolUseId. ' +
    'Includes a prose mention of the anchor id to guard against substring joins (gate #5).',
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    { relativePath: `subagents/agent-${AGENT_HEX}.jsonl`, lines: childFirstLines },
    { relativePath: `subagents/agent-${AGENT_HEX}.meta.json`, lines: childMeta },
  ],
};
