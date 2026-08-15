/**
 * Fixture `legacy-bare-explore` — parser-spec section 3, gate #7.
 *
 * The pre-2.1.71 (CC <= 2.1.70) legacy shape: the child's
 * `agent-<hex>.meta.json` sidecar is BARE — exactly `{agentType: 'Explore'}`,
 * no `toolUseId`, no `spawnDepth` — and the main transcript carries NO modern
 * anchor at all (no `Agent`/`Workflow` tool_use block, no queue-operation, no
 * parent-side `toolUseResult`, no `<task-notification>`). The only join key is
 * the child hex appearing as the RAW top-level `agentId` of a `progress`
 * record in the main transcript ("join via raw agentId in parent progress
 * lines", phase0-probe). The parser must anchor the child to the main agent
 * with the DISTINCT `legacy_explore` provenance instead of orphaning it.
 *
 * Two deliberate traps guard the fallback's narrowness:
 * - the main progress record ALSO nests a decoy `data.agentId` naming a hex
 *   that is not an agent — a parser that scanned nested payloads instead of
 *   the structural top-level field would index the decoy (gate #5 spirit:
 *   position, never payload/substring);
 * - the child transcript carries a progress record with its OWN `agentId`,
 *   which must not register the child as its own spawner.
 *
 * The shape is absent from the current corpus (2 files were observed in the
 * phase-0 probe, none retained), so this synthetic reconstruction is
 * PROVISIONAL until a real pre-2.1.71 transcript ratifies it.
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

/** The legacy child's agent hex — the raw progress-line join key. */
export const LEGACY_CHILD_HEX = '0b501e7e';

/** Nested-payload decoy: names no agent file, must never be indexed. */
export const LEGACY_DECOY_HEX = 'deadfa11';

const mainTranscript = [
  jsonLine({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/synthetic/project',
    sessionId: SESSION_ID,
    version: '2.1.70',
    type: 'user',
    message: {
      role: 'user',
      content: 'Synthetic user prompt: explore the legacy widget module.',
    },
    uuid: 'dddddddd-0000-4000-8000-000000000001',
    timestamp: '2026-01-18T10:00:00.000Z',
  }),
  jsonLine({
    parentUuid: 'dddddddd-0000-4000-8000-000000000001',
    isSidechain: false,
    sessionId: SESSION_ID,
    version: '2.1.70',
    type: 'assistant',
    message: {
      id: 'msg_synth_legacy_parent_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      // NO tool_use block: the 2.1.70 layout left no parent-side spawn block
      // to anchor to, which is exactly why gate #7 exists.
      content: [{ type: 'text', text: 'Dispatching an Explore subagent the legacy way.' }],
      usage: {
        input_tokens: 40,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 900,
        output_tokens: 55,
      },
    },
    uuid: 'dddddddd-0000-4000-8000-000000000002',
    timestamp: '2026-01-18T10:00:04.000Z',
  }),
  jsonLine({
    parentUuid: 'dddddddd-0000-4000-8000-000000000002',
    isSidechain: false,
    sessionId: SESSION_ID,
    version: '2.1.70',
    type: 'progress',
    // The join key: the RAW top-level agentId names the spawned child. The
    // nested data.agentId is a decoy — structurally positioned joins must read
    // ONLY the top-level field.
    agentId: LEGACY_CHILD_HEX,
    data: {
      type: 'agent_progress',
      agentId: LEGACY_DECOY_HEX,
      message: `Exploring; prose mention of agent ${LEGACY_DECOY_HEX} must not forge a join.`,
    },
    uuid: 'dddddddd-0000-4000-8000-000000000003',
    timestamp: '2026-01-18T10:00:06.000Z',
  }),
];

const childTranscript = [
  jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    version: '2.1.70',
    agentId: LEGACY_CHILD_HEX,
    type: 'user',
    // Plain-string content with NO <task-notification> tags: the modern
    // child-side recovery path must miss so only the legacy join remains.
    message: {
      role: 'user',
      content: 'Synthetic legacy Explore task: map the widget module.',
    },
    uuid: 'eeeeeeee-0000-4000-8000-000000000001',
    timestamp: '2026-01-18T10:00:07.000Z',
  }),
  jsonLine({
    parentUuid: 'eeeeeeee-0000-4000-8000-000000000001',
    isSidechain: true,
    sessionId: SESSION_ID,
    version: '2.1.70',
    // A transcript's own progress line carries its OWN agentId — this must
    // never register the child as its own spawner.
    agentId: LEGACY_CHILD_HEX,
    type: 'progress',
    data: { type: 'agent_progress', message: 'Scanning the widget module.' },
    uuid: 'eeeeeeee-0000-4000-8000-000000000002',
    timestamp: '2026-01-18T10:00:08.000Z',
  }),
  jsonLine({
    parentUuid: 'eeeeeeee-0000-4000-8000-000000000002',
    isSidechain: true,
    sessionId: SESSION_ID,
    version: '2.1.70',
    agentId: LEGACY_CHILD_HEX,
    type: 'assistant',
    message: {
      id: 'msg_synth_legacy_child_0001',
      type: 'message',
      role: 'assistant',
      model: 'synthetic-model-a',
      content: [{ type: 'text', text: 'Synthetic result: widget module mapped.' }],
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 250,
        cache_read_input_tokens: 0,
        output_tokens: 30,
      },
    },
    uuid: 'eeeeeeee-0000-4000-8000-000000000003',
    timestamp: '2026-01-18T10:00:10.000Z',
  }),
];

// The pre-2.1.71 sidecar is EXACTLY this bare shape (phase0-probe): agentType
// only — no toolUseId, no spawnDepth, no description. The parser's legacy
// detection is key-presence based, so nothing may be added here.
const childMeta = [jsonLine({ agentType: 'Explore' })];

export const legacyBareExplore: Fixture = {
  name: 'legacy-bare-explore',
  description:
    'Gate #7 legacy shape (CC <= 2.1.70): bare {agentType: "Explore"} sidecar with no ' +
    'toolUseId/spawnDepth and no modern anchor anywhere; the child joins to the main agent ' +
    'via its raw top-level agentId on a main-transcript progress record, yielding an edge ' +
    'with the DISTINCT legacy_explore provenance. Includes a nested data.agentId decoy and ' +
    'a self-agentId child progress line to pin the fallback to its narrowest reading.',
  files: [
    { relativePath: `${SESSION_ID}.jsonl`, lines: mainTranscript },
    { relativePath: `subagents/agent-${LEGACY_CHILD_HEX}.jsonl`, lines: childTranscript },
    { relativePath: `subagents/agent-${LEGACY_CHILD_HEX}.meta.json`, lines: childMeta },
  ],
};
