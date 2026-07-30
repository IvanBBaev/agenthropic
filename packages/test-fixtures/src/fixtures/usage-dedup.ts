/**
 * Fixture `usage-dedup` — parser-spec section 5.2, correctness gate N3.
 *
 * Claude Code writes one JSONL line per content block, and lines sharing a
 * `message.id` are STREAMED PARTIALS of one message: `input` and the cache
 * buckets are constant across them while `output_tokens` grows toward the final
 * total. This fixture has 6 usage-bearing lines but only 4 distinct message
 * ids: 3 lines share `msg_synth_dup_0001` with constant input/cache and
 * `output_tokens` streaming 7 -> 7 -> 310 (the final, complete value). Dedup
 * must collapse them to the per-bucket maximum (output 310, cache_read 52000),
 * NOT sum. Two models are present, and the dominant buckets are cache reads — a
 * flat per-token rate would misprice them (section 5.4).
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '55555555-6666-4777-8888-999999999999';
const AGENT_HEX = 'facade07';

export const DUPLICATED_MESSAGE_ID = 'msg_synth_dup_0001';

/** Constant (non-output) buckets shared by the 3 streamed partials. */
const DUP_USAGE_BASE = {
  input_tokens: 8,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 52000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
};

/** One streamed partial: constant buckets + the growing `output_tokens`. */
function dupUsage(outputTokens: number): Record<string, unknown> {
  return { ...DUP_USAGE_BASE, output_tokens: outputTokens };
}

function usageLine(opts: {
  uuid: string;
  timestamp: string;
  messageId: string;
  model: string;
  usage: Record<string, unknown>;
  blockIndex: number;
}): string {
  return jsonLine({
    parentUuid: null,
    isSidechain: true,
    sessionId: SESSION_ID,
    agentId: AGENT_HEX,
    type: 'assistant',
    message: {
      id: opts.messageId,
      type: 'message',
      role: 'assistant',
      model: opts.model,
      content: [{ type: 'text', text: `Synthetic content block ${opts.blockIndex}.` }],
      usage: opts.usage,
    },
    uuid: opts.uuid,
    timestamp: opts.timestamp,
  });
}

const childLines = [
  // Three lines, one message: same message.id, constant input/cache, and
  // output_tokens streaming 7 -> 7 -> 310 (the final row carries the total).
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000001',
    timestamp: '2026-01-19T11:00:01.000Z',
    messageId: DUPLICATED_MESSAGE_ID,
    model: 'synthetic-model-a',
    usage: dupUsage(7),
    blockIndex: 1,
  }),
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000002',
    timestamp: '2026-01-19T11:00:01.100Z',
    messageId: DUPLICATED_MESSAGE_ID,
    model: 'synthetic-model-a',
    usage: dupUsage(7),
    blockIndex: 2,
  }),
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000003',
    timestamp: '2026-01-19T11:00:01.200Z',
    messageId: DUPLICATED_MESSAGE_ID,
    model: 'synthetic-model-a',
    usage: dupUsage(310),
    blockIndex: 3,
  }),
  // Distinct message on the same model, cache-read heavy.
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000004',
    timestamp: '2026-01-19T11:00:05.000Z',
    messageId: 'msg_synth_uniq_0002',
    model: 'synthetic-model-a',
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 48000,
      output_tokens: 95,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    },
    blockIndex: 1,
  }),
  // Second model, cache-write heavy (5m bucket).
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000005',
    timestamp: '2026-01-19T11:00:09.000Z',
    messageId: 'msg_synth_uniq_0003',
    model: 'synthetic-model-b',
    usage: {
      input_tokens: 640,
      cache_creation_input_tokens: 15000,
      cache_read_input_tokens: 0,
      output_tokens: 210,
      cache_creation: { ephemeral_5m_input_tokens: 15000, ephemeral_1h_input_tokens: 0 },
    },
    blockIndex: 1,
  }),
  // Second model, cache-read heavy again.
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000006',
    timestamp: '2026-01-19T11:00:12.000Z',
    messageId: 'msg_synth_uniq_0004',
    model: 'synthetic-model-b',
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 61000,
      output_tokens: 44,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    },
    blockIndex: 1,
  }),
];

export const usageDedup: Fixture = {
  name: 'usage-dedup',
  description:
    'N3 usage-dedup case: 6 usage-bearing JSONL lines, 4 distinct message.ids — 3 lines ' +
    'share msg_synth_dup_0001 as streamed partials (constant input/cache, output_tokens ' +
    '7->7->310); per-bucket-max dedup yields output 310, naive summation over-counts. ' +
    'Two models; cache_read-heavy buckets dominate.',
  files: [{ relativePath: `subagents/agent-${AGENT_HEX}.jsonl`, lines: childLines }],
};
