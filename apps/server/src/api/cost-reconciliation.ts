/**
 * DAT-10 - the advisory pricing drift alarm behind `GET /api/cost/reconciliation`.
 *
 * Each session whose main transcript carried a `cost-state` record has the
 * latest valid one stored in `sessions.cost_state` (migration 29). This read
 * reconciles every such snapshot against the CURRENT price table, at request
 * time, so a price row seeded or corrected later is reflected at once and no
 * stored verdict can go stale. The verdict logic is `reconcileCostState` in
 * core; this module only selects the rows, skips what it cannot read, and
 * aggregates.
 *
 * Tolerant like the format-drift census: a stored value that does not have
 * the expected shape (hand-edited, or written by a future build) is counted
 * as `unreadable` and skipped, never thrown - the next ingest pass rewrites
 * it. A malformed PRICE TABLE is different: it is the same failure the ledger
 * refuses on, so `PricingError` propagates to the route.
 */
import {
  COST_STATE_TOLERANCE,
  COST_STATE_VERDICTS,
  reconcileCostState,
  type CostStateModelUsage,
  type CostStateReconciliation,
  type CostStateSnapshot,
  type PricingEntry,
} from '@agenthropic/core';
import {
  MAX_RECONCILIATION_SAMPLE,
  type CostReconciliationDto,
  type SessionCostReconciliationDto,
} from '@agenthropic/shared';
import type { SqliteDatabase } from '../db/connection';
import { COST_USD, pricedCte } from './queries';

interface CostStateRow {
  readonly id: string;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly cost_state: string;
}

interface StoredCostState {
  readonly malformedRecords: number;
  readonly latest: CostStateSnapshot | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDollars(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const MODEL_COUNT_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
] as const;

const MODEL_SPLIT_KEYS = ['cacheCreation5mInputTokens', 'cacheCreation1hInputTokens'] as const;

function isModelUsage(value: unknown): value is CostStateModelUsage {
  return (
    isRecord(value) &&
    typeof value['model'] === 'string' &&
    isDollars(value['costUsd']) &&
    MODEL_COUNT_KEYS.every((key) => isCount(value[key])) &&
    MODEL_SPLIT_KEYS.every((key) => value[key] === null || isCount(value[key]))
  );
}

function isSnapshot(value: unknown): value is CostStateSnapshot {
  return (
    isRecord(value) &&
    isDollars(value['totalCostUsd']) &&
    typeof value['hasUnknownModelCost'] === 'boolean' &&
    Array.isArray(value['models']) &&
    value['models'].every(isModelUsage)
  );
}

function readStored(text: string): StoredCostState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isCount(value['malformedRecords'])) return undefined;
  const latest = value['latest'];
  if (latest !== null && !isSnapshot(latest)) return undefined;
  return { malformedRecords: value['malformedRecords'], latest };
}

/** The session span in epoch ms, or undefined when it cannot bound a rate lookup. */
function spanOf(row: CostStateRow): { fromMs: number; toMs: number } | undefined {
  const fromMs = row.started_at === null ? Number.NaN : Date.parse(row.started_at);
  const toMs = row.last_activity_at === null ? Number.NaN : Date.parse(row.last_activity_at);
  return Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs <= toMs
    ? { fromMs, toMs }
    : undefined;
}

type Reconciled = CostStateReconciliation & { readonly sessionId: string };

function rank(entry: Reconciled): number {
  return COST_STATE_VERDICTS.indexOf(entry.verdict);
}

/**
 * Worst verdict first, then the dearest. Ties keep id order: the rows are read
 * `ORDER BY id` and `Array.prototype.sort` is stable, so the sample is
 * deterministic without a third key.
 */
function compareReconciled(a: Reconciled, b: Reconciled): number {
  return rank(a) - rank(b) || b.reportedUsd - a.reportedUsd;
}

/** What our ledger prices each sampled session's stored usage at (absent = $0). */
function ledgerUsdBySession(db: SqliteDatabase, ids: readonly string[]): Map<string, number> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `WITH ${pricedCte(`WHERE tu.session_id IN (${placeholders})`)}
       SELECT session_id, ${COST_USD} AS cost_usd FROM priced GROUP BY session_id`,
    )
    .all(...ids) as Array<{ session_id: string; cost_usd: number }>;
  return new Map(rows.map((row) => [row.session_id, row.cost_usd]));
}

export function getCostReconciliation(
  db: SqliteDatabase,
  pricing: readonly PricingEntry[],
): CostReconciliationDto {
  const rows = db
    .prepare(
      `SELECT id, started_at, last_activity_at, cost_state
       FROM sessions WHERE cost_state IS NOT NULL ORDER BY id`,
    )
    .all() as CostStateRow[];

  const skipped = { noValidRecord: 0, noSpan: 0, unreadable: 0 };
  const verdicts = { drift: 0, unpriced: 0, unverifiable: 0, inBand: 0 };
  let malformedRecords = 0;
  let reportedUsd = 0;
  const reconciled: Reconciled[] = [];
  for (const row of rows) {
    const stored = readStored(row.cost_state);
    if (stored === undefined) {
      skipped.unreadable += 1;
      continue;
    }
    malformedRecords += stored.malformedRecords;
    if (stored.latest === null) {
      skipped.noValidRecord += 1;
      continue;
    }
    const span = spanOf(row);
    if (span === undefined) {
      skipped.noSpan += 1;
      continue;
    }
    const result = reconcileCostState(stored.latest, pricing, span);
    verdicts[result.verdict === 'in-band' ? 'inBand' : result.verdict] += 1;
    reportedUsd += result.reportedUsd;
    reconciled.push({ ...result, sessionId: row.id });
  }

  const sample = reconciled.sort(compareReconciled).slice(0, MAX_RECONCILIATION_SAMPLE);
  const ledger = ledgerUsdBySession(
    db,
    sample.map((entry) => entry.sessionId),
  );
  const sessions: SessionCostReconciliationDto[] = sample.map((entry) => ({
    sessionId: entry.sessionId,
    verdict: entry.verdict,
    reason: entry.reason,
    reportedUsd: entry.reportedUsd,
    ledgerUsd: ledger.get(entry.sessionId) ?? 0,
    models: entry.models.map((model) => ({ ...model })),
  }));

  return {
    isAdvisory: true,
    tolerance: COST_STATE_TOLERANCE,
    sessionsWithCostState: rows.length,
    sessionsReconciled: reconciled.length,
    skipped,
    verdicts,
    reportedUsd,
    malformedRecords,
    sessions,
  };
}
