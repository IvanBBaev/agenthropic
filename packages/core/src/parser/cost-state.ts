/**
 * DAT-10 - Claude Code's own cost ledger, read as ADVISORY evidence.
 *
 * Claude Code appends a `type: 'cost-state'` record to the main transcript: its
 * running per-model token counts and the dollar figure it computed for them
 * (`totalCostUSD`, `modelUsage[model].costUSD`). The record is cumulative - in
 * the 2026-11-19 corpus scan 234 of 235 multi-record sessions only ever grew -
 * so the LAST valid record is the session's latest state. No subagent
 * transcript carried one.
 *
 * It is NOT ground truth and never replaces the ledger. Its token counts do not
 * match the transcript: it also counts calls the JSONL never logs (title
 * generation and other side calls), and only 106 of 875 per-model entries
 * matched the transcript's tokens. What it IS good for is a pricing drift
 * alarm: price ITS OWN token counts with our dated rates and compare with ITS
 * OWN dollar figure (see `reconcileCostState`).
 *
 * Tolerant like the rest of the parser: a record that does not have the
 * expected shape is skipped and counted, never thrown.
 */

/** One model's entry of a cost-state record's `modelUsage` map. */
export interface CostStateModelUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  /** Every cache-write token, whatever its TTL. */
  readonly cacheCreationInputTokens: number;
  /** The 5-minute part of the cache writes; null when the record does not split them by TTL. */
  readonly cacheCreation5mInputTokens: number | null;
  /** The 1-hour part of the cache writes; null when the record does not split them by TTL. */
  readonly cacheCreation1hInputTokens: number | null;
  /** Server-side web searches - billed per request, not per token. */
  readonly webSearchRequests: number;
  /** The dollar figure Claude Code computed for this model. */
  readonly costUsd: number;
}

/** The latest valid cost-state record of a session, normalized. */
export interface CostStateSnapshot {
  readonly totalCostUsd: number;
  /** Claude Code's own flag that it could not price some model. */
  readonly hasUnknownModelCost: boolean;
  /** Sorted by model id, so the stored JSON is deterministic. */
  readonly models: readonly CostStateModelUsage[];
}

/** What the parser read of a session's cost-state records. */
export interface ParsedCostState {
  /** Valid cost-state records in the main transcript. */
  readonly records: number;
  /** Cost-state records skipped because their shape was not the expected one. */
  readonly malformedRecords: number;
  /** The last valid record; null when every record was malformed. */
  readonly latest: CostStateSnapshot | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDollars(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** An optional count: absent reads as `fallback`, present must be a token count. */
function optionalCount<T>(value: unknown, fallback: T): number | T | undefined {
  if (value === undefined) return fallback;
  return isTokenCount(value) ? value : undefined;
}

function readModelUsage(model: string, value: unknown): CostStateModelUsage | undefined {
  const entry = asRecord(value);
  if (entry === undefined) return undefined;
  const {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    costUSD: costUsd,
  } = entry;
  if (
    !isTokenCount(inputTokens) ||
    !isTokenCount(outputTokens) ||
    !isTokenCount(cacheReadInputTokens) ||
    !isTokenCount(cacheCreationInputTokens) ||
    !isDollars(costUsd)
  ) {
    return undefined;
  }
  const cacheCreation5mInputTokens = optionalCount(
    entry['cacheCreationEphemeral5mInputTokens'],
    null,
  );
  const cacheCreation1hInputTokens = optionalCount(
    entry['cacheCreationEphemeral1hInputTokens'],
    null,
  );
  const webSearchRequests = optionalCount(entry['webSearchRequests'], 0);
  if (
    cacheCreation5mInputTokens === undefined ||
    cacheCreation1hInputTokens === undefined ||
    webSearchRequests === undefined
  ) {
    return undefined;
  }
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheCreation5mInputTokens,
    cacheCreation1hInputTokens,
    webSearchRequests,
    costUsd,
  };
}

function readSnapshot(record: JsonRecord): CostStateSnapshot | undefined {
  const totalCostUsd = record['totalCostUSD'];
  const flag = record['hasUnknownModelCost'] ?? false;
  const modelUsage = asRecord(record['modelUsage']);
  if (!isDollars(totalCostUsd) || typeof flag !== 'boolean' || modelUsage === undefined) {
    return undefined;
  }
  const models: CostStateModelUsage[] = [];
  for (const model of Object.keys(modelUsage).sort()) {
    const usage = readModelUsage(model, modelUsage[model]);
    if (usage === undefined) return undefined;
    models.push(usage);
  }
  return { totalCostUsd, hasUnknownModelCost: flag, models };
}

/**
 * Reads the cost-state records of a session's MAIN transcript, in file order.
 * Returns null when there is none at all - most sessions written before Claude
 * Code began emitting the record.
 */
export function extractCostState(mainRecords: readonly unknown[]): ParsedCostState | null {
  let records = 0;
  let malformedRecords = 0;
  let latest: CostStateSnapshot | null = null;
  for (const value of mainRecords) {
    const record = asRecord(value);
    if (record?.['type'] !== 'cost-state') continue;
    const snapshot = readSnapshot(record);
    if (snapshot === undefined) {
      malformedRecords += 1;
    } else {
      records += 1;
      latest = snapshot;
    }
  }
  return records + malformedRecords === 0 ? null : { records, malformedRecords, latest };
}
