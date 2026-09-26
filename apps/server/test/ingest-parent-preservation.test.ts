/**
 * A re-parse must never erase a parent the store already knows.
 *
 * Every poll re-reads a session's files in full, but "in full" means "every
 * file the substrate walk could read THIS pass". A main transcript that grows
 * past `maxFileBytes`, turns EACCES, or is caught mid-rewrite is skipped for
 * that pass while its subagents still ingest. The parser then resolves each
 * child's parent to the session id (the main agent), the normalizer finds no
 * main node emitted in this pass and — correctly, for FK safety — nulls the
 * parent. Overwriting the stored row with that null would turn a known parent
 * relation into a root, i.e. the subagent tree would lose a data fact because
 * one pass could not see it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PricingEntry } from '@agenthropic/core';
import { ingestSession, loadPricing } from '../src/index';
import type { IngestDeps } from '../src/index';
import { createMigratedTempDb, type TempDb } from './helpers';

const SESSION = 'synthetic-parent-session';
const CHILD = 'cafe0001';
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;
const PRICING: readonly PricingEntry[] = BUCKETS.map((bucket) => ({
  model: 'synthetic-model-a',
  bucket,
  usdPerMtok: 1,
  effectiveFrom: '2020-01-01',
}));

function record(agentId: string | null, second: number, messageId: string): string[] {
  const base = agentId === null ? { sessionId: SESSION } : { sessionId: SESSION, agentId };
  return [
    JSON.stringify({
      ...base,
      type: 'user',
      timestamp: `2026-05-01T00:00:0${String(second)}.000Z`,
      message: { role: 'user', content: 'x' },
    }),
    JSON.stringify({
      ...base,
      type: 'assistant',
      timestamp: `2026-05-01T00:00:0${String(second + 1)}.000Z`,
      message: { id: messageId, model: 'synthetic-model-a', usage: { input_tokens: 1 } },
    }),
  ];
}

const MAIN_FILE = { relativePath: `${SESSION}.jsonl`, lines: record(null, 0, 'm_main') };
// A workflow subagent joins by directory: its parent is the main agent.
const CHILD_FILE = {
  relativePath: `workflows/wf_one/agent-${CHILD}.jsonl`,
  lines: record(CHILD, 2, 'm_child'),
};

describe('agent upsert keeps a known parent across a partial re-parse', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function deps(): IngestDeps {
    return {
      db: temp.db,
      pricing: [...loadPricing(temp.db), ...PRICING],
      instance: 'local',
      hostId: 'test-host',
      projectSlug: 'test-slug',
      now: () => '2026-07-11T00:00:00.000Z',
    };
  }

  function parentOf(id: string): string | null {
    const row = temp.db
      .prepare('SELECT parent_agent_id AS parent FROM agents WHERE id = ?')
      .get(id) as {
      parent: string | null;
    };
    return row.parent;
  }

  it('does not null the stored parent when the main transcript is skipped on a later pass', () => {
    expect(ingestSession({ files: [MAIN_FILE, CHILD_FILE] }, deps()).ok).toBe(true);
    expect(parentOf(CHILD)).toBe(SESSION);

    // Pass 2: the main transcript was skipped (oversize / unreadable), so the
    // substrate carries the subagent alone — exactly what buildSessionSubstrate
    // hands over in that case.
    expect(ingestSession({ files: [CHILD_FILE] }, deps()).ok).toBe(true);

    expect(parentOf(CHILD)).toBe(SESSION);
  });

  it('restores nothing it did not know: a child first seen without its main stays a root', () => {
    expect(ingestSession({ files: [CHILD_FILE] }, deps()).ok).toBe(true);

    expect(parentOf(CHILD)).toBeNull();
  });
});
