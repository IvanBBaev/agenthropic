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
    expect(insertTokenUsageRows(temp.db, sessionId, messages)).toEqual({
      inserted: 10,
      corrected: 0,
    });
    const count = temp.db.prepare('SELECT COUNT(*) AS n FROM token_usage').get() as { n: number };
    expect(count.n).toBe(10);
  });

  it('re-inserting the same deduped set inserts zero new rows and corrects nothing', () => {
    expect(insertTokenUsageRows(temp.db, sessionId, messages)).toEqual({
      inserted: 10,
      corrected: 0,
    });
    expect(insertTokenUsageRows(temp.db, sessionId, messages)).toEqual({
      inserted: 0,
      corrected: 0,
    });
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

    // A main-transcript row carries `agentId: null` in core (the substrate has
    // no agent-<hex> file for the main turn), but the main agent IS a
    // materialized node whose id is the session id - so it is persisted
    // attributed, never as an orphan the tree has to report as unattributed.
    const inputMain = temp.db
      .prepare('SELECT tokens, agent_id FROM token_usage WHERE message_id = ? AND bucket = ?')
      .get('msg-main', 'input') as { tokens: number; agent_id: string | null };
    expect(inputMain).toEqual({ tokens: 100, agent_id: sessionId });
  });

  /**
   * parser-spec 5.2 convergence: a session file re-read while an assistant turn
   * is still streaming yields a mid-stream partial; the next poll yields the
   * settled turn under the SAME message id. The persisted state must converge
   * on what dedupeUsageByMessageId computes over the complete file - per-bucket
   * maximum, model settled to the row carrying the greatest `output`.
   */
  describe('streaming correction (parser-spec 5.2)', () => {
    const streamed = (
      model: string,
      usage: DedupedUsage['usage'],
    ): DedupedUsage & { readonly usage: DedupedUsage['usage'] } => ({
      messageId: 'msg-stream',
      model,
      timestamp: '2026-07-11T10:00:10Z',
      agentId: 'deadbeef',
      usage,
    });

    /** Poll N: first block only, still carrying the transient fast-mode label. */
    const partial = streamed('claude-fable-5', {
      input: 4,
      output: 7,
      cacheRead: 100,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    /** Poll N+1: the same message settled - greater output, settled model. */
    const settled = streamed('claude-opus-4-8', {
      input: 4,
      output: 309,
      cacheRead: 100,
      cacheWrite5m: 12,
      cacheWrite1h: 0,
    });

    const readMessage = (
      messageId: string,
    ): Array<{ bucket: string; tokens: number; model: string }> =>
      temp.db
        .prepare(
          `SELECT bucket, tokens, model FROM token_usage WHERE message_id = ? ORDER BY bucket`,
        )
        .all(messageId) as Array<{ bucket: string; tokens: number; model: string }>;

    it('raises every bucket to its maximum and settles the model on the fuller read', () => {
      expect(insertTokenUsageRows(temp.db, sessionId, [partial])).toEqual({
        inserted: 5,
        corrected: 0,
      });
      // All five rows change: three by tokens, all five by the settled model.
      expect(insertTokenUsageRows(temp.db, sessionId, [settled])).toEqual({
        inserted: 0,
        corrected: 5,
      });

      expect(readMessage('msg-stream')).toEqual([
        { bucket: 'cache_read', tokens: 100, model: 'claude-opus-4-8' },
        { bucket: 'cache_write_1h', tokens: 0, model: 'claude-opus-4-8' },
        { bucket: 'cache_write_5m', tokens: 12, model: 'claude-opus-4-8' },
        { bucket: 'input', tokens: 4, model: 'claude-opus-4-8' },
        { bucket: 'output', tokens: 309, model: 'claude-opus-4-8' },
      ]);
    });

    it('never regresses a settled row when a stale partial is replayed', () => {
      insertTokenUsageRows(temp.db, sessionId, [partial]);
      insertTokenUsageRows(temp.db, sessionId, [settled]);

      expect(insertTokenUsageRows(temp.db, sessionId, [partial])).toEqual({
        inserted: 0,
        corrected: 0,
      });

      expect(readMessage('msg-stream')).toEqual([
        { bucket: 'cache_read', tokens: 100, model: 'claude-opus-4-8' },
        { bucket: 'cache_write_1h', tokens: 0, model: 'claude-opus-4-8' },
        { bucket: 'cache_write_5m', tokens: 12, model: 'claude-opus-4-8' },
        { bucket: 'input', tokens: 4, model: 'claude-opus-4-8' },
        { bucket: 'output', tokens: 309, model: 'claude-opus-4-8' },
      ]);
    });

    it('raises a non-output bucket without smearing an unsettled model across the message', () => {
      insertTokenUsageRows(temp.db, sessionId, [settled]);
      // Same output (not a fuller turn) but a bigger cache read: the bucket
      // maximum still applies, while the settled model is left alone.
      const sameOutputBiggerCache = streamed('claude-fable-5', {
        ...settled.usage,
        cacheRead: 900,
      });

      expect(insertTokenUsageRows(temp.db, sessionId, [sameOutputBiggerCache])).toEqual({
        inserted: 0,
        corrected: 1,
      });

      const rows = readMessage('msg-stream');
      expect(rows.find((r) => r.bucket === 'cache_read')).toEqual({
        bucket: 'cache_read',
        tokens: 900,
        model: 'claude-opus-4-8',
      });
      expect(rows.every((r) => r.model === 'claude-opus-4-8')).toBe(true);
    });

    it('backfills main-agent attribution onto rows a previous version left NULL', () => {
      // Exactly what the pre-fix writer produced: all five buckets, agent_id NULL.
      const legacy = temp.db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
         VALUES (?, NULL, 'msg-main', 'claude-opus-4-6', ?, ?, 0, '2026-07-11T10:00:00Z')`,
      );
      const legacyTokens: Record<string, number> = {
        input: 100,
        output: 200,
        cache_read: 300,
        cache_write_5m: 0,
        cache_write_1h: 0,
      };
      for (const [bucket, tokens] of Object.entries(legacyTokens)) {
        legacy.run(sessionId, bucket, tokens);
      }

      const mainMessage = messages[0] as DedupedUsage;
      expect(insertTokenUsageRows(temp.db, sessionId, [mainMessage])).toEqual({
        inserted: 0,
        corrected: 5,
      });

      const rows = readMessage('msg-main');
      expect(rows.every((r) => r.model === 'claude-opus-4-6')).toBe(true);
      const attributed = temp.db
        .prepare(
          'SELECT COUNT(*) AS n FROM token_usage WHERE message_id = ? AND agent_id IS NOT NULL',
        )
        .get('msg-main') as { n: number };
      expect(attributed.n).toBe(5);
    });
  });
});
