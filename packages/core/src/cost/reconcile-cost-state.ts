/**
 * DAT-10 - advisory reconciliation of Claude Code's own cost figure against
 * our dated price table: the pricing DRIFT ALARM.
 *
 * The check prices the cost-state record's OWN token counts with our rates and
 * asks whether Claude Code's OWN dollar figure falls inside the result. It
 * never compares against the transcript ledger: the cost-state counts calls
 * the JSONL never logs, so a transcript comparison would alarm on every
 * session (see `parser/cost-state.ts`). A drift verdict therefore means one
 * thing - the two sides price the same tokens differently: a rate changed
 * upstream and our table did not follow, or our table is wrong.
 *
 * Why a BAND, not a number. Two facts are not knowable from the record:
 *  - the TTL of cache writes the record does not split into 5m/1h (Claude
 *    Code splits only some of them): the unsplit remainder is priced at the
 *    cheaper TTL for the low bound and the dearer one for the high bound;
 *  - which rate was in force for which token, when a price changed during the
 *    session: each bucket is bounded by the lowest and highest rate in force
 *    at any instant of the session span.
 * The band is then widened by a relative tolerance for floating-point sums.
 * Measured on the 2026-11-19 corpus: all 763 checkable per-model entries were
 * inside the band (485 exactly, 278 by the cache-write interval), none outside.
 *
 * What it cannot check, and says so instead of guessing:
 *  - `unpriced`: a model or bucket with no rate in force for the whole span;
 *  - `unverifiable`: web-search requests (billed per request; we hold no such
 *    rate, so they are never priced here), a 5m/1h split larger than the
 *    total, or Claude Code's own `hasUnknownModelCost` flag. A web-search
 *    entry whose figure is BELOW our low bound is still `drift`: a per-request
 *    charge can only add to the figure.
 *  - tiered prompt pricing (`BASE_TIER_PROMPT_LIMITS`): the record aggregates
 *    requests, so the per-request tier is invisible and base-tier rates are
 *    used. A session that crossed a tier reads as drift above the band, which
 *    is the honest answer - the ledger refuses to price such a request too.
 *
 * ADVISORY ONLY (owner question #5 is open): nothing here feeds a stored
 * figure, a total or an alert. Pure and deterministic.
 */
import type { TokenBucket } from '@agenthropic/shared';
import type { PricingEntry } from '../types';
import type { CostStateModelUsage, CostStateSnapshot } from '../parser/cost-state';
import { buildPricingIndex, resolveRate, type DatedRate } from './compute-cost';

/** Default relative tolerance of the band: float sums, not pricing slack. */
export const COST_STATE_TOLERANCE = 1e-6;

/** Absolute slack, in USD, so a $0 figure against a $0 band is not a drift on rounding. */
const ABSOLUTE_SLACK_USD = 1e-9;

const USD_PER_TOKEN_DIVISOR = 1_000_000;

export type CostStateVerdict = 'in-band' | 'drift' | 'unverifiable' | 'unpriced';

/** Every verdict, worst first - the order a session takes its verdict from its models. */
export const COST_STATE_VERDICTS: readonly CostStateVerdict[] = [
  'drift',
  'unpriced',
  'unverifiable',
  'in-band',
];

export type CostStateUnverifiableReason =
  'web-search-requests' | 'cache-split-exceeds-total' | 'unknown-model-cost';

export interface ModelCostStateReconciliation {
  readonly model: string;
  readonly verdict: CostStateVerdict;
  /** Why the entry is `unverifiable` (or a web-search `drift`); null otherwise. */
  readonly reason: CostStateUnverifiableReason | null;
  /** Claude Code's own dollar figure for this model. */
  readonly reportedUsd: number;
  /** Our band for the same tokens; null when it cannot be computed. */
  readonly computedLowUsd: number | null;
  readonly computedHighUsd: number | null;
}

export interface CostStateReconciliation {
  /** The worst model verdict, raised to `unverifiable` by `hasUnknownModelCost`. */
  readonly verdict: CostStateVerdict;
  readonly reason: CostStateUnverifiableReason | null;
  /** Claude Code's `totalCostUSD`. */
  readonly reportedUsd: number;
  readonly models: readonly ModelCostStateReconciliation[];
}

/** The session's span, in epoch ms: every rate in force inside it bounds the band. */
export interface ReconcileSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

interface RateRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The lowest and highest rate in force at any instant of the span, or
 * undefined when some part of the span has no rate at all (the ledger would
 * leave those tokens unpriced too).
 */
function rateRange(
  rates: readonly DatedRate[] | undefined,
  span: ReconcileSpan,
): RateRange | undefined {
  const first = rates === undefined ? undefined : resolveRate(rates, span.fromMs);
  if (rates === undefined || first === undefined) return undefined;
  let min = first.usdPerMtok;
  let max = first.usdPerMtok;
  for (const rate of rates) {
    if (rate.effectiveFromMs > span.fromMs && rate.effectiveFromMs <= span.toMs) {
      min = Math.min(min, rate.usdPerMtok);
      max = Math.max(max, rate.usdPerMtok);
    }
  }
  return { min, max };
}

function reconcileModel(
  usage: CostStateModelUsage,
  buckets: ReadonlyMap<TokenBucket, DatedRate[]> | undefined,
  span: ReconcileSpan,
  tolerance: number,
): ModelCostStateReconciliation {
  const base = { model: usage.model, reportedUsd: usage.costUsd };
  const split5m = usage.cacheCreation5mInputTokens ?? 0;
  const split1h = usage.cacheCreation1hInputTokens ?? 0;
  const unsplit = usage.cacheCreationInputTokens - split5m - split1h;
  if (unsplit < 0) {
    return {
      ...base,
      verdict: 'unverifiable',
      reason: 'cache-split-exceeds-total',
      computedLowUsd: null,
      computedHighUsd: null,
    };
  }

  let low = 0;
  let high = 0;
  let priced = true;
  const add = (bucket: TokenBucket, tokens: number): void => {
    if (tokens === 0) return;
    const range = rateRange(buckets?.get(bucket), span);
    if (range === undefined) {
      priced = false;
      return;
    }
    low += tokens * range.min;
    high += tokens * range.max;
  };
  add('input', usage.inputTokens);
  add('output', usage.outputTokens);
  add('cache_read', usage.cacheReadInputTokens);
  add('cache_write_5m', split5m);
  add('cache_write_1h', split1h);
  if (unsplit > 0) {
    const fiveMinute = rateRange(buckets?.get('cache_write_5m'), span);
    const oneHour = rateRange(buckets?.get('cache_write_1h'), span);
    if (fiveMinute === undefined || oneHour === undefined) {
      priced = false;
    } else {
      low += unsplit * Math.min(fiveMinute.min, oneHour.min);
      high += unsplit * Math.max(fiveMinute.max, oneHour.max);
    }
  }
  if (!priced) {
    return {
      ...base,
      verdict: 'unpriced',
      reason: null,
      computedLowUsd: null,
      computedHighUsd: null,
    };
  }

  const computedLowUsd = low / USD_PER_TOKEN_DIVISOR;
  const computedHighUsd = high / USD_PER_TOKEN_DIVISOR;
  const belowBand = usage.costUsd < computedLowUsd * (1 - tolerance) - ABSOLUTE_SLACK_USD;
  const aboveBand = usage.costUsd > computedHighUsd * (1 + tolerance) + ABSOLUTE_SLACK_USD;
  const bounds = { computedLowUsd, computedHighUsd };
  if (usage.webSearchRequests > 0) {
    return {
      ...base,
      ...bounds,
      verdict: belowBand ? 'drift' : 'unverifiable',
      reason: 'web-search-requests',
    };
  }
  return {
    ...base,
    ...bounds,
    verdict: belowBand || aboveBand ? 'drift' : 'in-band',
    reason: null,
  };
}

function worstOf(verdicts: readonly CostStateVerdict[]): CostStateVerdict {
  return COST_STATE_VERDICTS.find((verdict) => verdicts.includes(verdict)) ?? 'in-band';
}

/**
 * Reconciles one cost-state snapshot against the price table over the
 * session span. Throws `PricingError` on a malformed pricing table (the same
 * validation the ledger applies) and `RangeError` on an invalid span or
 * tolerance; never on the snapshot itself.
 */
export function reconcileCostState(
  snapshot: CostStateSnapshot,
  pricing: readonly PricingEntry[],
  span: ReconcileSpan,
  tolerance: number = COST_STATE_TOLERANCE,
): CostStateReconciliation {
  if (!Number.isFinite(span.fromMs) || !Number.isFinite(span.toMs) || span.fromMs > span.toMs) {
    throw new RangeError(
      `reconcileCostState: span must be finite with fromMs <= toMs (got ${String(span.fromMs)}..${String(span.toMs)})`,
    );
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(
      `reconcileCostState: tolerance must be a non-negative finite number (got ${String(tolerance)})`,
    );
  }
  const index = buildPricingIndex(pricing);
  const models = snapshot.models.map((usage) =>
    reconcileModel(usage, index.get(usage.model), span, tolerance),
  );
  const modelVerdict = worstOf(models.map((model) => model.verdict));
  if (snapshot.hasUnknownModelCost && modelVerdict === 'in-band') {
    return {
      verdict: 'unverifiable',
      reason: 'unknown-model-cost',
      reportedUsd: snapshot.totalCostUsd,
      models,
    };
  }
  return { verdict: modelVerdict, reason: null, reportedUsd: snapshot.totalCostUsd, models };
}
