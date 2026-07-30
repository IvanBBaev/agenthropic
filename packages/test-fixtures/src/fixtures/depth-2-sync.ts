/**
 * Fixture `depth-2-sync` — the self-referential parent (gate #4) via SYNCHRONOUS
 * tool_use spawns anchored by `.meta.json` sidecars.
 *
 * The main dispatches a depth-1 agent (Agent tool_use block in the main
 * transcript); the depth-1 agent then dispatches a depth-2 grandchild whose
 * Agent tool_use block LIVES INSIDE the depth-1 transcript. Each child's
 * `agent-<hex>.meta.json` sidecar carries the `toolUseId` of the spawn block
 * that created it, so the parser anchors:
 *   - depth-1 -> the main session (block owned by the main transcript), and
 *   - depth-2 -> the depth-1 agent (block owned by the depth-1 transcript),
 *     NOT the main root. That grandchild edge is the whole point.
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const DEPTH1_HEX = 'd1d1a001';
const DEPTH2_HEX = 'd2d2b002';
const TOOL_USE_D1 = 'toolu_01SynthDepth1Spawn';
const TOOL_USE_D2 = 'toolu_01SynthDepth2Spawn';

const mainTranscript = [
  jsonLine({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/synthetic/project',
    sessionId: SESSION_ID,
    version: '2.0.0',
    type: 'user',
    message: { role: 'user', content: 'Synthetic prompt: dispatch a depth-1 agent.' },
    uuid: 'a0000000-0000-4000-8000-000000000001',
    timestamp: '2026-04-02T00:00:00.000Z',
  }),
  jsonLine({
    parentUuid: 'a0000000-0000-4000-8000-000000000001',
    isSidechain: false,
    sessionId: SESSION_ID,
    type: 'assistant',
    message: {
      id: 'msg_synth_d2sync_main_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_D1,
          name: 'Agent',
          input: { prompt: 'Synthetic depth-1 dispatch.', subagent_type: 'depth1-agent' },
        },
      ],
      usage: {
        input_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 800,
        output_tokens: 60,
      },
    },
    uuid: 'a0000000-0000-4000-8000-000000000002',
    timestamp: '2026-04-02T00:00:01.000Z',
  }),
];

// The depth-1 transcript CONTAINS the depth-2 spawn block, so the parser
// attributes TOOL_USE_D2 to owner=DEPTH1_HEX (the transcript that holds it).
const depth1Transcript = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: DEPTH1_HEX,
    type: 'user',
    message: { role: 'user', content: 'Synthetic depth-1 task.' },
    uuid: 'b0000000-0000-4000-8000-000000000001',
    timestamp: '2026-04-02T00:00:02.000Z',
  }),
  jsonLine({
    parentUuid: 'b0000000-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: DEPTH1_HEX,
    type: 'assistant',
    message: {
      id: 'msg_synth_d2sync_d1_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_D2,
          name: 'Agent',
          input: { prompt: 'Synthetic depth-2 dispatch.', subagent_type: 'grandchild-agent' },
        },
      ],
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 500,
        output_tokens: 40,
      },
    },
    uuid: 'b0000000-0000-4000-8000-000000000002',
    timestamp: '2026-04-02T00:00:03.000Z',
  }),
];

const depth2Transcript = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: DEPTH2_HEX,
    type: 'user',
    message: { role: 'user', content: 'Synthetic depth-2 grandchild task.' },
    uuid: 'c0000000-0000-4000-8000-000000000001',
    timestamp: '2026-04-02T00:00:04.000Z',
  }),
  jsonLine({
    parentUuid: 'c0000000-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: DEPTH2_HEX,
    type: 'assistant',
    message: {
      id: 'msg_synth_d2sync_d2_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 15,
      },
    },
    uuid: 'c0000000-0000-4000-8000-000000000002',
    timestamp: '2026-04-02T00:00:05.000Z',
  }),
];

// Sidecar for the depth-1 agent: its toolUseId is the main's spawn block.
const depth1Meta = [
  jsonLine({
    agentType: 'depth1-agent',
    description: 'depth-1 dispatch',
    toolUseId: TOOL_USE_D1,
    spawnDepth: 1,
  }),
];

// Sidecar for the depth-2 grandchild: its toolUseId is the depth-1 spawn block,
// which lives inside the depth-1 transcript — anchoring the grandchild to it.
const depth2Meta = [
  jsonLine({
    agentType: 'grandchild-agent',
    description: 'depth-2 grandchild',
    toolUseId: TOOL_USE_D2,
    spawnDepth: 2,
  }),
];

export const depth2Sync: Fixture = {
  name: 'depth-2-sync',
  description:
    'Self-referential parent (gate #4) via synchronous tool_use spawns anchored by .meta.json ' +
    'sidecars: the depth-2 grandchild anchors to the depth-1 agent (whose transcript owns the ' +
    'depth-2 Agent block), not to the main root; the depth-1 agent anchors to the main session.',
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    { relativePath: `subagents/agent-${DEPTH1_HEX}.jsonl`, lines: depth1Transcript },
    { relativePath: `subagents/agent-${DEPTH1_HEX}.meta.json`, lines: depth1Meta },
    { relativePath: `subagents/agent-${DEPTH2_HEX}.jsonl`, lines: depth2Transcript },
    { relativePath: `subagents/agent-${DEPTH2_HEX}.meta.json`, lines: depth2Meta },
  ],
};
