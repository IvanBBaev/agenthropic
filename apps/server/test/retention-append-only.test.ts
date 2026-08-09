/**
 * WP-D10 invariant proofs: what the retention mechanism is FORBIDDEN to do.
 *
 * `test/events-raw.test.ts` proves the substrate is append-only. This file
 * proves the delete path RESPECTS that proof rather than working around it:
 * the triggers are still installed and still fire after a prune, the raw rows
 * are byte-identical, and the persisted DAG - the moat artifact - is untouched.
 *
 * The last block is a static guard: no retention source may contain DML
 * against a protected table at all, so a future edit cannot quietly gain the
 * ability while the behavioural tests keep passing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '../src/db/connection';
import {
  NO_RETENTION,
  RETENTION_PROTECTED_TABLES,
  type RetentionPolicy,
} from '../src/retention/policy';
import { prune } from '../src/retention/prune';
import { createMigratedTempDb, insertAgent, insertSession, type TempDb } from './helpers';

const NOW = new Date('2026-08-07T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';

const PRUNE_EVERYTHING_PRUNABLE: RetentionPolicy = {
  ...NO_RETENTION,
  events: { maxAgeDays: 1 },
  tokenUsage: { maxAgeDays: 1, acknowledgeCostLoss: true },
};

function dump(db: SqliteDatabase, table: string): unknown[] {
  const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
    (column) => `"${column.name}"`,
  );
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${columns.join(', ')}`).all();
}

describe('retention respects the append-only substrate and the persisted DAG (WP-D10)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, 's1');
    insertAgent(temp.db, 'a-main', 's1');
    insertAgent(temp.db, 'a-child', 's1', 'a-main');
    temp.db
      .prepare(
        `INSERT INTO orchestration_edges
           (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at)
         VALUES ('s1', 'a-main', 'a-child', 'tool_use', 'test', 'host', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    for (const key of ['k-1', 'k-2', 'k-3']) {
      const raw = temp.db
        .prepare(
          `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
           VALUES (?, 'hook', 'PreToolUse', '{"tool":"Read"}', '2026-01-01T00:00:00.000Z')`,
        )
        .run(key);
      temp.db
        .prepare(
          `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
           VALUES (?, 's1', 'a-child', 'PreToolUse', ?)`,
        )
        .run(raw.lastInsertRowid, OLD);
    }
    temp.db
      .prepare(
        `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
         VALUES ('s1', 'a-child', 'msg-1', 'claude-opus-4-8', 'input', 1000, ?)`,
      )
      .run(OLD);
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('deletes the projections and leaves every events_raw row byte-identical', () => {
    const before = dump(temp.db, 'events_raw');
    expect(before).toHaveLength(3);

    const report = prune(temp.db, PRUNE_EVERYTHING_PRUNABLE, { now: NOW });

    expect(report.applied).toBe(true);
    expect(dump(temp.db, 'events')).toEqual([]);
    expect(dump(temp.db, 'token_usage')).toEqual([]);
    expect(dump(temp.db, 'events_raw')).toEqual(before);
  });

  it('leaves the append-only triggers installed and still firing after a prune', () => {
    prune(temp.db, PRUNE_EVERYTHING_PRUNABLE, { now: NOW });

    const triggers = (
      temp.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events_raw' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(triggers).toEqual(['events_raw_no_delete', 'events_raw_no_update']);

    expect(() =>
      temp.db.prepare("DELETE FROM events_raw WHERE idempotency_key = 'k-1'").run(),
    ).toThrow(/events_raw is append-only/);
    expect(() =>
      temp.db.prepare("UPDATE events_raw SET payload = '{}' WHERE idempotency_key = 'k-1'").run(),
    ).toThrow(/events_raw is append-only/);
  });

  it('leaves the persisted DAG and the pricing/provenance tables byte-identical', () => {
    const before = {
      sessions: dump(temp.db, 'sessions'),
      agents: dump(temp.db, 'agents'),
      orchestration_edges: dump(temp.db, 'orchestration_edges'),
      model_pricing: dump(temp.db, 'model_pricing'),
      schema_version: dump(temp.db, 'schema_version'),
    };

    prune(temp.db, PRUNE_EVERYTHING_PRUNABLE, { now: NOW });

    expect({
      sessions: dump(temp.db, 'sessions'),
      agents: dump(temp.db, 'agents'),
      orchestration_edges: dump(temp.db, 'orchestration_edges'),
      model_pricing: dump(temp.db, 'model_pricing'),
      schema_version: dump(temp.db, 'schema_version'),
    }).toEqual(before);

    // In particular no agent was re-parented by `ON DELETE SET NULL`.
    expect(
      (
        temp.db.prepare("SELECT parent_agent_id AS p FROM agents WHERE id = 'a-child'").get() as {
          p: string | null;
        }
      ).p,
    ).toBe('a-main');
  });

  it('leaves the database consistent: integrity_check ok, foreign keys still on', () => {
    prune(temp.db, PRUNE_EVERYTHING_PRUNABLE, { now: NOW });

    expect(temp.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(temp.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(temp.db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  describe('static guard - the ability itself must not exist in the source', () => {
    const sources = retentionSources();

    it('reads every retention source (guard cannot pass vacuously)', () => {
      expect(sources.length).toBeGreaterThanOrEqual(6);
      expect(sources.map(([name]) => name)).toContain('db/retention-queries.ts');
    });

    it.each(RETENTION_PROTECTED_TABLES)('contains no DML against `%s`', (table) => {
      const dml = new RegExp(
        `(DELETE\\s+FROM|UPDATE|INSERT\\s+INTO|DROP\\s+TRIGGER|DROP\\s+TABLE)\\s+["']?${table}\\b`,
        'i',
      );
      for (const [name, source] of sources) {
        expect(`${name}: ${dml.test(source) ? 'MATCH' : 'clean'}`).toBe(`${name}: clean`);
      }
    });

    it('never disables foreign keys or the triggers that enforce append-only', () => {
      for (const [name, source] of sources) {
        expect(`${name}: ${/PRAGMA\s+foreign_keys/i.test(source) ? 'MATCH' : 'clean'}`).toBe(
          `${name}: clean`,
        );
        expect(`${name}: ${/DROP\s+TRIGGER/i.test(source) ? 'MATCH' : 'clean'}`).toBe(
          `${name}: clean`,
        );
      }
    });

    it('buys no coverage with ignore pragmas', () => {
      for (const [name, source] of sources) {
        expect(`${name}: ${source.includes('v8 ignore') ? 'MATCH' : 'clean'}`).toBe(
          `${name}: clean`,
        );
      }
    });
  });
});

/** Every source file that makes up the retention mechanism, as [name, text]. */
function retentionSources(): ReadonlyArray<readonly [string, string]> {
  const retentionDir = fileURLToPath(new URL('../src/retention/', import.meta.url));
  const entries: Array<readonly [string, string]> = readdirSync(retentionDir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => [`retention/${name}`, readFileSync(`${retentionDir}${name}`, 'utf8')] as const);
  entries.push([
    'db/retention-queries.ts',
    readFileSync(fileURLToPath(new URL('../src/db/retention-queries.ts', import.meta.url)), 'utf8'),
  ]);
  return entries;
}
