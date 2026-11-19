/**
 * Assembly of the operational fields served on /api/health.
 *
 * Moved out of the composition root `index.ts` (ARC-4, 2026-11-19), which
 * re-exports it; `index.ts` keeps only the wiring in `start()`.
 */
import { statSync } from 'node:fs';
import type { OperationalHealth } from '../server';
import { type TickTroubleKind } from './tick-trouble';
import { type BackupState } from './backups';

/**
 * Assemble the R11 / OPS-5 health fields. Pure apart from two `stat` calls,
 * so it is tested directly. `ingest: null` (ingest off) omits the tick
 * fields; `backup: null` (scheduler not yet created) omits the backup fields;
 * an unreadable database file omits the size fields. A missing WAL file is a
 * genuine 0 (checkpointed and truncated), not an unknown.
 */
export function operationalHealth(input: {
  readonly dbPath: string;
  readonly ingest: {
    readonly lastTickAt: Date | null;
    readonly corpusTrouble: TickTroubleKind | null;
  } | null;
  readonly backup: BackupState | null;
  readonly hookDeliveries: NonNullable<OperationalHealth['hookDeliveries']>;
  /** Request time, for `lastBackupAgeSeconds`; the wall clock when omitted. */
  readonly now?: Date;
}): OperationalHealth {
  const result: { -readonly [K in keyof OperationalHealth]: OperationalHealth[K] } = {};
  if (input.ingest?.lastTickAt) {
    result.lastTickAt = input.ingest.lastTickAt.toISOString();
  }
  if (input.ingest?.corpusTrouble) {
    result.corpusTrouble = input.ingest.corpusTrouble;
  }
  if (input.backup?.lastBackupAt) {
    result.lastBackupAt = input.backup.lastBackupAt.toISOString();
    // OPS-17: the age a probe would otherwise compute against its own clock.
    // Never negative - a backup "from the future" is a clock step, not news.
    const now = input.now ?? new Date();
    result.lastBackupAgeSeconds = Math.max(
      0,
      Math.floor((now.getTime() - input.backup.lastBackupAt.getTime()) / 1000),
    );
  }
  if (input.backup?.lastError) {
    result.lastBackupError = input.backup.lastError;
  }
  if (input.backup?.mirror?.lastMirrorAt) {
    result.lastMirrorAt = input.backup.mirror.lastMirrorAt.toISOString();
  }
  if (input.backup?.mirror?.lastError) {
    result.lastMirrorError = input.backup.mirror.lastError;
  }
  const dbBytes = fileSize(input.dbPath);
  if (dbBytes !== null) {
    result.dbBytes = dbBytes;
    result.walBytes = fileSize(`${input.dbPath}-wal`) ?? 0;
  }
  result.hookDeliveries = { ...input.hookDeliveries };
  return result;
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
