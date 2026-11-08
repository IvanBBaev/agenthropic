/**
 * R13 (ARC-6, QA-3, DAT-7, DAT-11) - the format-drift census /api/health
 * reports, aggregated at request time from the per-session census columns
 * migration 26 added.
 *
 * Request-time, not a counter kept in memory: the census is a stored fact
 * about each session's latest parse, so the figure survives a restart that
 * the replay checkpoints turn into a no-op, and it can never disagree with
 * the rows. One pass over `sessions` per health request; at the census scale
 * of record (141 sessions) that is well under a millisecond.
 *
 * A stored value that does not have the expected shape (hand-edited, or
 * written by a future build) is skipped rather than thrown: a health probe
 * must keep answering, and the next ingest pass rewrites the row.
 */
import type { FormatDriftDto, VersionFormatDriftDto } from '@agenthropic/shared';
import type { SqliteDatabase } from './connection';

interface CensusRow {
  readonly claude_code_versions: string | null;
  readonly format_census: string | null;
}

type CountMap = Record<string, number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isCountMap(value: unknown): value is CountMap {
  return isRecord(value) && Object.values(value).every(isCount);
}

function isVersionCensus(value: unknown): value is VersionFormatDriftDto {
  return (
    isRecord(value) &&
    isCountMap(value['unknownRecordTypes']) &&
    isCountMap(value['unknownUsageKeys']) &&
    isCount(value['zeroUsageRecords'])
  );
}

interface StoredCensus {
  readonly malformedLines: number;
  readonly byVersion: Record<string, VersionFormatDriftDto>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readCensus(text: string): StoredCensus | undefined {
  const value = parseJson(text);
  if (!isRecord(value) || !isCount(value['malformedLines'])) return undefined;
  const byVersion = value['byVersion'];
  if (!isRecord(byVersion) || !Object.values(byVersion).every(isVersionCensus)) return undefined;
  return {
    malformedLines: value['malformedLines'],
    byVersion: byVersion as Record<string, VersionFormatDriftDto>,
  };
}

function readVersions(text: string): string[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function addInto(target: CountMap, source: CountMap): void {
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + count;
  }
}

function sortedCounts(map: CountMap): CountMap {
  const out: CountMap = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key]!;
  return out;
}

/** Aggregates every stored session census into the /api/health `formatDrift` field. */
export function readFormatDrift(db: SqliteDatabase): FormatDriftDto {
  const rows = db
    .prepare(
      `SELECT claude_code_versions, format_census FROM sessions
        WHERE claude_code_versions IS NOT NULL OR format_census IS NOT NULL`,
    )
    .all() as CensusRow[];

  let sessionsCensused = 0;
  let sessionsWithDrift = 0;
  let malformedLinesSkipped = 0;
  const versions: CountMap = {};
  const byVersion = new Map<
    string,
    { unknownRecordTypes: CountMap; unknownUsageKeys: CountMap; zeroUsageRecords: number }
  >();

  for (const row of rows) {
    if (row.claude_code_versions !== null) {
      for (const version of new Set(readVersions(row.claude_code_versions))) {
        versions[version] = (versions[version] ?? 0) + 1;
      }
    }
    const census = row.format_census === null ? undefined : readCensus(row.format_census);
    if (census === undefined) continue;
    sessionsCensused += 1;
    malformedLinesSkipped += census.malformedLines;
    const drifted = Object.keys(census.byVersion);
    if (census.malformedLines > 0 || drifted.length > 0) sessionsWithDrift += 1;
    for (const version of drifted) {
      const source = census.byVersion[version]!;
      let entry = byVersion.get(version);
      if (entry === undefined) {
        entry = { unknownRecordTypes: {}, unknownUsageKeys: {}, zeroUsageRecords: 0 };
        byVersion.set(version, entry);
      }
      addInto(entry.unknownRecordTypes, source.unknownRecordTypes);
      addInto(entry.unknownUsageKeys, source.unknownUsageKeys);
      entry.zeroUsageRecords += source.zeroUsageRecords;
    }
  }

  const byClaudeCodeVersion: Record<string, VersionFormatDriftDto> = {};
  for (const version of [...byVersion.keys()].sort()) {
    const entry = byVersion.get(version)!;
    byClaudeCodeVersion[version] = {
      unknownRecordTypes: sortedCounts(entry.unknownRecordTypes),
      unknownUsageKeys: sortedCounts(entry.unknownUsageKeys),
      zeroUsageRecords: entry.zeroUsageRecords,
    };
  }

  return {
    sessionsCensused,
    sessionsWithDrift,
    malformedLinesSkipped,
    claudeCodeVersions: sortedCounts(versions),
    byClaudeCodeVersion,
  };
}
