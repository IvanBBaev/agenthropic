/**
 * WP-IN9 - session ingest integrator: the write-side composition root that
 * turns a read substrate into persisted rows.
 *
 * Pipeline order is load-bearing:
 *   parseSession -> computeCostUsd (the HALT GATE) -> ONE transaction.
 * The cost call runs BEFORE any DB write, so an unknown model id throws
 * PricingError while the database is still untouched - no partial session,
 * agent or usage rows are ever committed for an unpriceable substrate. Inside
 * the transaction agents are inserted parent-first (topological order) because
 * agents.parent_agent_id is a self-FK; orchestration_edges carry the logical
 * spawn relation and have NO FK, so an edge is recorded even when its parent
 * node was not materialized as an agent.
 *
 * ingestSession NEVER rethrows: every failure path collapses to an
 * {@link IngestOutcome} with `ok: false` and a human-readable `error`.
 */
import {
  computeCostUsd,
  parseSession,
  type ParsedAgent,
  type PricingEntry,
  type SessionSubstrate,
} from '@agenthropic/core';
import type { SqliteDatabase } from '../db/connection';
import { upsertAgent } from '../db/agents';
import { insertOrchestrationEdge } from '../db/edges';
import { upsertSession } from '../db/sessions';
import { insertTokenUsageRows } from '../db/token-usage';

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
 * Order agents parent-first so a child never precedes the agent its
 * self-referential `parent_agent_id` points at. An agent is a root when its
 * parent is null OR is not itself a materialized agent node. Handles depth-N
 * by construction (BFS over the single-parent tree); any residual (a cycle,
 * which a tree cannot produce) is appended in stable input order as a
 * defensive fallback.
 */
function topoOrderAgents(
  agents: readonly ParsedAgent[],
  nodeIds: ReadonlySet<string>,
): ParsedAgent[] {
  const isRoot = (agent: ParsedAgent): boolean =>
    agent.parentAgentId === null || !nodeIds.has(agent.parentAgentId);

  const childrenByParent = new Map<string, ParsedAgent[]>();
  for (const agent of agents) {
    if (isRoot(agent)) {
      continue;
    }
    // Not a root => parentAgentId is a non-null id that is itself a node.
    const parentId = agent.parentAgentId as string;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(agent);
    childrenByParent.set(parentId, siblings);
  }

  const ordered: ParsedAgent[] = [];
  const emitted = new Set<string>();
  const queue: ParsedAgent[] = agents.filter(isRoot);
  while (queue.length > 0) {
    const node = queue.shift() as ParsedAgent;
    /* v8 ignore start -- defensive: a single-parent forest never re-queues an id */
    if (emitted.has(node.id)) {
      continue;
    }
    /* v8 ignore stop */
    ordered.push(node);
    emitted.add(node.id);
    for (const child of childrenByParent.get(node.id) ?? []) {
      queue.push(child);
    }
  }

  /* v8 ignore start -- defensive: a tree/forest leaves no residual cycle */
  if (ordered.length < agents.length) {
    for (const agent of agents) {
      if (!emitted.has(agent.id)) {
        ordered.push(agent);
        emitted.add(agent.id);
      }
    }
  }
  /* v8 ignore stop */
  return ordered;
}

/** Earliest `startedAt` across agents, or null when there are none. */
function minStartedAt(agents: readonly ParsedAgent[]): string | null {
  let earliest: string | null = null;
  for (const agent of agents) {
    if (earliest === null || agent.startedAt < earliest) {
      earliest = agent.startedAt;
    }
  }
  return earliest;
}

/** Latest activity (endedAt, else startedAt) across agents, or null when none. */
function maxLastActivity(agents: readonly ParsedAgent[]): string | null {
  let latest: string | null = null;
  for (const agent of agents) {
    /* v8 ignore next -- endedAt is always set by the parser; startedAt is the type-defensive fallback */
    const candidate = agent.endedAt ?? agent.startedAt;
    if (latest === null || candidate > latest) {
      latest = candidate;
    }
  }
  return latest;
}

/**
 * Parse, price (halt gate), then transactionally persist one session's
 * substrate. Idempotent: replaying the same substrate upserts the session and
 * agents in place and INSERT-OR-IGNOREs edges and usage, so a second call
 * reports `edgesInserted === 0` and `usageRowsInserted === 0`.
 */
export function ingestSession(substrate: SessionSubstrate, deps: IngestDeps): IngestOutcome {
  try {
    const parsed = parseSession(substrate);

    // HALT GATE: price BEFORE opening a transaction. An unknown model id throws
    // PricingError here, so no partial rows are ever written for a substrate we
    // cannot cost. Moving this call inside the transaction breaks that invariant.
    const costUsd = computeCostUsd(parsed.usage, deps.pricing);

    const now = deps.now ?? ((): string => new Date().toISOString());
    const nodeIds = new Set(parsed.agents.map((agent) => agent.id));
    const orderedAgents = topoOrderAgents(parsed.agents, nodeIds);

    const main = parsed.agents.find((agent) => agent.type === 'main');
    const startedAt = main?.startedAt ?? minStartedAt(parsed.agents);
    const lastActivityAt = maxLastActivity(parsed.agents);
    /* v8 ignore next -- the parser always sets endedAt, so 'unknown' is the type-defensive arm */
    const status = parsed.agents.every((agent) => agent.endedAt !== null) ? 'completed' : 'unknown';

    let edgesInserted = 0;
    let usageRowsInserted = 0;

    const runTransaction = deps.db.transaction((): void => {
      upsertSession(deps.db, {
        id: parsed.sessionId,
        projectSlug: deps.projectSlug ?? null,
        startedAt,
        lastActivityAt,
        status,
      });

      // FK-safe by construction: a parent is referenced only once it has been
      // inserted earlier in THIS loop. For the normal parent-first forest this
      // is identical to the old nodeIds membership test (the parent is always
      // already inserted); for a residual cycle (which topoOrderAgents appends
      // in raw input order) the not-yet-inserted parent is nulled here instead
      // of violating the agents self-FK and rolling back the whole session. The
      // spawn relation itself is never lost - it is still recorded in
      // orchestration_edges, which carries no FK.
      const insertedAgentIds = new Set<string>();
      for (const agent of orderedAgents) {
        const parentAgentId =
          agent.parentAgentId !== null && insertedAgentIds.has(agent.parentAgentId)
            ? agent.parentAgentId
            : null;
        upsertAgent(deps.db, {
          id: agent.id,
          sessionId: parsed.sessionId,
          type: agent.type,
          subagentType: agent.subagentType,
          /* v8 ignore next -- the parser always sets endedAt, so 'unknown' is the type-defensive arm */
          status: agent.endedAt ? 'completed' : 'unknown',
          parentAgentId,
          firstSeenAt: agent.startedAt,
          lastSeenAt: agent.endedAt,
        });
        insertedAgentIds.add(agent.id);
      }

      for (const edge of parsed.edges) {
        const { inserted } = insertOrchestrationEdge(deps.db, {
          sessionId: edge.sessionId,
          parentAgentId: edge.parentAgentId,
          childAgentId: edge.childAgentId,
          source: edge.source,
          instance: deps.instance,
          hostId: deps.hostId,
          createdAt: now(),
        });
        if (inserted) {
          edgesInserted += 1;
        }
      }

      usageRowsInserted = insertTokenUsageRows(deps.db, parsed.sessionId, parsed.usage).inserted;
    });
    runTransaction();

    return {
      ok: true,
      sessionId: parsed.sessionId,
      costUsd,
      agentsUpserted: parsed.agents.length,
      edgesInserted,
      usageRowsInserted,
      error: null,
    };
  } catch (err) {
    /* v8 ignore next -- String(err) is the defensive arm; the pipeline only throws Error instances */
    return failure(err instanceof Error ? err.message : String(err));
  }
}
