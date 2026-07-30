import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DedupedUsage } from '@agenthropic/core';
import { insertTokenUsageRows } from '../src/db/token-usage';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

describe('insertTokenUsageRows (WP-D8 / LONG token_usage matrix)', () => {
  let temp: TempDb;
  const sessionId = 'sess-tokens';

  const messages: DedupedUsage[] = [
    {
      messageId: 'msg-main',
      model: 'claude-opus-4-6',
      timestamp: '2026-07-11T10:00:00Z',
      agentId: null,
      usage: {
        input: 100,
        output: 200,
        cacheRead: 300,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    },
    {
      messageId: 'msg-sub',
      model: 'claude-sonnet-4-6',
      timestamp: '2026-07-11T10:00:05Z',
      agentId: 'deadbeef',
      usage: {
        input: 11,
        output: 22,
        cacheRead: 33,
        cacheWrite5m: 44,
        cacheWrite1h: 55,
      },
    },
  ];

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, sessionId);
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('fans each message out to five bucket rows (2 messages x 5 buckets = 10)', () => {
    expect(insertTokenUsageRows(temp.db, sessionId, messages)).toEqual({ inserted: 10 });
    const count = temp.db.prepare('SELECT COUNT(*) AS n FROM token_usage').get() as { n: number };
    expect(count.n).toBe(10);
  });

  it('re-inserting the same deduped set inserts zero new rows (idempotent)', () => {
    expect(insertTokenUsageRows(temp.db, sessionId, messages)).toEqual({ inserted: 10 });
    expect(insertTokenUsageRows(temp.db, sessionId, messages)).toEqual({ inserted: 0 });
    const count = temp.db.prepare('SELECT COUNT(*) AS n FROM token_usage').get() as { n: number };
    expect(count.n).toBe(10);
  });

  it('stores the correct tokens/agent_id/model for a spot bucket row', () => {
    insertTokenUsageRows(temp.db, sessionId, messages);

    const cacheReadSub = temp.db
      .prepare(
        `SELECT tokens, agent_id, model, session_id, is_compaction_baseline, occurred_at
         FROM token_usage WHERE message_id = ? AND bucket = ?`,
      )
      .get('msg-sub', 'cache_read') as {
      tokens: number;
      agent_id: string | null;
      model: string;
      session_id: string;
      is_compaction_baseline: number;
      occurred_at: string;
    };

    expect(cacheReadSub).toEqual({
      tokens: 33,
      agent_id: 'deadbeef',
      model: 'claude-sonnet-4-6',
      session_id: sessionId,
      is_compaction_baseline: 0,
      occurred_at: '2026-07-11T10:00:05Z',
    });

    const inputMain = temp.db
      .prepare('SELECT tokens, agent_id FROM token_usage WHERE message_id = ? AND bucket = ?')
      .get('msg-main', 'input') as { tokens: number; agent_id: string | null };
    expect(inputMain).toEqual({ tokens: 100, agent_id: null });
  });
});
