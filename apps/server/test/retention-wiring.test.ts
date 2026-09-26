/**
 * L9 - the one-line renderings the composition root logs: the policy
 * description at boot and the per-run line after every daily backup. Driven
 * through real runs on a migrated temp database so every branch of the
 * wording is exercised by the report shapes the runner actually produces.
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultJournalPath } from '../src/retention/journal';
import { NO_RETENTION, signedRetentionPolicy, type RetentionPolicy } from '../src/retention/policy';
import { createRetentionRunner } from '../src/retention/runner';
import { describeRetentionPolicy, retentionRunLine } from '../src/retention/summary';
import {
  countRows,
  createMigratedTempDb,
  insertAgent,
  insertProjectionEvent,
  insertSession,
  type TempDb,
} from './helpers';

const NOW = new Date('2026-09-10T00:00:00.000Z');
/** 90 days before NOW, the events cutoff of the signed policy. */
const EVENTS_CUTOFF = '2026-06-12T00:00:00.000Z';
/** 30 days before NOW, the backup-file cutoff of the signed policy. */
const BACKUP_CUTOFF = '2026-08-11T00:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';

describe('describeRetentionPolicy', () => {
  it('renders the no-op policy', () => {
    expect(describeRetentionPolicy(NO_RETENTION)).toBe(
      'events: keep forever; token_usage: never pruned; backup files: keep forever',
    );
  });

  it('renders the signed v1.0 policy', () => {
    expect(
      describeRetentionPolicy(
        signedRetentionPolicy({ eventsDays: 90, backupDays: 30, backupKeepMinimum: 7 }, '/b'),
      ),
    ).toBe(
      'events: prune after 90 day(s); token_usage: never pruned; ' +
        'backup files: expire after 30 day(s), always keeping the newest 7',
    );
  });

  it('says so out loud when a policy acknowledges cost loss', () => {
    const policy: RetentionPolicy = {
      ...NO_RETENTION,
      tokenUsage: { maxAgeDays: 400, acknowledgeCostLoss: true },
    };
    expect(describeRetentionPolicy(policy)).toBe(
      'events: keep forever; token_usage: prune after 400 day(s), cost loss acknowledged; ' +
        'backup files: keep forever',
    );
  });
});

describe('retentionRunLine', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function tempDb(): TempDb {
    const temp = createMigratedTempDb();
    cleanups.push(() => {
      temp.cleanup();
    });
    return temp;
  }

  function seedOldEvents(temp: TempDb, n: number): void {
    insertSession(temp.db, 's1');
    insertAgent(temp.db, 'a1', 's1');
    for (let i = 0; i < n; i += 1) {
      insertProjectionEvent(temp.db, `old-${String(i)}`, OLD);
    }
  }

  function seedStaleBackups(directory: string, n: number): void {
    mkdirSync(directory, { recursive: true });
    const at = new Date('2026-07-01T00:00:00.000Z');
    for (let i = 0; i < n; i += 1) {
      const path = join(directory, `agenthropic-stale-${String(i)}.db`);
      writeFileSync(path, 'stale');
      utimesSync(path, at, new Date(at.getTime() + i * 1000));
    }
  }

  it('no-op policy: the same words whether dry or real', () => {
    const temp = tempDb();
    const runner = createRetentionRunner(temp.db, NO_RETENTION);
    expect(retentionRunLine(runner.run({ now: NOW, dryRun: true }))).toBe(
      'retention dry run (nothing deleted): no rule configured, nothing to prune.',
    );
    expect(retentionRunLine(runner.run({ now: NOW }))).toBe(
      'retention: no rule configured, nothing to prune.',
    );
  });

  it('dry run: "would prune", the absent directory named, no receipt', () => {
    const temp = tempDb();
    seedOldEvents(temp, 3);
    const directory = join(temp.dir, 'backups');
    const runner = createRetentionRunner(
      temp.db,
      signedRetentionPolicy({ eventsDays: 90, backupDays: 30, backupKeepMinimum: 7 }, directory),
    );
    expect(retentionRunLine(runner.run({ now: NOW, dryRun: true }))).toBe(
      'retention dry run (nothing deleted): ' +
        `events: would prune 3 row(s) older than ${EVENTS_CUTOFF}; ` +
        `backup files: directory ${directory} absent, nothing to expire.`,
    );
    expect(countRows(temp.db, 'events')).toBe(3);
  });

  it('real run: "pruned", "+" when the budget was hit, and the receipt path', () => {
    const temp = tempDb();
    seedOldEvents(temp, 3);
    const directory = join(temp.dir, 'backups');
    const policy: RetentionPolicy = {
      ...signedRetentionPolicy({ eventsDays: 90, backupDays: 30, backupKeepMinimum: 7 }, directory),
      maxRowsPerRun: 2,
    };
    const runner = createRetentionRunner(temp.db, policy);
    expect(retentionRunLine(runner.run({ now: NOW }))).toBe(
      `retention: events: pruned 2+ row(s) older than ${EVENTS_CUTOFF}; ` +
        `backup files: directory ${directory} absent, nothing to expire; ` +
        `receipt ${defaultJournalPath(temp.path)}.`,
    );
    expect(countRows(temp.db, 'events')).toBe(1);
    // The next run finishes the job and no longer flags a budget hit.
    expect(retentionRunLine(runner.run({ now: NOW }))).toContain(
      `events: pruned 1 row(s) older than ${EVENTS_CUTOFF};`,
    );
  });

  it('a real run with nothing to delete writes no receipt', () => {
    const temp = tempDb();
    const runner = createRetentionRunner(
      temp.db,
      signedRetentionPolicy({ eventsDays: 90, backupDays: 0, backupKeepMinimum: 7 }, '/unused'),
    );
    expect(retentionRunLine(runner.run({ now: NOW }))).toBe(
      `retention: events: pruned 0 row(s) older than ${EVENTS_CUTOFF}.`,
    );
  });

  it('backup files: expired count, cutoff and the floor, dry and real', () => {
    const temp = tempDb();
    const directory = join(temp.dir, 'backups');
    seedStaleBackups(directory, 5);
    const runner = createRetentionRunner(
      temp.db,
      signedRetentionPolicy({ eventsDays: 0, backupDays: 30, backupKeepMinimum: 2 }, directory),
    );
    expect(retentionRunLine(runner.run({ now: NOW, dryRun: true }))).toBe(
      'retention dry run (nothing deleted): ' +
        `backup files: would expire 3 older than ${BACKUP_CUTOFF} (2 kept by the floor).`,
    );
    expect(retentionRunLine(runner.run({ now: NOW }))).toBe(
      `retention: backup files: expired 3 older than ${BACKUP_CUTOFF} (2 kept by the floor).`,
    );
    expect(retentionRunLine(runner.run({ now: NOW }))).toBe(
      `retention: backup files: expired 0 older than ${BACKUP_CUTOFF} (2 kept by the floor).`,
    );
  });
});
