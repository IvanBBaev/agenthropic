/**
 * WP-IN7 — the projection: write one {@link NormalizedSession} to storage
 * inside a single transaction.
 *
 * This is the impure half of the WP-IN6/IN7 pair. Everything it does is a
 * consequence of a decision already taken by the pure normalizer — the row
 * shapes, the agent insertion order, the nulled-but-not-lost parents. The only
 * judgement left here is the one that genuinely cannot be made without the
 * outside world: the wall-clock stamp on each edge.
 *
 * TRANSACTION BOUNDARY. All of it commits or none of it does. `now()` is called
 * INSIDE the transaction, per edge, deliberately: a clock that throws mid-write
 * must roll the partial session back rather than leave a half-projected graph
 * (`test/ingest-session.test.ts` drives exactly that).
 *
 * NOT A HALT GATE. Pricing must already have succeeded before this is called —
 * see `ingest-session.ts`. Nothing here validates the substrate; by this point
 * the decision to write has been made.
 */
import { upsertAgent } from '../db/agents';
import type { SqliteDatabase } from '../db/connection';
import { insertOrchestrationEdge } from '../db/edges';
import { upsertSession } from '../db/sessions';
import { insertTokenUsageRows } from '../db/token-usage';
import { reconcilePendingSubagentStops } from '../hooks/liveness-status';
import type { AgentStatusChangedEvent } from './ingest-events';
import type { NormalizedSession } from './normalize-session';

/** What the projection actually changed. */
export interface ProjectionCounts {
  readonly agentsUpserted: number;
  readonly edgesInserted: number;
  readonly usageRowsInserted: number;
  /** Messages skipped by the M-12 first-ingested-session ownership rule. */
  readonly crossSessionUsageCollisions: number;
  /**
   * Status transitions produced by replaying stored SubagentStop hooks onto
   * agents FIRST INSERTED by this projection (M-13). Returned rather than
   * published: the projection has no realtime hub, so the caller decides what
   * to do with them — the same seam shape `applyHookLiveness` uses.
   */
  readonly statusReconciliations: readonly AgentStatusChangedEvent[];
}

/**
 * Persist a normalized session. Idempotent: sessions and agents upsert in
 * place, edges and usage rows are INSERT-OR-IGNORE / converge against their
 * UNIQUE logical keys, so a replay of unchanged input reports
 * `edgesInserted === 0` and `usageRowsInserted === 0`.
 */
export function projectSession(
  db: SqliteDatabase,
  normalized: NormalizedSession,
  now: () => string,
): ProjectionCounts {
  let edgesInserted = 0;
  let usageRowsInserted = 0;
  let crossSessionUsageCollisions = 0;
  let statusReconciliations: readonly AgentStatusChangedEvent[] = [];

  db.transaction((): void => {
    upsertSession(db, normalized.session);

    // Order is load-bearing, and it was fixed by the normalizer: a parent is
    // never referenced before its own row exists (agents.parent_agent_id is a
    // self-FK).
    const newAgentIds = new Set<string>();
    for (const agent of normalized.agents) {
      if (upsertAgent(db, agent).inserted) {
        newAgentIds.add(agent.id);
      }
    }

    // M-13: an agent that JUST got its first row may already have a stored
    // SubagentStop verdict waiting — the hook fired before its transcript was
    // ever parsed. Replay it inside the same transaction, so a fast subagent
    // commits as 'completed', never as watchdog-fodder ending 'unknown'.
    statusReconciliations = reconcilePendingSubagentStops(db, normalized.sessionId, newAgentIds);

    for (const edge of normalized.edges) {
      const { inserted } = insertOrchestrationEdge(db, { ...edge, createdAt: now() });
      if (inserted) {
        edgesInserted += 1;
      }
    }

    const usageResult = insertTokenUsageRows(db, normalized.sessionId, normalized.usage);
    usageRowsInserted = usageResult.inserted;
    crossSessionUsageCollisions = usageResult.crossSessionCollisions;
  })();

  return {
    agentsUpserted: normalized.agents.length,
    edgesInserted,
    usageRowsInserted,
    crossSessionUsageCollisions,
    statusReconciliations,
  };
}
