import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import type { FastifyInstance } from 'fastify';

export interface TempDb {
  readonly db: SqliteDatabase;
  readonly dir: string;
  readonly path: string;
  cleanup(): void;
}

/** Open a fresh migrated database in a throwaway temp directory. */
export function createMigratedTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'agenthropic-server-test-'));
  const path = join(dir, 'test.db');
  const db = openDatabase(path);
  runMigrations(db);
  return {
    db,
    dir,
    path,
    cleanup(): void {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export function insertSession(db: SqliteDatabase, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
     VALUES (?, 'test-slug', '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z', 'active')`,
  ).run(id);
}

export function insertAgent(
  db: SqliteDatabase,
  id: string,
  sessionId: string,
  parentAgentId: string | null = null,
  status = 'working',
): void {
  db.prepare(
    `INSERT INTO agents (id, session_id, type, subagent_type, status, parent_agent_id, first_seen_at, last_seen_at)
     VALUES (?, ?, 'subagent', 'explorer', ?, ?, '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z')`,
  ).run(id, sessionId, status, parentAgentId);
}

/**
 * One projection event (`events_raw` + `events`) for retention tests. The
 * session/agent must already exist (see {@link insertSession},
 * {@link insertAgent}); `occurredAt` is what the age window is measured on.
 */
export function insertProjectionEvent(
  db: SqliteDatabase,
  key: string,
  occurredAt: string,
  sessionId = 's1',
  agentId = 'a1',
): void {
  const raw = db
    .prepare(
      `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
       VALUES (?, 'hook', 'PreToolUse', '{}', ?)`,
    )
    .run(key, occurredAt);
  db.prepare(
    `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
     VALUES (?, ?, ?, 'PreToolUse', ?)`,
  ).run(raw.lastInsertRowid, sessionId, agentId, occurredAt);
}

/** One priced `token_usage` row for retention tests (the never-pruned table). */
export function insertTokenUsage(
  db: SqliteDatabase,
  messageId: string,
  occurredAt: string,
  sessionId = 's1',
  agentId = 'a1',
): void {
  db.prepare(
    `INSERT INTO token_usage (session_id, agent_id, message_id, model, bucket, tokens, occurred_at)
     VALUES (?, ?, ?, 'claude-opus-4-8', 'input', 1000, ?)`,
  ).run(sessionId, agentId, messageId, occurredAt);
}

export function countRows(
  db: SqliteDatabase,
  table: 'events' | 'token_usage' | 'events_raw',
): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * The IP listener at `index` of `app.addresses()`. Since fastify 5.12 an entry
 * may be a pipe or socket path string; the server only ever listens on an IP,
 * so a string here is a test failure, not a case to handle.
 */
export function networkAddress(app: FastifyInstance, index = 0): AddressInfo {
  const entry = app.addresses()[index];
  if (entry === undefined || typeof entry === 'string') {
    throw new Error(`expected an IP listener at index ${String(index)}, got ${String(entry)}`);
  }
  return entry;
}

/**
 * R2 (2026-11-08): the poison for tests that need ingest to REFUSE a session.
 * A model with no price row no longer does - its tokens are stored and counted
 * unpriced - so these move a fixture line onto the one tiered model with a
 * seeded base tier (migration 25) and push its prompt past the 100k limit,
 * the usage shape ingest still refuses before any write.
 */
export const TIERED_MODEL = 'claude-haiku-5-5';
export const OVER_TIER_REASON = /exceeds the 100000-token base tier/;

export function overTierLine(line: string): string {
  return line
    .replace(/synthetic-model-[ab]/g, TIERED_MODEL)
    .replace(/"input_tokens":\d+/g, '"input_tokens":200000');
}
