import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { DedupedUsage } from '@agenthropic/core';
import { insertTokenUsageRows, ownsBefore } from '../src/db/token-usage';
import { ledgerEpoch } from '../src/db/ledger-epoch';
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
      crossSessionCollisions: 0,
      crossSessionMessageIds: [],
    });
    const count = temp.db.prepare('SELECT COUNT(*) AS n FROM token_usage').get() as { n: number };
    expect(count.n).toBe(10);
  });

  it('re-inserting the same deduped set inserts zero new rows and corrects nothing', () => {
    expect(insertTokenUsageRows(temp.db, sessionId, messages)).toEqual({
      inserted: 10,
      corrected: 0,
      crossSessionCollisions: 0,
      crossSessionMessageIds: [],
    });
    expect(insertTokenUsageRows(temp.db, sessionId, messages)).toEqual({
      inserted: 0,
      corrected: 0,
      crossSessionCollisions: 0,
      crossSessionMessageIds: [],
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
      // M-21: stored CANONICALLY, not verbatim. The fixture supplies
      // '2026-07-11T10:00:05Z' at second precision; the write path rewrites it
      // to millisecond precision so lexicographic order over this column and
      // chronological order coincide - which is what the priced CTE's
      // `mp.effective_from <= tu.occurred_at` assumes of BINARY-collated text.
      occurred_at: '2026-07-11T10:00:05.000Z',
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
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
      });
      // All five rows change: three by tokens, all five by the settled model.
      expect(insertTokenUsageRows(temp.db, sessionId, [settled])).toEqual({
        inserted: 0,
        corrected: 5,
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
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
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
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
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
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
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
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

  /**
   * M-12 ownership: a CLI resume/fork copies history lines VERBATIM into a new
   * session file, so the same message_id can arrive from two sessions. Exactly
   * one session owns it - the earlier-starting one, ties to the smaller id
   * (DAT-15) - whichever file is ingested first; the other copy is excluded
   * (never double-counted) and the collision is observable, never silent.
   */
  describe('cross-session message ownership (M-12 / DAT-15)', () => {
    // Lexicographically SMALLER than `sessionId` but starting LATER: every
    // case below that expects the original to own the message would fail if
    // the tie-break were consulted before the start time.
    const FORK_SESSION = 'sess-fork';
    const FORK_STARTED_AT = '2026-07-11T06:00:00Z';
    let warnSpy: MockInstance;

    const setStart = (db: TempDb['db'], id: string, startedAt: string | null): void => {
      db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(startedAt, id);
    };

    const ingestSeqOf = (db: TempDb['db'], id: string): number =>
      (db.prepare('SELECT ingest_seq AS seq FROM sessions WHERE id = ?').get(id) as { seq: number })
        .seq;

    const shared = (agentId: string | null, output: number): DedupedUsage => ({
      messageId: 'msg-shared',
      model: 'claude-opus-4-6',
      timestamp: '2026-07-11T12:00:00Z',
      agentId,
      usage: { input: 10, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    });

    const sumTokens = (db: TempDb['db']): number => {
      const row = db.prepare('SELECT COALESCE(SUM(tokens), 0) AS total FROM token_usage').get() as {
        total: number;
      };
      return row.total;
    };

    const ownerOf = (db: TempDb['db'], messageId: string): string => {
      const row = db
        .prepare(
          `SELECT session_id AS owner FROM token_usage WHERE message_id = ? AND bucket = 'output'`,
        )
        .get(messageId) as { owner: string };
      return row.owner;
    };

    beforeEach(() => {
      insertSession(temp.db, FORK_SESSION);
      setStart(temp.db, FORK_SESSION, FORK_STARTED_AT);
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('excludes a fork replay entirely: attribution stays with the owner, nothing double-counts', () => {
      expect(insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)])).toEqual({
        inserted: 5,
        corrected: 0,
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
      });

      // The fork's copy names a different agent — the exact rewrite the guard exists to refuse.
      expect(insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50)])).toEqual({
        inserted: 0,
        corrected: 0,
        crossSessionCollisions: 1,
        crossSessionMessageIds: ['msg-shared'],
      });

      expect(ownerOf(temp.db, 'msg-shared')).toBe(sessionId);
      const agents = temp.db
        .prepare('SELECT DISTINCT agent_id AS agentId FROM token_usage WHERE message_id = ?')
        .all('msg-shared') as Array<{ agentId: string }>;
      expect(agents).toEqual([{ agentId: 'agent-owner' }]);
      // Counted exactly once: 10 input + 50 output, the corpus ground truth.
      expect(sumTokens(temp.db)).toBe(60);
    });

    it('keeps global totals AND the owner identical under BOTH ingest orders', () => {
      // Order 1: original session first.
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);
      insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50)]);
      const totalOrder1 = sumTokens(temp.db);
      expect(ownerOf(temp.db, 'msg-shared')).toBe(sessionId);

      // Order 2: fork file discovered first. Before DAT-15 the fork became the
      // owner here; now the earlier-starting original takes the message over.
      const other = createMigratedTempDb();
      try {
        insertSession(other.db, sessionId);
        insertSession(other.db, FORK_SESSION);
        setStart(other.db, FORK_SESSION, FORK_STARTED_AT);
        insertTokenUsageRows(other.db, FORK_SESSION, [shared('agent-fork', 50)]);
        insertTokenUsageRows(other.db, sessionId, [shared('agent-owner', 50)]);
        expect(ownerOf(other.db, 'msg-shared')).toBe(sessionId);
        expect(sumTokens(other.db)).toBe(totalOrder1);
        const rows = (db: TempDb['db']): unknown[] =>
          db
            .prepare(
              `SELECT session_id, agent_id, message_id, model, bucket, tokens, occurred_at
                 FROM token_usage ORDER BY message_id, bucket`,
            )
            .all();
        expect(rows(other.db)).toEqual(rows(temp.db));
      } finally {
        other.cleanup();
      }
    });

    it('takes a message over from a later-starting owner: rows move, the old owner is stamped', () => {
      insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50)]);
      const forkSeqBefore = ingestSeqOf(temp.db, FORK_SESSION);
      const epochBefore = ledgerEpoch(temp.db);

      expect(insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)])).toEqual({
        inserted: 5,
        corrected: 0,
        crossSessionCollisions: 1,
        crossSessionMessageIds: [],
      });

      expect(ownerOf(temp.db, 'msg-shared')).toBe(sessionId);
      const agents = temp.db
        .prepare('SELECT DISTINCT agent_id AS agentId FROM token_usage WHERE message_id = ?')
        .all('msg-shared') as Array<{ agentId: string }>;
      expect(agents).toEqual([{ agentId: 'agent-owner' }]);
      expect(sumTokens(temp.db)).toBe(60);
      // The fork's totals just changed, so /api/changes must report it, and
      // the caches that ignore deletes must recompute.
      expect(ingestSeqOf(temp.db, FORK_SESSION)).toBeGreaterThan(forkSeqBefore);
      expect(ledgerEpoch(temp.db)).toBe(epochBefore + 1);

      // Converged: replaying either side changes nothing further.
      expect(insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50)])).toEqual({
        inserted: 0,
        corrected: 0,
        crossSessionCollisions: 1,
        crossSessionMessageIds: ['msg-shared'],
      });
      expect(insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)])).toEqual({
        inserted: 0,
        corrected: 0,
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
      });
      expect(ledgerEpoch(temp.db)).toBe(epochBefore + 1);
    });

    it('breaks a start-time tie by the smaller session id, in both orders', () => {
      // The common real case: a resumed file opens with the copied history, so
      // both sessions report the same start.
      setStart(temp.db, FORK_SESSION, '2026-07-11T00:00:00Z');
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);
      insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50)]);
      expect(ownerOf(temp.db, 'msg-shared')).toBe(FORK_SESSION);

      // The same instant spelled differently is still a tie: compared as an
      // instant, never as text.
      const other = createMigratedTempDb();
      try {
        insertSession(other.db, sessionId);
        insertSession(other.db, FORK_SESSION);
        setStart(other.db, FORK_SESSION, '2026-07-11T02:00:00+02:00');
        insertTokenUsageRows(other.db, FORK_SESSION, [shared('agent-fork', 50)]);
        insertTokenUsageRows(other.db, sessionId, [shared('agent-owner', 50)]);
        expect(ownerOf(other.db, 'msg-shared')).toBe(FORK_SESSION);
      } finally {
        other.cleanup();
      }
    });

    it('lets a known start precede an unknown one', () => {
      setStart(temp.db, sessionId, null);
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);
      insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50)]);
      expect(ownerOf(temp.db, 'msg-shared')).toBe(FORK_SESSION);

      // And the unknown start never takes the message back.
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);
      expect(ownerOf(temp.db, 'msg-shared')).toBe(FORK_SESSION);
    });

    it('never merges a larger foreign read — convergence MAX is within-session only', () => {
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);

      expect(insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 500)])).toEqual({
        inserted: 0,
        corrected: 0,
        crossSessionCollisions: 1,
        crossSessionMessageIds: ['msg-shared'],
      });

      const output = temp.db
        .prepare(`SELECT tokens FROM token_usage WHERE message_id = ? AND bucket = 'output'`)
        .get('msg-shared') as { tokens: number };
      expect(output.tokens).toBe(50);
    });

    it('surfaces the collision once, counts only — never message ids', () => {
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);
      expect(warnSpy).not.toHaveBeenCalled();

      insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50)]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = warnSpy.mock.calls[0]?.[0] as string;
      expect(line).toContain('skipped 1 message(s)');
      expect(line).toContain('took over 0 message(s)');
      expect(line).not.toContain('msg-shared');
      expect(line).not.toContain(FORK_SESSION);
    });

    it('surfaces a takeover in the same counts-only line', () => {
      insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50)]);
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = warnSpy.mock.calls[0]?.[0] as string;
      expect(line).toContain('skipped 0 message(s)');
      expect(line).toContain('took over 1 message(s)');
      expect(line).not.toContain('msg-shared');
      expect(line).not.toContain(sessionId);
    });

    it('lets the owner session keep converging freely after a foreign replay was excluded', () => {
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);
      insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 500)]);

      // The owner's own fuller read still settles the message. Exactly ONE row
      // moves: model and timestamp are unchanged, so of the five buckets only
      // `output` actually grows — the WHERE guard reports real UPDATEs, not
      // touched rows.
      expect(insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 309)])).toEqual({
        inserted: 0,
        corrected: 1,
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
      });

      const output = temp.db
        .prepare(`SELECT tokens FROM token_usage WHERE message_id = ? AND bucket = 'output'`)
        .get('msg-shared') as { tokens: number };
      expect(output.tokens).toBe(309);
    });

    it('skips only the colliding message, not the rest of the batch', () => {
      insertTokenUsageRows(temp.db, sessionId, [shared('agent-owner', 50)]);

      const fresh: DedupedUsage = {
        messageId: 'msg-fork-own',
        model: 'claude-opus-4-6',
        timestamp: '2026-07-11T12:05:00Z',
        agentId: 'agent-fork',
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      };
      expect(
        insertTokenUsageRows(temp.db, FORK_SESSION, [shared('agent-fork', 50), fresh]),
      ).toEqual({
        inserted: 5,
        corrected: 0,
        crossSessionCollisions: 1,
        crossSessionMessageIds: ['msg-shared'],
      });

      expect(ownerOf(temp.db, 'msg-fork-own')).toBe(FORK_SESSION);
      expect(ownerOf(temp.db, 'msg-shared')).toBe(sessionId);
    });
  });

  describe('ownsBefore (DAT-15 ownership order)', () => {
    it('orders by start, then known before unknown, then by id', () => {
      expect(ownsBefore({ start: 1, id: 'b' }, { start: 2, id: 'a' })).toBe(true);
      expect(ownsBefore({ start: 2, id: 'a' }, { start: 1, id: 'b' })).toBe(false);
      expect(ownsBefore({ start: 5, id: 'z' }, { start: null, id: 'a' })).toBe(true);
      expect(ownsBefore({ start: null, id: 'a' }, { start: 5, id: 'z' })).toBe(false);
      expect(ownsBefore({ start: 1, id: 'a' }, { start: 1, id: 'b' })).toBe(true);
      expect(ownsBefore({ start: 1, id: 'b' }, { start: 1, id: 'a' })).toBe(false);
      expect(ownsBefore({ start: null, id: 'a' }, { start: null, id: 'b' })).toBe(true);
      expect(ownsBefore({ start: null, id: 'b' }, { start: null, id: 'a' })).toBe(false);
    });
  });

  /**
   * M-21, write side. The stored form of `occurred_at` is load-bearing, not
   * cosmetic: the priced CTE compares it to `model_pricing.effective_from` as
   * BINARY-collated TEXT, so a spelling whose lexicographic order disagrees
   * with its clock order makes the API report tokens as unpriced that core
   * priced. These cases pin the canonicalization at the only place a JSONL
   * timestamp enters the database.
   */
  describe('canonical occurred_at on the way in', () => {
    function storedTimes(): unknown[] {
      return temp.db
        .prepare('SELECT DISTINCT occurred_at FROM token_usage ORDER BY occurred_at')
        .pluck()
        .all();
    }

    function usageAt(messageId: string, timestamp: string): DedupedUsage {
      return {
        messageId,
        model: 'claude-opus-4-6',
        timestamp,
        agentId: null,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      };
    }

    it('stores every accepted spelling as the instant it denotes', () => {
      insertTokenUsageRows(temp.db, sessionId, [
        // The pinned defect: an hour AFTER 2026-03-01T00:00:00Z as an instant,
        // but its '2026-02-...' prefix sorts below it as text.
        usageAt('offset', '2026-02-28T20:00:00-05:00'),
        usageAt('second-precision', '2026-03-01T09:30:00Z'),
        usageAt('bare-date', '2026-03-02'),
        usageAt('already-canonical', '2026-03-03T00:00:00.000Z'),
      ]);
      expect(storedTimes()).toEqual([
        '2026-03-01T01:00:00.000Z',
        '2026-03-01T09:30:00.000Z',
        '2026-03-02T00:00:00.000Z',
        '2026-03-03T00:00:00.000Z',
      ]);
    });

    it('replaying a non-canonical timestamp still performs zero UPDATEs', () => {
      // Why canonicalization happens BEFORE binding: the upsert guard compares
      // `occurred_at IS NOT excluded.occurred_at`, so binding the raw value
      // would make every replay of a second-precision timestamp look like a
      // change and quietly break idempotence.
      const rows = [usageAt('offset', '2026-02-28T20:00:00-05:00')];
      expect(insertTokenUsageRows(temp.db, sessionId, rows)).toEqual({
        inserted: 5,
        corrected: 0,
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
      });
      expect(insertTokenUsageRows(temp.db, sessionId, rows)).toEqual({
        inserted: 0,
        corrected: 0,
        crossSessionCollisions: 0,
        crossSessionMessageIds: [],
      });
    });

    it('halts on a timestamp that denotes no unambiguous instant', () => {
      // A usage timestamp is never guessed and never dropped to NULL - NULL
      // would make the row permanently unpriceable AND invisible to retention.
      expect(() =>
        insertTokenUsageRows(temp.db, sessionId, [usageAt('vague', '2026-03-01 09:30')]),
      ).toThrow(/occurred_at "2026-03-01 09:30" is not an unambiguous instant/);
      expect(() =>
        insertTokenUsageRows(temp.db, sessionId, [usageAt('local', '2026-03-01T09:30:00')]),
      ).toThrow(/never guessed/);
      // A day the pattern allows but the calendar does not: both parsers roll
      // it into March rather than failing, filing the spend under a day that
      // never happened.
      expect(() =>
        insertTokenUsageRows(temp.db, sessionId, [usageAt('feb30', '2026-02-30T00:00:00Z')]),
      ).toThrow(/not an unambiguous instant/);
      expect(storedTimes()).toEqual([]);
    });
  });
});
