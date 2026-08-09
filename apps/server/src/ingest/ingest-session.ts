/**
 * WP-IN9 - session ingest integrator: the write-side composition root that
 * turns a read substrate into persisted rows.
 *
 * Pipeline order is load-bearing:
 *   parseSession -> computeCostUsd (the HALT GATE) -> normalizeSession -> projectSession
 * The cost call runs BEFORE any DB write, so an unknown model id throws
 * PricingError while the database is still untouched - no partial session,
 * agent or usage rows are ever committed for an unpriceable substrate.
 *
 * The two steps after the gate are the WP-IN6 / WP-IN7 pair, and the split is
 * the point:
 *   - {@link normalizeSession} is PURE (no db, no clock, no IO). It decides the
 *     row shapes, the parent-first agent ordering the self-FK demands, and which
 *     parents must be nulled - all as a value that can be asserted without a
 *     database.
 *   - {@link projectSession} does nothing but write that value inside ONE
 *     transaction, stamping each edge from the injected clock.
 * This module keeps only what belongs to neither: the halt gate, the clock
 * default, and the never-throw contract.
 *
 * ingestSession NEVER rethrows: every failure path collapses to an
 * {@link IngestOutcome} with `ok: false` and a human-readable `error`.
 *
 * STATUS: ingest NEVER concludes completion - see `normalize-session.ts`.
 */
import {
  computeCostUsd,
  parseSession,
  type PricingEntry,
  type SessionSubstrate,
} from '@agenthropic/core';
import type { SqliteDatabase } from '../db/connection';
import { normalizeSession } from './normalize-session';
import { projectSession } from './project-session';

export interface IngestDeps {
  readonly db: SqliteDatabase;
  readonly pricing: readonly PricingEntry[];
  readonly instance: string;
  readonly hostId: string;
  readonly projectSlug?: string | null;
  /** Injectable clock for the edge `created_at` stamp; defaults to wall time. */
  readonly now?: () => string;
}

export interface IngestOutcome {
  readonly ok: boolean;
  readonly sessionId: string | null;
  readonly costUsd: number | null;
  readonly agentsUpserted: number;
  readonly edgesInserted: number;
  readonly usageRowsInserted: number;
  readonly error: string | null;
}

/** The all-zero, no-session outcome returned on any failure. */
function failure(error: string): IngestOutcome {
  return {
    ok: false,
    sessionId: null,
    costUsd: null,
    agentsUpserted: 0,
    edgesInserted: 0,
    usageRowsInserted: 0,
    error,
  };
}

/**
 * Parse, price (halt gate), normalize, then transactionally persist one
 * session's substrate. Idempotent: replaying the same substrate upserts the
 * session and agents in place and INSERT-OR-IGNOREs edges and usage, so a
 * second call reports `edgesInserted === 0` and `usageRowsInserted === 0`.
 */
export function ingestSession(substrate: SessionSubstrate, deps: IngestDeps): IngestOutcome {
  try {
    const parsed = parseSession(substrate);

    // HALT GATE: price BEFORE opening a transaction. An unknown model id throws
    // PricingError here, so no partial rows are ever written for a substrate we
    // cannot cost. Moving this call inside the transaction breaks that invariant.
    const costUsd = computeCostUsd(parsed.usage, deps.pricing);

    const now = deps.now ?? ((): string => new Date().toISOString());
    const normalized = normalizeSession(parsed, {
      projectSlug: deps.projectSlug ?? null,
      instance: deps.instance,
      hostId: deps.hostId,
    });
    const counts = projectSession(deps.db, normalized, now);

    return {
      ok: true,
      sessionId: parsed.sessionId,
      costUsd,
      agentsUpserted: counts.agentsUpserted,
      edgesInserted: counts.edgesInserted,
      usageRowsInserted: counts.usageRowsInserted,
      error: null,
    };
  } catch (err) {
    // Both arms are exercised: the pipeline throws Error instances, and an
    // injected dependency (deps.now) can throw anything at all.
    return failure(err instanceof Error ? err.message : String(err));
  }
}
