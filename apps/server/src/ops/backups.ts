/**
 * The daily backup scheduler, its mirror and WAL checkpoint, and backup-age probes.
 *
 * Moved out of the composition root `index.ts` (ARC-4, 2026-11-19), which
 * re-exports it; `index.ts` keeps only the wiring in `start()`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backupDatabase } from '../db/backup';
import { assertDistinctMirror, mirrorBackupFile } from '../db/backup-mirror';
import type { SqliteDatabase } from '../db/connection';
import type { RetentionPort } from '../retention/port';
import { RetentionRunError } from '../retention/runner';
import { retentionRunLine } from '../retention/summary';

/**
 * Backup cadence (review M-20: `events_raw` is the one non-re-derivable table,
 * and a backup capability nothing runs is not a backup). The expiry window and
 * the keep-minimum floor used to sit here as PROVISIONAL constants; since D3
 * (2026-09-08) they are configuration - `DASHBOARD_RETENTION_BACKUP_DAYS` and
 * `DASHBOARD_RETENTION_BACKUP_KEEP_MIN` in `config.ts` - and reach this timer
 * inside the retention policy. The cadence itself stays a constant.
 */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BackupScheduler {
  /**
   * One backup and - only when that backup succeeded - one retention pass.
   * Exactly what the daily timer fires.
   */
  runOnce(): Promise<void>;
  /** Clear the daily timer. Idempotent; wired into server close. */
  stop(): void;
  /**
   * R11: the newest successful backup and the most recent failure, for
   * /api/health. `lastError` is cleared by the next successful backup.
   */
  state(): BackupState;
}

export interface BackupState {
  readonly lastBackupAt: Date | null;
  readonly lastError: string | null;
  /** OPS-17: present only when a mirror directory is configured. */
  readonly mirror?: BackupMirrorState;
}

/** OPS-17: the newest mirrored copy and the most recent mirror failure. */
export interface BackupMirrorState {
  readonly lastMirrorAt: Date | null;
  readonly lastError: string | null;
}

/**
 * Newest finished backup already in `directory` (by mtime), so /api/health
 * knows the last backup from the moment of boot, not only after the first
 * daily cycle of this process. A missing or unreadable directory is `null`;
 * an in-flight `.partial` is not a backup.
 */
export function newestBackupTime(directory: string): Date | null {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  let newest: Date | null = null;
  for (const name of names) {
    if (!name.startsWith('agenthropic-') || !name.endsWith('.db')) {
      continue;
    }
    try {
      const mtime = statSync(join(directory, name)).mtime;
      if (newest === null || mtime > newest) {
        newest = mtime;
      }
    } catch {
      // Removed between readdir and stat (retention, an operator) - skip it.
    }
  }
  return newest;
}

/**
 * Schedule daily database backups into `directory`
 * (`agenthropic-<timestamp>.db`, the documented naming convention the
 * backup-file prune recognizes), with the retention pass chained after each
 * write (L9 wiring of WP-D10). Each cycle:
 *  1. writes a dated backup into `directory`;
 *  2. if, and only if, that succeeded, runs `retention` at the cycle's `now` -
 *     so every prune, of rows or of backup files, is preceded by a fresh
 *     safety copy, and a cycle whose backup failed deletes nothing at all;
 *  3. logs one line for the backup and one for the retention pass. Deleted
 *     rows are also written to the retention journal beside the database (the
 *     prune does that inside its own delete transaction).
 * A throwing runner is logged and never propagates: the timer keeps ticking,
 * and the next cycle tries again after its own backup.
 *
 * The timer is `unref`-ed: a backup schedule must never be what keeps a
 * process that already closed its server alive. A failed run logs and waits
 * for the next tick - the server outliving its backup beats the reverse.
 */
/** One `PRAGMA wal_checkpoint` row, as better-sqlite3 returns it. */
export interface WalCheckpointResult {
  /** True when the checkpoint could not complete because another connection held the WAL. */
  readonly busy: boolean;
}

/** Fold the WAL into the database and truncate the -wal file to zero bytes. */
export function checkpointWal(db: SqliteDatabase): WalCheckpointResult {
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
  return { busy: rows.some((row) => row.busy === 1) };
}

export function scheduleDailyBackups(
  db: SqliteDatabase,
  directory: string,
  retention: RetentionPort,
  options: {
    readonly intervalMs?: number;
    readonly now?: () => Date;
    readonly backup?: (db: SqliteDatabase, destPath: string) => Promise<void>;
    readonly log?: (line: string) => void;
    readonly logError?: (line: string) => void;
    /** Seed for `state().lastBackupAt`, normally {@link newestBackupTime}. */
    readonly lastBackupAt?: Date | null;
    /** The end-of-cycle WAL checkpoint; {@link checkpointWal} unless a test needs a busy one. */
    readonly checkpoint?: (db: SqliteDatabase) => WalCheckpointResult;
    /**
     * OPS-17: copy each successful backup here too (`DASHBOARD_BACKUP_MIRROR_DIR`).
     * Omitted or null - no mirror. Must not be `directory` itself.
     */
    readonly mirrorDirectory?: string | null;
    /** Seed for the mirror's `lastMirrorAt`, normally {@link newestBackupTime} of the mirror. */
    readonly lastMirrorAt?: Date | null;
    /** The copy step; {@link mirrorBackupFile} unless a test needs a failing one. */
    readonly mirror?: (sourcePath: string, mirrorDirectory: string) => string;
  } = {},
): BackupScheduler {
  const intervalMs = options.intervalMs ?? BACKUP_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const backup = options.backup ?? backupDatabase;
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  const checkpoint = options.checkpoint ?? checkpointWal;
  const mirrorDirectory = options.mirrorDirectory ?? null;
  if (mirrorDirectory !== null) {
    assertDistinctMirror(directory, mirrorDirectory);
  }
  const mirror = options.mirror ?? mirrorBackupFile;
  let running = false;
  let lastBackupAt = options.lastBackupAt ?? null;
  let lastError: string | null = null;
  let lastMirrorAt = options.lastMirrorAt ?? null;
  let lastMirrorError: string | null = null;

  /**
   * OPS-17: a failed mirror is logged and reported, never fatal. The local
   * backup exists, so retention still runs - the mirror is the extra copy,
   * not the one the safety contract is built on.
   */
  function runMirror(sourcePath: string, at: Date): void {
    if (mirrorDirectory === null) {
      return;
    }
    try {
      const mirrored = mirror(sourcePath, mirrorDirectory);
      lastMirrorAt = at;
      lastMirrorError = null;
      log(`database backup mirror: wrote ${mirrored}.`);
    } catch (error) {
      lastMirrorError = error instanceof Error ? error.message : String(error);
      logError(`database backup mirror failed: ${lastMirrorError}`);
    }
  }

  function runRetention(at: Date): void {
    try {
      log(retentionRunLine(retention.run({ now: at })));
    } catch (error) {
      logError(`retention failed: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof RetentionRunError) {
        // What the pass had already deleted before it stopped - rows and
        // backup files are gone either way, so the record must not be.
        logError(
          `retention failed part-way; completed before the failure - ${retentionRunLine(error.report)}`,
        );
      }
    }
  }

  async function runOnce(): Promise<void> {
    if (running) {
      // The online backup yields between pages, so a manual `runOnce` COULD
      // overlap a timer-fired one - never two writers into the directory.
      return;
    }
    running = true;
    try {
      const at = now();
      const destPath = join(directory, `agenthropic-${at.toISOString().replace(/[:.]/g, '-')}.db`);
      await backup(db, destPath);
      lastBackupAt = at;
      lastError = null;
      log(`database backup: wrote ${destPath}.`);
      runMirror(destPath, at);
      // Reached only after a successful backup - the contract above.
      runRetention(at);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logError(`database backup failed: ${lastError}`);
    } finally {
      runCheckpoint();
      running = false;
    }
  }

  function runCheckpoint(): void {
    // R19: every cycle, whatever the backup did. Autocheckpoint folds the WAL
    // back in but never shrinks the file; after a day of ingest and a
    // retention pass, TRUNCATE gives the -wal file's space back. Quiet when it
    // succeeds - a busy or failed one is worth a line, the next cycle retries.
    try {
      const result = checkpoint(db);
      if (result.busy) {
        log('wal checkpoint: busy (a reader held the WAL); retrying next cycle.');
      }
    } catch (error) {
      logError(`wal checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref();

  return {
    runOnce,
    stop(): void {
      clearInterval(timer);
    },
    state(): BackupState {
      if (mirrorDirectory === null) {
        return { lastBackupAt, lastError };
      }
      return { lastBackupAt, lastError, mirror: { lastMirrorAt, lastError: lastMirrorError } };
    },
  };
}
