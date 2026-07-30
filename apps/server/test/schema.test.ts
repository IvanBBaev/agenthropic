import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertOrchestrationEdge, type OrchestrationEdgeInsert } from '../src/db/edges';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

describe('Phase-1 schema', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  describe('events (WP-D5)', () => {
    it('enforces the raw_event_id foreign key', () => {
      expect(() =>
        temp.db
          .prepare(
            `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
             VALUES (999, 's1', NULL, 'Stop', '2026-07-11T00:00:00Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
    });

    it('accepts an event pointing at an existing raw row', () => {
      const raw = temp.db
        .prepare(
          `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
           VALUES ('k', 'jsonl', 'Stop', '{}', '2026-07-11T00:00:00Z')`,
        )
        .run();
      const info = temp.db
        .prepare(
          `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
           VALUES (?, 's1', 'a1', 'Stop', '2026-07-11T00:00:00Z')`,
        )
        .run(raw.lastInsertRowid);
      expect(info.changes).toBe(1);
    });
  });

  describe('agents (WP-D6)', () => {
    it("accepts the full status set including required 'unknown'", () => {
      insertSession(temp.db, 's1');
      for (const [index, status] of [
        'working',
        'waiting',
        'completed',
        'error',
        'unknown',
      ].entries()) {
        insertAgent(temp.db, `agent-${index}`, 's1', null, status);
      }
      const count = temp.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };
      expect(count.n).toBe(5);
    });

    it('rejects an out-of-enum status', () => {
      insertSession(temp.db, 's1');
      expect(() => insertAgent(temp.db, 'a1', 's1', null, 'napping')).toThrow(/CHECK/);
    });

    it('rejects an agent for a nonexistent session (FK)', () => {
      expect(() => insertAgent(temp.db, 'a1', 'no-such-session')).toThrow(/FOREIGN KEY/);
    });

    it('self-referential parent_agent_id builds the tree and is indexed', () => {
      insertSession(temp.db, 's1');
      insertAgent(temp.db, 'root', 's1');
      insertAgent(temp.db, 'child', 's1', 'root');

      const child = temp.db
        .prepare('SELECT parent_agent_id FROM agents WHERE id = ?')
        .get('child') as { parent_agent_id: string | null };
      expect(child.parent_agent_id).toBe('root');

      const indexes = (
        temp.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agents'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(indexes).toContain('idx_agents_parent_agent_id');
    });

    it('ON DELETE SET NULL orphans children instead of cascading', () => {
      insertSession(temp.db, 's1');
      insertAgent(temp.db, 'root', 's1');
      insertAgent(temp.db, 'child', 's1', 'root');

      temp.db.prepare('DELETE FROM agents WHERE id = ?').run('root');

      const child = temp.db
        .prepare('SELECT parent_agent_id FROM agents WHERE id = ?')
        .get('child') as { parent_agent_id: string | null };
      expect(child.parent_agent_id).toBeNull();
    });
  });

  describe('orchestration_edges (WP-D7)', () => {
    const edge: OrchestrationEdgeInsert = {
      sessionId: 's1',
      parentAgentId: 'root',
      childAgentId: 'child',
      source: 'tool_use',
      instance: 'mini-1',
      hostId: 'mac-mini-m4',
      createdAt: '2026-07-11T00:00:00Z',
    };

    it('inserting the same logical edge twice yields exactly one row', () => {
      const first = insertOrchestrationEdge(temp.db, edge);
      const second = insertOrchestrationEdge(temp.db, { ...edge, source: 'directory' });

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      const count = temp.db.prepare('SELECT COUNT(*) AS n FROM orchestration_edges').get() as {
        n: number;
      };
      expect(count.n).toBe(1);
    });

    it('the same parent/child pair in another session is a distinct edge', () => {
      insertOrchestrationEdge(temp.db, edge);
      const other = insertOrchestrationEdge(temp.db, { ...edge, sessionId: 's2' });
      expect(other.inserted).toBe(true);
    });

    it('accepts all four structural join sources and rejects others', () => {
      const sources = ['tool_use', 'directory', 'task_notification', 'queue_operation'] as const;
      for (const [index, source] of sources.entries()) {
        const result = insertOrchestrationEdge(temp.db, {
          ...edge,
          childAgentId: `child-${index}`,
          source,
        });
        expect(result.inserted).toBe(true);
      }
      expect(() =>
        temp.db
          .prepare(
            `INSERT INTO orchestration_edges
               (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at)
             VALUES ('s1', 'root', 'x', 'substring', 'mini-1', 'h', '2026-07-11T00:00:00Z')`,
          )
          .run(),
      ).toThrow(/CHECK/);
    });

    it('requires non-null instance and host_id (fleet key by design)', () => {
      expect(() =>
        temp.db
          .prepare(
            `INSERT INTO orchestration_edges
               (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at)
             VALUES ('s1', 'root', 'x', 'tool_use', NULL, 'h', '2026-07-11T00:00:00Z')`,
          )
          .run(),
      ).toThrow(/NOT NULL/);
    });
  });

  describe('token_usage (WP-D8)', () => {
    function insertUsage(messageId: string, bucket: string, tokens: number): void {
      temp.db
        .prepare(
          `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
           VALUES ('s1', NULL, ?, 'claude-sonnet-5', ?, ?, '2026-07-11T00:00:00Z')`,
        )
        .run(messageId, bucket, tokens);
    }

    it('UNIQUE(message_id, bucket) is the storage-level N3 dedup guarantee', () => {
      insertUsage('msg-1', 'input', 100);
      expect(() => insertUsage('msg-1', 'input', 100)).toThrow(/UNIQUE/);
    });

    it('the same message may have one row per bucket', () => {
      for (const bucket of ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h']) {
        insertUsage('msg-1', bucket, 10);
      }
      const count = temp.db
        .prepare("SELECT COUNT(*) AS n FROM token_usage WHERE message_id = 'msg-1'")
        .get() as { n: number };
      expect(count.n).toBe(5);
    });

    it('agent_id is nullable by design (backfilled later) and bucket is CHECKed', () => {
      insertUsage('msg-2', 'output', 5);
      const row = temp.db
        .prepare(
          "SELECT agent_id, is_compaction_baseline FROM token_usage WHERE message_id = 'msg-2'",
        )
        .get() as { agent_id: string | null; is_compaction_baseline: number };
      expect(row.agent_id).toBeNull();
      expect(row.is_compaction_baseline).toBe(0);
      expect(() => insertUsage('msg-3', 'cache_write_2h', 5)).toThrow(/CHECK/);
    });
  });

  describe('model_pricing (WP-C1)', () => {
    it('is seeded with the WP-C1 approximate list prices (2026-01-01 floor) for all five models', () => {
      const rows = temp.db
        .prepare('SELECT model, bucket, usd_per_mtok, effective_from FROM model_pricing')
        .all() as Array<{
        model: string;
        bucket: string;
        usd_per_mtok: number;
        effective_from: string;
      }>;
      expect(rows).toHaveLength(25); // 5 models x 5 buckets
      expect(rows.every((r) => r.effective_from === '2026-01-01')).toBe(true);

      const rate = (model: string, bucket: string): number | undefined =>
        rows.find((r) => r.model === model && r.bucket === bucket)?.usd_per_mtok;

      expect(rate('claude-opus-4-8', 'input')).toBe(5);
      expect(rate('claude-opus-4-8', 'output')).toBe(25);
      expect(rate('claude-opus-4-8', 'cache_read')).toBeCloseTo(0.5);
      expect(rate('claude-opus-4-8', 'cache_write_5m')).toBeCloseTo(6.25);
      expect(rate('claude-opus-4-8', 'cache_write_1h')).toBeCloseTo(10);
      expect(rate('claude-sonnet-5', 'input')).toBe(3);
      expect(rate('claude-sonnet-5', 'output')).toBe(15);
      expect(rate('claude-fable-5', 'input')).toBe(10);
      expect(rate('claude-fable-5', 'output')).toBe(50);
      expect(rate('claude-haiku-4-5-20251001', 'input')).toBe(1);
      expect(rate('claude-haiku-4-5-20251001', 'output')).toBe(5);
      for (const bucket of ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h']) {
        expect(rate('<synthetic>', bucket)).toBe(0);
      }
    });

    it('multiple effective_from rows coexist for the same model+bucket', () => {
      const insert = temp.db.prepare(
        'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
      );
      insert.run('claude-sonnet-5', 'input', 2, '2026-09-01');
      const rows = temp.db
        .prepare(
          "SELECT effective_from FROM model_pricing WHERE model = 'claude-sonnet-5' AND bucket = 'input' ORDER BY effective_from",
        )
        .all() as Array<{ effective_from: string }>;
      expect(rows.map((r) => r.effective_from)).toEqual(['2026-01-01', '2026-09-01']);

      // Same (model, bucket, effective_from) triple is rejected by the PK.
      expect(() => insert.run('claude-sonnet-5', 'input', 2.5, '2026-09-01')).toThrow(
        /UNIQUE|PRIMARY/,
      );
    });
  });
});
