/**
 * Fixtures `concurrent-instance-a` and `concurrent-instance-b` — WP-X1
 * pathology "same-slug concurrency" (parser-spec section 1, gate #9, §6.2):
 * two Claude Code instances running at the same time in the SAME project.
 *
 * A fixture is one session, so the pathology is a PAIR of fixtures, meant to
 * be materialized side by side under one project slug (both carry the same
 * `cwd`, so Claude Code would file them under the same
 * `~/.claude/projects/<slug>/` directory). They are deliberately built to be
 * as easy to fuse as a wrong key allows:
 *
 * - same `cwd` / slug, same Claude Code version, same models;
 * - wall-clock INTERLEAVED — every record of one instance falls between two
 *   records of the other, and the two sessions overlap for their whole life;
 * - each dispatches one flat `Agent` subagent with the SAME `subagent_type`,
 *   the SAME prompt text and the SAME sidecar description, and the two spawn
 *   blocks are issued 2 ms apart — inside the ~10 ms "same dispatch wave"
 *   window of parser-spec §6.3, so a slug-keyed or time-keyed grouping would
 *   happily treat the two subagents as siblings of one tree.
 *
 * What stays disjoint is exactly what real concurrent sessions keep disjoint:
 * the session uuid, the agent hexes, the tool_use ids, the message ids and
 * the record uuids. The correct answer is TWO independent roots, each with
 * one child, zero cross-session edges (§6.2: "keying on slug would fuse ...
 * into one phantom tree; keying on session-uuid keeps them apart").
 *
 * Both sessions end with the spawn answered and a closing assistant turn, so
 * this pair isolates concurrency from the crash pathology (`crashed-no-stop`).
 * All content is SYNTHETIC — invented ids, hex, timestamps and prose.
 */
import { type Fixture, jsonLine } from './types.js';

/** The shared project directory both instances run in (one slug on disk). */
export const CONCURRENT_CWD = '/home/synthetic/shared-project';

export const CONCURRENT_A_SESSION_ID = 'c0c0a000-1111-4222-8333-444444444444';
export const CONCURRENT_B_SESSION_ID = 'c0c0b000-1111-4222-8333-444444444444';
export const CONCURRENT_A_AGENT_ID = 'c0c0a001';
export const CONCURRENT_B_AGENT_ID = 'c0c0b001';

/** Identical task text in both instances — content must never be a join key. */
const SHARED_TASK = 'Synthetic subagent task: audit the sprocket registry.';

interface InstanceSpec {
  readonly name: 'concurrent-instance-a' | 'concurrent-instance-b';
  readonly sessionId: string;
  readonly agentHex: string;
  /** Short letter used to make every per-instance id distinct. */
  readonly tag: 'A' | 'B';
  /** Record uuid prefix (8 hex chars) for the main transcript. */
  readonly mainUuid: string;
  /** Record uuid prefix (8 hex chars) for the child transcript. */
  readonly childUuid: string;
  /** Six strictly increasing timestamps: prompt, spawn, child start, child end, result, close. */
  readonly times: readonly [string, string, string, string, string, string];
}

function uuid(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function buildInstance(spec: InstanceSpec): Fixture {
  const spawnId = `toolu_01SynthConcurrent${spec.tag}Spawn`;
  const [tPrompt, tSpawn, tChildStart, tChildEnd, tResult, tClose] = spec.times;

  const mainTranscript = [
    jsonLine({
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: CONCURRENT_CWD,
      sessionId: spec.sessionId,
      version: '2.0.0',
      type: 'user',
      message: {
        role: 'user',
        content: 'Synthetic user prompt: have a subagent audit the sprocket registry.',
      },
      uuid: uuid(spec.mainUuid, 1),
      timestamp: tPrompt,
    }),
    jsonLine({
      parentUuid: uuid(spec.mainUuid, 1),
      isSidechain: false,
      cwd: CONCURRENT_CWD,
      sessionId: spec.sessionId,
      version: '2.0.0',
      type: 'assistant',
      message: {
        id: `msg_synth_concurrent_${spec.tag}_parent_0001`,
        type: 'message',
        role: 'assistant',
        model: 'synthetic-model-a',
        content: [
          {
            type: 'tool_use',
            id: spawnId,
            name: 'Agent',
            input: { prompt: SHARED_TASK, subagent_type: 'general-purpose' },
          },
        ],
        usage: {
          input_tokens: 40,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000,
          output_tokens: 50,
        },
      },
      uuid: uuid(spec.mainUuid, 2),
      timestamp: tSpawn,
    }),
    jsonLine({
      parentUuid: uuid(spec.mainUuid, 2),
      isSidechain: false,
      cwd: CONCURRENT_CWD,
      sessionId: spec.sessionId,
      version: '2.0.0',
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: spawnId,
            content: 'Synthetic result: the sprocket registry is consistent.',
          },
        ],
      },
      uuid: uuid(spec.mainUuid, 3),
      timestamp: tResult,
    }),
    jsonLine({
      parentUuid: uuid(spec.mainUuid, 3),
      isSidechain: false,
      cwd: CONCURRENT_CWD,
      sessionId: spec.sessionId,
      version: '2.0.0',
      type: 'assistant',
      message: {
        id: `msg_synth_concurrent_${spec.tag}_parent_0002`,
        type: 'message',
        role: 'assistant',
        model: 'synthetic-model-a',
        content: [{ type: 'text', text: 'The audit is done; the registry is consistent.' }],
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1050,
          output_tokens: 15,
        },
      },
      uuid: uuid(spec.mainUuid, 4),
      timestamp: tClose,
    }),
  ];

  const childLines = [
    jsonLine({
      parentUuid: null,
      isSidechain: true,
      cwd: CONCURRENT_CWD,
      sessionId: spec.sessionId,
      version: '2.0.0',
      agentId: spec.agentHex,
      type: 'user',
      message: { role: 'user', content: SHARED_TASK },
      uuid: uuid(spec.childUuid, 1),
      timestamp: tChildStart,
    }),
    jsonLine({
      parentUuid: uuid(spec.childUuid, 1),
      isSidechain: true,
      cwd: CONCURRENT_CWD,
      sessionId: spec.sessionId,
      version: '2.0.0',
      agentId: spec.agentHex,
      type: 'assistant',
      message: {
        id: `msg_synth_concurrent_${spec.tag}_child_0001`,
        type: 'message',
        role: 'assistant',
        model: 'synthetic-model-b',
        content: [{ type: 'text', text: 'Synthetic result: the sprocket registry is consistent.' }],
        usage: {
          input_tokens: 11,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 0,
          output_tokens: 17,
        },
      },
      uuid: uuid(spec.childUuid, 2),
      timestamp: tChildEnd,
    }),
  ];

  const childMeta = [
    jsonLine({
      agentType: 'general-purpose',
      description: SHARED_TASK,
      toolUseId: spawnId,
      spawnDepth: 1,
    }),
  ];

  return {
    name: spec.name,
    description:
      `WP-X1 pathology same-slug concurrency, instance ${spec.tag} of 2: one of two sessions ` +
      'running at the same time in the same project (same cwd/slug, interleaved timestamps, ' +
      'identical subagent prompt and type, spawns 2 ms apart). Flat layout, base join path 1. ' +
      'Keyed on session uuid the pair is two independent roots with one child each.',
    files: [
      { relativePath: `${spec.sessionId}.jsonl`, lines: mainTranscript },
      { relativePath: `subagents/agent-${spec.agentHex}.jsonl`, lines: childLines },
      { relativePath: `subagents/agent-${spec.agentHex}.meta.json`, lines: childMeta },
    ],
  };
}

// Interleaving: A prompt < B prompt < A spawn < B spawn (2 ms later) < A child
// start < B child start < ... < A close < B close. Every record of one
// instance sits between two records of the other.
export const concurrentInstanceA: Fixture = buildInstance({
  name: 'concurrent-instance-a',
  sessionId: CONCURRENT_A_SESSION_ID,
  agentHex: CONCURRENT_A_AGENT_ID,
  tag: 'A',
  mainUuid: 'c0c0a0a0',
  childUuid: 'c0c0a1a1',
  times: [
    '2026-01-22T15:00:00.000Z',
    '2026-01-22T15:00:04.000Z',
    '2026-01-22T15:00:05.000Z',
    '2026-01-22T15:00:09.000Z',
    '2026-01-22T15:00:11.000Z',
    '2026-01-22T15:00:13.000Z',
  ],
});

export const concurrentInstanceB: Fixture = buildInstance({
  name: 'concurrent-instance-b',
  sessionId: CONCURRENT_B_SESSION_ID,
  agentHex: CONCURRENT_B_AGENT_ID,
  tag: 'B',
  mainUuid: 'c0c0b0b0',
  childUuid: 'c0c0b1b1',
  times: [
    '2026-01-22T15:00:01.000Z',
    '2026-01-22T15:00:04.002Z',
    '2026-01-22T15:00:05.002Z',
    '2026-01-22T15:00:10.000Z',
    '2026-01-22T15:00:12.000Z',
    '2026-01-22T15:00:14.000Z',
  ],
});
