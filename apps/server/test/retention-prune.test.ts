import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '../src/db/connection';
import { readJournalEntries, RETENTION_JOURNAL_SUFFIX } from '../src/retention/journal';
import { NO_RETENTION, RetentionPolicyError, type RetentionPolicy } from '../src/retention/policy';
import { cutoffFor, prune } from '../src/retention/prune';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

const NOW = new Date('2026-08-07T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';
const RECENT = '2026-08-06T00:00:00.000Z';

function insertEvent(db: SqliteDatabase, key: string, occurredAt: string | null): void {
  const raw = db
    .prepare(
      `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
       VALUES (?, 'hook', 'PreToolUse', '{}', '2026-01-01T00:00:00.000Z')`,
    )
    .run(key);
  db.prepare(
    `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
     VALUES (?, 's1', 'a1', 'PreToolUse', ?)`,
  ).run(raw.lastInsertRowid, occurredAt);
}

function insertUsage(
  db: SqliteDatabase,
  options: {
    messageId: string;
    tokens: number;
    occurredAt: string | null;
    sessionId?: string;
    model?: string;
    bucket?: string;
  },
): void {
  db.prepare(
    `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
     VALUES (?, 'a1', ?, ?, ?, ?, ?)`,
  ).run(
    options.sessionId ?? 's1',
    options.messageId,
    options.model ?? 'claude-opus-4-8',
    options.bucket ?? 'input',
    options.tokens,
    options.occurredAt,
  );
}

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('retention prune (WP-D10 mechanism; retention VALUES await OPEN-1)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, 's1');
    insertAgent(temp.db, 'a1', 's1');
  });

  afterEach(() => {
    temp.cleanup();
  });

  describe('the default deletes nothing', () => {
    it('an unconfigured policy touches no row, opens no journal and reports nothing', () => {
      insertEvent(temp.db, 'k1', OLD);
      insertUsage(temp.db, { messageId: 'm1', tokens: 1_000_000, occurredAt: OLD });

      const report = prune(temp.db, NO_RETENTION, { now: NOW });

      expect(report.applied).toBe(false);
      expect(report.tables).toEqual([]);
      expect(report.journalPath).toBeNull();
      expect(report.costImpact.costUsd).toBe(0);
      expect(count(temp.db, 'events')).toBe(1);
      expect(count(temp.db, 'token_usage')).toBe(1);
      expect(existsSync(`${temp.path}${RETENTION_JOURNAL_SUFFIX}`)).toBe(false);
    });

    it('a configured policy with nothing expired still writes no journal', () => {
      insertEvent(temp.db, 'k1', RECENT);
      const report = prune(temp.db, { ...NO_RETENTION, events: { maxAgeDays: 30 } }, { now: NOW });

      expect(report.applied).toBe(false);
      expect(report.tables[0]).toMatchObject({ table: 'events', rowsMatched: 0, rowsDeleted: 0 });
      expect(count(temp.db, 'events')).toBe(1);
      expect(existsSync(`${temp.path}${RETENTION_JOURNAL_SUFFIX}`)).toBe(false);
    });

    it('a token_usage rule with nothing expired prices nothing and deletes nothing', () => {
      insertUsage(temp.db, { messageId: 'm-new', tokens: 1_000_000, occurredAt: RECENT });

      const report = prune(
        temp.db,
        { ...NO_RETENTION, tokenUsage: { maxAgeDays: 30, acknowledgeCostLoss: true } },
        { now: NOW },
      );

      expect(report.applied).toBe(false);
      expect(report.tables[0]).toMatchObject({
        table: 'token_usage',
        rowsMatched: 0,
        rowsDeleted: 0,
      });
      expect(report.costImpact).toEqual({
        tokens: 0,
        costUsd: 0,
        unpricedTokens: 0,
        byModel: [],
        sessionsAffected: 0,
        sessionsPartiallyPruned: 0,
      });
      expect(count(temp.db, 'token_usage')).toBe(1);
      expect(existsSync(`${temp.path}${RETENTION_JOURNAL_SUFFIX}`)).toBe(false);
    });
  });

  describe('projections only - the substrate survives', () => {
    it('deletes expired `events` rows and leaves every `events_raw` row in place', () => {
      insertEvent(temp.db, 'k-old', OLD);
      insertEvent(temp.db, 'k-recent', RECENT);
      insertEvent(temp.db, 'k-unknown', null);

      const report = prune(temp.db, { ...NO_RETENTION, events: { maxAgeDays: 30 } }, { now: NOW });

      expect(report.applied).toBe(true);
      expect(report.tables).toHaveLength(1);
      expect(report.tables[0]).toMatchObject({
        table: 'events',
        rowsMatched: 1,
        rowsDeleted: 1,
        budgetExhausted: false,
      });
      expect(count(temp.db, 'events')).toBe(2);
      expect(count(temp.db, 'events_raw')).toBe(3);
    });

    it('never expires a row of unknown age', () => {
      insertEvent(temp.db, 'k-unknown', null);
      const report = prune(temp.db, { ...NO_RETENTION, events: { maxAgeDays: 1 } }, { now: NOW });
      expect(report.applied).toBe(false);
      expect(count(temp.db, 'events')).toBe(1);
    });

    it('exposes the cutoff it used', () => {
      const report = prune(temp.db, { ...NO_RETENTION, events: { maxAgeDays: 30 } }, { now: NOW });
      expect(report.tables[0]?.cutoff).toBe('2026-07-08T00:00:00.000Z');
      expect(cutoffFor(NOW, { maxAgeDays: 30 })).toBe('2026-07-08T00:00:00.000Z');
    });

    it('names the tables it can never delete from', () => {
      const report = prune(temp.db, NO_RETENTION, { now: NOW });
      expect(report.protectedTables).toContain('events_raw');
      expect(report.protectedTables).toContain('agents');
      expect(report.protectedTables).toContain('orchestration_edges');
    });
  });

  describe('dry run measures without deleting', () => {
    it('reports the window and the dollars, deletes nothing, writes no journal', () => {
      insertEvent(temp.db, 'k-old', OLD);
      insertUsage(temp.db, { messageId: 'm-old', tokens: 1_000_000, occurredAt: OLD });

      const policy: RetentionPolicy = {
        ...NO_RETENTION,
        events: { maxAgeDays: 30 },
        tokenUsage: { maxAgeDays: 30, acknowledgeCostLoss: true },
      };
      const report = prune(temp.db, policy, { now: NOW, dryRun: true });

      expect(report.dryRun).toBe(true);
      expect(report.applied).toBe(false);
      expect(report.tables.map((t) => [t.table, t.rowsMatched, t.rowsDeleted])).toEqual([
        ['events', 1, 0],
        ['token_usage', 1, 0],
      ]);
      // opus input is seeded at $5 / Mtok - 1M tokens is exactly $5.
      expect(report.costImpact.costUsd).toBeCloseTo(5, 10);
      expect(report.costImpact.tokens).toBe(1_000_000);
      expect(report.journalPath).toBe(`${temp.path}${RETENTION_JOURNAL_SUFFIX}`);
      expect(existsSync(`${temp.path}${RETENTION_JOURNAL_SUFFIX}`)).toBe(false);
      expect(count(temp.db, 'events')).toBe(1);
      expect(count(temp.db, 'token_usage')).toBe(1);
    });
  });

  describe('no silent dollars', () => {
    const policy: RetentionPolicy = {
      ...NO_RETENTION,
      tokenUsage: { maxAgeDays: 30, acknowledgeCostLoss: true },
    };

    it('prices the window before deleting it and journals what left the books', () => {
      insertUsage(temp.db, { messageId: 'm-old-in', tokens: 1_000_000, occurredAt: OLD });
      insertUsage(temp.db, {
        messageId: 'm-old-out',
        tokens: 100_000,
        occurredAt: OLD,
        bucket: 'output',
      });
      insertUsage(temp.db, { messageId: 'm-new', tokens: 500, occurredAt: RECENT });

      const report = prune(temp.db, policy, { now: NOW });

      // input 1M @ $5 + output 100k @ $25 = 5 + 2.5
      expect(report.costImpact.costUsd).toBeCloseTo(7.5, 10);
      expect(report.costImpact.tokens).toBe(1_100_000);
      expect(report.costImpact.unpricedTokens).toBe(0);
      expect(report.costImpact.byModel).toEqual([
        { model: 'claude-opus-4-8', tokens: 1_100_000, costUsd: 7.5, unpricedTokens: 0 },
      ]);
      expect(report.costImpact.sessionsAffected).toBe(1);
      // s1 keeps a recent row, so its total silently drops - that is the case
      // the journal exists for.
      expect(report.costImpact.sessionsPartiallyPruned).toBe(1);

      const entries = readJournalEntries(`${temp.path}${RETENTION_JOURNAL_SUFFIX}`);
      expect(entries).toHaveLength(1);
      const entry = entries[0] as Record<string, unknown>;
      expect(entry['ranAt']).toBe(NOW.toISOString());
      expect(entry['database']).toBe(temp.path);
      expect((entry['costImpact'] as { costUsd: number }).costUsd).toBeCloseTo(7.5, 10);
      expect(String(entry['note'])).toMatch(/LOWER/);
      expect(count(temp.db, 'token_usage')).toBe(1);
    });

    it('counts a fully pruned session as affected but not partially pruned', () => {
      insertSession(temp.db, 's2');
      insertUsage(temp.db, { messageId: 'm-s2', tokens: 10, occurredAt: OLD, sessionId: 's2' });

      const report = prune(temp.db, policy, { now: NOW });
      expect(report.costImpact.sessionsAffected).toBe(1);
      expect(report.costImpact.sessionsPartiallyPruned).toBe(0);
    });

    it('surfaces unpriced tokens instead of valuing them at zero silently', () => {
      insertUsage(temp.db, {
        messageId: 'm-unknown-model',
        tokens: 4_000,
        occurredAt: OLD,
        model: 'model-with-no-price-row',
      });

      const report = prune(temp.db, policy, { now: NOW, dryRun: true });
      expect(report.costImpact.costUsd).toBe(0);
      expect(report.costImpact.unpricedTokens).toBe(4_000);
      expect(report.costImpact.tokens).toBe(4_000);
    });

    it('refuses to prune token_usage at all without the cost-loss acknowledgement', () => {
      expect(() =>
        prune(
          temp.db,
          { ...NO_RETENTION, tokenUsage: { maxAgeDays: 30, acknowledgeCostLoss: false } },
          { now: NOW },
        ),
      ).toThrow(RetentionPolicyError);
    });
  });

  describe('bounded so the write lock is never held for an unbounded time', () => {
    it('deletes at most maxRowsPerRun per table and says more remain', () => {
      for (let i = 0; i < 5; i += 1) {
        insertEvent(temp.db, `k-${String(i)}`, OLD);
      }

      const policy: RetentionPolicy = {
        ...NO_RETENTION,
        events: { maxAgeDays: 30 },
        maxRowsPerRun: 2,
      };

      const first = prune(temp.db, policy, { now: NOW });
      expect(first.tables[0]).toMatchObject({
        rowsMatched: 2,
        rowsDeleted: 2,
        budgetExhausted: true,
      });
      expect(count(temp.db, 'events')).toBe(3);

      const second = prune(temp.db, policy, { now: NOW });
      expect(second.tables[0]?.rowsDeleted).toBe(2);
      expect(count(temp.db, 'events')).toBe(1);

      const third = prune(temp.db, policy, { now: NOW });
      expect(third.tables[0]).toMatchObject({ rowsDeleted: 1, budgetExhausted: false });
      expect(count(temp.db, 'events')).toBe(0);

      const fourth = prune(temp.db, policy, { now: NOW });
      expect(fourth.applied).toBe(false);
    });
  });

  describe('all-or-nothing', () => {
    it('a failed journal write rolls the deletion back completely', () => {
      insertEvent(temp.db, 'k-old', OLD);
      insertUsage(temp.db, { messageId: 'm-old', tokens: 1_000_000, occurredAt: OLD });

      // A journal path whose parent is a FILE: the receipt cannot be written.
      const blocker = join(temp.dir, 'blocker');
      writeFileSync(blocker, 'x', 'utf8');

      const policy: RetentionPolicy = {
        ...NO_RETENTION,
        events: { maxAgeDays: 30 },
        tokenUsage: { maxAgeDays: 30, acknowledgeCostLoss: true },
      };

      expect(() =>
        prune(temp.db, policy, { now: NOW, journalPath: join(blocker, 'journal.jsonl') }),
      ).toThrow();

      expect(count(temp.db, 'events')).toBe(1);
      expect(count(temp.db, 'token_usage')).toBe(1);
      expect(count(temp.db, 'events_raw')).toBe(1);
    });

    it('honours an explicit journal path', () => {
      insertEvent(temp.db, 'k-old', OLD);
      const path = join(temp.dir, 'custom', 'receipt.jsonl');

      const report = prune(
        temp.db,
        { ...NO_RETENTION, events: { maxAgeDays: 30 } },
        { now: NOW, journalPath: path },
      );

      expect(report.journalPath).toBe(path);
      expect(readJournalEntries(path)).toHaveLength(1);
    });

    it('defaults `now` to the current clock', () => {
      const before = Date.now();
      const report = prune(temp.db, NO_RETENTION);
      expect(new Date(report.ranAt).getTime()).toBeGreaterThanOrEqual(before);
      expect(report.dryRun).toBe(false);
    });
  });
});
