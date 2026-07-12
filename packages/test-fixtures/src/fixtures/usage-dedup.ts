/**
 * Fixture `usage-dedup` — parser-spec section 5.2, correctness gate N3.
 *
 * Claude Code writes one JSONL line per content block, and every line sharing
 * a `message.id` carries a byte-identical `usage` block. This fixture has 6
 * usage-bearing lines but only 4 distinct message ids: 3 lines share
 * `msg_synth_dup_0001` with identical usage (the over-count case). Two models
 * are present, and the dominant buckets are cache reads — a flat per-token
 * rate would misprice them (section 5.4).
 */
import { type Fixture, jsonLine } from './types.js';

const SESSION_ID = '55555555-6666-4777-8888-999999999999';
const AGENT_HEX = 'facade07';

export const DUPLICATED_MESSAGE_ID = 'msg_synth_dup_0001';

/** The single usage block shared byte-identically by the 3 duplicate lines. */
const DUP_USAGE = {
  input_tokens: 8,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 52000,
  output_tokens: 310,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
};

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
  // Three lines, one message: identical message.id, byte-identical usage.
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000001',
    timestamp: '2026-01-19T11:00:01.000Z',
    messageId: DUPLICATED_MESSAGE_ID,
    model: 'synthetic-model-a',
    usage: DUP_USAGE,
    blockIndex: 1,
  }),
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000002',
    timestamp: '2026-01-19T11:00:01.100Z',
    messageId: DUPLICATED_MESSAGE_ID,
    model: 'synthetic-model-a',
    usage: DUP_USAGE,
    blockIndex: 2,
  }),
  usageLine({
    uuid: '66666666-0000-4000-8000-000000000003',
    timestamp: '2026-01-19T11:00:01.200Z',
    messageId: DUPLICATED_MESSAGE_ID,
    model: 'synthetic-model-a',
    usage: DUP_USAGE,
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
    'share msg_synth_dup_0001 with byte-identical usage blocks (naive row-summation ' +
    'over-counts 3x on that message). Two models; cache_read-heavy buckets dominate.',
  files: [{ relativePath: `subagents/agent-${AGENT_HEX}.jsonl`, lines: childLines }],
};
