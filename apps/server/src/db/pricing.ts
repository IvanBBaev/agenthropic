/**
 * WP-C1/WP-C2 - read path for the versioned model pricing table.
 *
 * Loads every seeded (model, bucket, effective_from) price row and maps each
 * snake_case column onto the camelCase {@link PricingEntry} the cost engine
 * consumes. No normalization and no sorting happen here: `computeCostUsd`
 * builds its own dated index and sorts effective-from internally.
 */
import type { PricingEntry } from '@agenthropic/core';
import type { TokenBucket } from '@agenthropic/shared';
import type { SqliteDatabase } from './connection';

interface ModelPricingRow {
  readonly model: string;
  readonly bucket: string;
  readonly usd_per_mtok: number;
  readonly effective_from: string;
}

/** Load all `model_pricing` rows as cost-engine {@link PricingEntry} values. */
export function loadPricing(db: SqliteDatabase): readonly PricingEntry[] {
  const rows = db
    .prepare('SELECT model, bucket, usd_per_mtok, effective_from FROM model_pricing')
    .all() as ModelPricingRow[];
  return rows.map((row) => ({
    model: row.model,
    bucket: row.bucket as TokenBucket,
    usdPerMtok: row.usd_per_mtok,
    effectiveFrom: row.effective_from,
  }));
}
