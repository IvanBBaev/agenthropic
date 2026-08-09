import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '../src/db/connection';
import { RETENTION_JOURNAL_SUFFIX } from '../src/retention/journal';
import {
  loadRetentionPolicy,
  NO_RETENTION,
  RetentionPolicyError,
  type RetentionPolicy,
} from '../src/retention/policy';
import { createRetentionRunner } from '../src/retention/runner';
import { createMigratedTempDb, insertSession, type TempDb } from './helpers';

const NOW = new Date('2026-08-07T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';

function insertEvent(db: SqliteDatabase, key: string, occurredAt: string): void {
  const raw = db
    .prepare(
      `INSERT INTO events_raw (idempotency_key, source, event_type, payload, received_at)
       VALUES (?, 'hook', 'PreToolUse', '{}', '2026-01-01T00:00:00.000Z')`,
    )
    .run(key);
  db.prepare(
    `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
     VALUES (?, 's1', NULL, 'PreToolUse', ?)`,
  ).run(raw.lastInsertRowid, occurredAt);
}

describe('retention runner (WP-D10 mechanism; policy value awaits OPEN-1)', () => {
  let temp: TempDb;
  let backupDir: string;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, 's1');
    backupDir = mkdtempSync(join(tmpdir(), 'agenthropic-runner-backups-'));
  });

  afterEach(() => {
    temp.cleanup();
    rmSync(backupDir, { recursive: true, force: true });
  });

  it('short-circuits on the default policy: configured=false, nothing inspected', () => {
    insertEvent(temp.db, 'k-old', OLD);

    const report = createRetentionRunner(temp.db, NO_RETENTION).run({ now: NOW });

    expect(report).toEqual({
      ranAt: NOW.toISOString(),
      dryRun: false,
      configured: false,
      database: null,
      backups: null,
    });
    expect((temp.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
    expect(existsSync(`${temp.path}${RETENTION_JOURNAL_SUFFIX}`)).toBe(false);
  });

  it('the environment-built default is the no-op policy', () => {
    const runner = createRetentionRunner(temp.db, loadRetentionPolicy({}));
    expect(runner.policy).toEqual(NO_RETENTION);
    expect(runner.run({ now: NOW }).configured).toBe(false);
  });

  it('validates the policy at construction, not at deletion time', () => {
    expect(() =>
      createRetentionRunner(temp.db, {
        ...NO_RETENTION,
        tokenUsage: { maxAgeDays: 30, acknowledgeCostLoss: false },
      }),
    ).toThrow(RetentionPolicyError);
  });

  it('runs only the sub-mechanisms the policy configures', () => {
    const rowsOnly: RetentionPolicy = { ...NO_RETENTION, events: { maxAgeDays: 30 } };
    const rowsReport = createRetentionRunner(temp.db, rowsOnly).run({ now: NOW });
    expect(rowsReport.configured).toBe(true);
    expect(rowsReport.database).not.toBeNull();
    expect(rowsReport.backups).toBeNull();

    const filesOnly: RetentionPolicy = {
      ...NO_RETENTION,
      backupFiles: { directory: backupDir, maxAgeDays: 14, keepMinimum: 1 },
    };
    const filesReport = createRetentionRunner(temp.db, filesOnly).run({ now: NOW });
    expect(filesReport.database).toBeNull();
    expect(filesReport.backups?.directoryPresent).toBe(true);
  });

  it('runs rows and backup files together, and threads dry-run through both', () => {
    insertEvent(temp.db, 'k-old', OLD);
    const backup = join(backupDir, 'agenthropic-2026-01-01.db');
    writeFileSync(backup, 'bytes', 'utf8');
    const when = new Date(NOW.getTime() - 300 * 86_400_000);
    utimesSync(backup, when, when);
    writeFileSync(join(backupDir, 'agenthropic-2026-08-06.db'), 'bytes', 'utf8');

    const policy: RetentionPolicy = {
      ...NO_RETENTION,
      events: { maxAgeDays: 30 },
      backupFiles: { directory: backupDir, maxAgeDays: 14, keepMinimum: 1 },
    };

    const dry = createRetentionRunner(temp.db, policy).run({ now: NOW, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.database?.tables[0]?.rowsMatched).toBe(1);
    expect(dry.database?.tables[0]?.rowsDeleted).toBe(0);
    expect(dry.backups?.deleted).toHaveLength(1);
    expect(existsSync(backup)).toBe(true);

    const wet = createRetentionRunner(temp.db, policy).run({ now: NOW });
    expect(wet.database?.applied).toBe(true);
    expect(wet.backups?.deleted).toHaveLength(1);
    expect(existsSync(backup)).toBe(false);
  });

  it('threads an explicit journal path through to the prune', () => {
    insertEvent(temp.db, 'k-old', OLD);
    const journalPath = join(temp.dir, 'explicit-journal.jsonl');

    const report = createRetentionRunner(temp.db, {
      ...NO_RETENTION,
      events: { maxAgeDays: 30 },
    }).run({ now: NOW, journalPath });

    expect(report.database?.journalPath).toBe(journalPath);
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(`${temp.path}${RETENTION_JOURNAL_SUFFIX}`)).toBe(false);
  });

  it('defaults `now` and `dryRun` when called with no options', () => {
    const before = Date.now();
    const report = createRetentionRunner(temp.db, NO_RETENTION).run();
    expect(new Date(report.ranAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(report.dryRun).toBe(false);
  });
});
