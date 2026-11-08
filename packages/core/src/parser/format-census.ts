/**
 * Format-drift census (R13 - ARC-6, QA-3, DAT-7, DAT-11).
 *
 * The parser tolerates what it has no rule for: an unknown record `type` is
 * ignored, an unknown `usage` key is never read, and a renamed usage key reads
 * as zero tokens. That tolerance is correct, but it is also silent - an
 * upstream rename would under-report dollars with every test green. This
 * census counts those cases per session, so a format change shows up on
 * `/api/health` before the figures go wrong.
 *
 * "Known" here means "seen in the corpus census of record", not "handled by
 * the parser": most known record types (`api-request`, `atis-latch`, ...) have
 * no parser rule and need none. The lists below were taken from a read-only
 * scan of every `~/.claude/projects` transcript on 2026-11-08 (3062 files,
 * 1,548,727 records, 0 non-JSON lines). A type or key outside them is new
 * since that scan. Adding one here, after checking it does not carry tokens
 * the parser misses, is how a drift report is acknowledged.
 *
 * Pure and deterministic: every map is built with sorted keys, so the same
 * substrate always serializes to the same JSON (the byte-identical replay
 * proof depends on it).
 */

/** Every top-level record `type` in the 2026-11-08 corpus scan, plus `progress` (gate #7). */
export const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set([
  'agent-name',
  'ai-title',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'assistant',
  'atis-latch',
  'attachment',
  'bridge-session',
  'cost-state',
  'custom-title',
  'file-history-delta',
  'file-history-snapshot',
  'fork-context-ref',
  'frame-link',
  'last-prompt',
  'launched',
  'mode',
  'pr-link',
  // Pre-2.1.71 progress lines carry the legacy `agentId` anchor (gate #7);
  // absent from the current corpus but read by the parser.
  'progress',
  'queue-operation',
  'result',
  'started',
  'system',
  'tools-used',
  'user',
]);

/** Every key of an assistant `message.usage` block in the 2026-11-08 corpus scan. */
export const KNOWN_USAGE_KEYS: ReadonlySet<string> = new Set([
  'cache_creation',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'fallback_credit',
  'inference_geo',
  'input_tokens',
  'iterations',
  'output_tokens',
  'output_tokens_details',
  'server_tool_use',
  'service_tier',
  'speed',
]);

/** Every key of `usage.cache_creation` in the same scan. Reported as `cache_creation.<key>`. */
export const KNOWN_CACHE_CREATION_KEYS: ReadonlySet<string> = new Set([
  'ephemeral_1h_input_tokens',
  'ephemeral_5m_input_tokens',
]);

/** Census key for a record that is not a JSON object or has no string `type`. */
export const MISSING_RECORD_TYPE = '(missing)';

/** Census key for drift on records before the first `version` of their transcript. */
export const UNVERSIONED = '(none)';

/**
 * The `<synthetic>` model marks a record Claude Code wrote itself (an
 * interruption, an API error notice). It always carries an all-zero usage
 * block and is priced at $0, so it is not counted as a zero-usage record.
 */
const SYNTHETIC_MODEL = '<synthetic>';

/** Drift observed on the records of one Claude Code version. */
export interface VersionFormatCensus {
  /** Record `type` -> records whose type is outside {@link KNOWN_RECORD_TYPES}. */
  unknownRecordTypes: Record<string, number>;
  /** Usage key -> assistant usage blocks carrying a key outside the known lists. */
  unknownUsageKeys: Record<string, number>;
  /**
   * Non-synthetic assistant records whose usage block maps to zero tokens in
   * every bucket. A few are real (an aborted request); a sudden rise means a
   * bucket key was renamed and is now read as zero.
   */
  zeroUsageRecords: number;
}

/** The census of one session's latest parse. */
export interface FormatCensus {
  /**
   * Non-blank lines that were not valid JSON, across every file of the
   * session. Each was skipped (DAT-7); a skipped assistant line takes its
   * tokens with it, so a non-zero count makes the session's totals a lower
   * bound.
   */
  malformedLines: number;
  /**
   * Drift by Claude Code version, keyed by the `version` in force at the
   * record: the record's own `version`, else the last one seen earlier in the
   * same transcript, else the transcript's first one ({@link UNVERSIONED} when
   * the transcript has none). Only versions with drift appear; `{}` is a clean
   * session.
   */
  byVersion: Record<string, VersionFormatCensus>;
}

/** One file as the census sees it: transcript or not, and its decoded records. */
export interface CensusFile {
  /** True for a main or `agent-<hex>` transcript; sidecars and journals are not censused. */
  readonly isTranscript: boolean;
  readonly records: readonly unknown[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function versionOf(record: JsonRecord | undefined): string | undefined {
  const version = record?.['version'];
  return typeof version === 'string' && version !== '' ? version : undefined;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedObject(map: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...map.keys()].sort()) {
    out[key] = map.get(key)!;
  }
  return out;
}

interface MutableVersionCensus {
  unknownRecordTypes: Map<string, number>;
  unknownUsageKeys: Map<string, number>;
  zeroUsageRecords: number;
}

/** The usage keys of one block that are outside the known lists. */
function unknownUsageKeys(usage: JsonRecord): string[] {
  const unknown = Object.keys(usage).filter((key) => !KNOWN_USAGE_KEYS.has(key));
  const cacheCreation = asRecord(usage['cache_creation']);
  if (cacheCreation !== undefined) {
    for (const key of Object.keys(cacheCreation)) {
      if (!KNOWN_CACHE_CREATION_KEYS.has(key)) unknown.push(`cache_creation.${key}`);
    }
  }
  return unknown;
}

function isZero(value: unknown): boolean {
  return value === undefined || value === null || value === 0;
}

/**
 * True when every bucket the parser reads is absent, null or 0. Non-numeric
 * values are not "zero" - they fail the usage validator loudly instead.
 */
function isAllZeroUsage(usage: JsonRecord): boolean {
  const cacheCreation = asRecord(usage['cache_creation']);
  return (
    isZero(usage['input_tokens']) &&
    isZero(usage['output_tokens']) &&
    isZero(usage['cache_read_input_tokens']) &&
    isZero(usage['cache_creation_input_tokens']) &&
    isZero(cacheCreation?.['ephemeral_5m_input_tokens']) &&
    isZero(cacheCreation?.['ephemeral_1h_input_tokens'])
  );
}

/** Builds the census for one session from its decoded files and the malformed-line count. */
export function censusFormat(files: readonly CensusFile[], malformedLines: number): FormatCensus {
  const byVersion = new Map<string, MutableVersionCensus>();
  const at = (version: string): MutableVersionCensus => {
    let entry = byVersion.get(version);
    if (entry === undefined) {
      entry = { unknownRecordTypes: new Map(), unknownUsageKeys: new Map(), zeroUsageRecords: 0 };
      byVersion.set(version, entry);
    }
    return entry;
  };

  for (const file of files) {
    if (!file.isTranscript) continue;
    let current: string | undefined;
    for (const value of file.records) {
      current = versionOf(asRecord(value));
      if (current !== undefined) break;
    }
    const firstVersion = current ?? UNVERSIONED;
    let inForce = firstVersion;

    for (const value of file.records) {
      const record = asRecord(value);
      inForce = versionOf(record) ?? inForce;
      const type = record?.['type'];
      if (typeof type !== 'string') {
        increment(at(inForce).unknownRecordTypes, MISSING_RECORD_TYPE);
        continue;
      }
      if (!KNOWN_RECORD_TYPES.has(type)) {
        increment(at(inForce).unknownRecordTypes, type);
        continue;
      }
      if (type !== 'assistant') continue;
      const message = asRecord(record?.['message']);
      const usage = asRecord(message?.['usage']);
      if (usage === undefined) continue;
      for (const key of unknownUsageKeys(usage)) {
        increment(at(inForce).unknownUsageKeys, key);
      }
      if (message?.['model'] !== SYNTHETIC_MODEL && isAllZeroUsage(usage)) {
        at(inForce).zeroUsageRecords += 1;
      }
    }
  }

  const out: Record<string, VersionFormatCensus> = {};
  for (const version of [...byVersion.keys()].sort()) {
    const entry = byVersion.get(version)!;
    out[version] = {
      unknownRecordTypes: sortedObject(entry.unknownRecordTypes),
      unknownUsageKeys: sortedObject(entry.unknownUsageKeys),
      zeroUsageRecords: entry.zeroUsageRecords,
    };
  }
  return { malformedLines, byVersion: out };
}
