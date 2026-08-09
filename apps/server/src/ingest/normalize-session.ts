/**
 * WP-IN6 — the pure Normalizer: parser output in, storage-shaped rows out.
 *
 * This module is DETERMINISTIC AND SIDE-EFFECT FREE by contract. It touches no
 * database, no clock, no filesystem and no environment; the same
 * {@link ParsedSession} and the same {@link NormalizeOptions} always produce the
 * same {@link NormalizedSession}. Everything that makes ingest impure — the
 * transaction, the edge `created_at` stamp — lives in WP-IN7
 * (`project-session.ts`), on the other side of this seam.
 *
 * That split is not tidiness. It is what makes the two hardest properties of
 * this pipeline testable in isolation:
 *
 *  - the ORDERING rule (agents must be inserted parent-first, because
 *    `agents.parent_agent_id` is a self-FK) and the FK-safety rule (a parent
 *    that will not be inserted first is nulled on the agent row while the spawn
 *    relation survives in the FK-free `orchestration_edges`) are decided here,
 *    as a value, and can be asserted without a database;
 *  - the WP-IN10 replay checkpoint can reason about "would this session project
 *    the same rows?" because the answer is a pure function of the substrate.
 *
 * The normalizer takes NO position on liveness beyond {@link LIVENESS_STATUS}
 * (see the note there): reading a transcript proves activity, never
 * termination.
 */
import type { ParsedAgent, ParsedSession, DedupedUsage } from '@agenthropic/core';
import type { AgentUpsert } from '../db/agents';
import type { OrchestrationEdgeInsert } from '../db/edges';
import type { SessionUpsert } from '../db/sessions';

/**
 * The ONLY status ingest ever asserts.
 *
 * READING A TRANSCRIPT PROVES ACTIVITY, NEVER TERMINATION. A JSONL file that
 * has stopped growing is indistinguishable from one whose next line has not
 * been flushed yet, so `endedAt` (which the parser always fills from the LAST
 * record's timestamp) is evidence of the most recent activity — not of an
 * ending. Deriving 'completed' from it was a confident lie: it marked every
 * agent finished the first time its transcript was read, while it was still
 * running.
 *
 * The terminal verdict belongs to whatever OBSERVES the ending:
 *   - `SubagentStop` (hook)  -> 'completed' for that subagent
 *   - `Stop` (hook)          -> 'waiting'   for the main agent (idle, per turn)
 *   - the WP-IN12 watchdog   -> 'unknown'   when activity goes stale
 *
 * Consequence, stated plainly rather than hidden: with NO hooks installed
 * nothing ever reports 'completed'; agents go 'working' -> 'unknown'. That is
 * the honest reading of the evidence available.
 *
 * Note the upserts do not apply this unconditionally — `db/agents.ts` and
 * `db/sessions.ts` keep observed terminals sticky and only revert an inferred
 * state when the JSONL timestamps strictly advance.
 */
export const LIVENESS_STATUS = 'working';

/**
 * An edge as the normalizer can know it: everything except `created_at`, which
 * is a wall-clock reading and therefore the projection's business.
 */
export type NormalizedEdge = Omit<OrchestrationEdgeInsert, 'createdAt'>;

/** The storage-shaped, insertion-ordered projection of one parsed session. */
export interface NormalizedSession {
  readonly sessionId: string;
  readonly session: SessionUpsert;
  /**
   * Agents in a SAFE INSERTION ORDER: every row's `parentAgentId` either is
   * null or names an agent that appears earlier in this array.
   */
  readonly agents: readonly AgentUpsert[];
  readonly edges: readonly NormalizedEdge[];
  /** Deduped usage, passed through untouched — the fan-out is WP-D8's rule. */
  readonly usage: readonly DedupedUsage[];
}

/** The per-ingest facts the normalizer cannot derive from the substrate. */
export interface NormalizeOptions {
  readonly projectSlug: string | null;
  readonly instance: string;
  readonly hostId: string;
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
    // Dedupe by id. `parseSession` cannot hand us two agents with one id -
    // `collectAgentFiles` throws SubstrateError on a repeated hex - but this
    // function is pure, exported and takes any ParsedSession value, so the
    // guard is live code at ITS contract boundary, not a defensive stub. It is
    // exercised directly; emitting a duplicate would make the agents upsert
    // write the same row twice within one transaction.
    if (emitted.has(node.id)) {
      continue;
    }
    ordered.push(node);
    emitted.add(node.id);
    for (const child of childrenByParent.get(node.id) ?? []) {
      queue.push(child);
    }
  }

  // Residual pass. NOT unreachable: `resolveParent` anchors a child to whoever
  // owns its sidecar's `toolUseId`, and a depth-2 parent block legitimately
  // lives inside a depth-1 agent transcript, so two sidecars naming each
  // other's block yield A -> B -> A from a corpus the parser has no basis to
  // reject. BFS emits neither member (neither is a root), and dropping them
  // would let the agents self-FK roll back the whole session. Appending in raw
  // input order cuts the cycle at exactly one point; the loop below nulls only
  // the parent that is not yet inserted, and the relation survives in
  // `orchestration_edges`, which carries no FK.
  if (ordered.length < agents.length) {
    for (const agent of agents) {
      if (!emitted.has(agent.id)) {
        ordered.push(agent);
        emitted.add(agent.id);
      }
    }
  }
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

/**
 * Latest activity across agents, or null when there are none.
 *
 * `endedAt` is the LAST record timestamp of a transcript, which the parser
 * always fills (a transcript with no timestamped record raises SubstrateError
 * rather than ending open) — so there is no "open agent" arm to fall back to,
 * and none is invented here.
 */
function maxLastActivity(agents: readonly ParsedAgent[]): string | null {
  let latest: string | null = null;
  for (const agent of agents) {
    if (latest === null || agent.endedAt > latest) {
      latest = agent.endedAt;
    }
  }
  return latest;
}

/**
 * Turn one parsed session into the exact rows the projection will write.
 * Pure — see the module doc.
 */
export function normalizeSession(
  parsed: ParsedSession,
  options: NormalizeOptions,
): NormalizedSession {
  const nodeIds = new Set(parsed.agents.map((agent) => agent.id));
  const orderedAgents = topoOrderAgents(parsed.agents, nodeIds);

  const main = parsed.agents.find((agent) => agent.type === 'main');
  const startedAt = main?.startedAt ?? minStartedAt(parsed.agents);

  // FK-safe by construction: a parent is referenced only once it has been
  // emitted earlier in THIS loop. For the normal parent-first forest this is
  // identical to a nodeIds membership test (the parent is always already
  // there); for a residual cycle (which topoOrderAgents appends in raw input
  // order) the not-yet-emitted parent is nulled here instead of violating the
  // agents self-FK and rolling the whole session back. The spawn relation
  // itself is never lost — it is still recorded in orchestration_edges, which
  // carries no FK.
  const emittedAgentIds = new Set<string>();
  const agents: AgentUpsert[] = [];
  for (const agent of orderedAgents) {
    const parentAgentId =
      agent.parentAgentId !== null && emittedAgentIds.has(agent.parentAgentId)
        ? agent.parentAgentId
        : null;
    agents.push({
      id: agent.id,
      sessionId: parsed.sessionId,
      type: agent.type,
      subagentType: agent.subagentType,
      status: LIVENESS_STATUS,
      parentAgentId,
      firstSeenAt: agent.startedAt,
      lastSeenAt: agent.endedAt,
    });
    emittedAgentIds.add(agent.id);
  }

  return {
    sessionId: parsed.sessionId,
    session: {
      id: parsed.sessionId,
      projectSlug: options.projectSlug,
      startedAt,
      lastActivityAt: maxLastActivity(parsed.agents),
      status: LIVENESS_STATUS,
    },
    agents,
    edges: parsed.edges.map((edge) => ({
      sessionId: edge.sessionId,
      parentAgentId: edge.parentAgentId,
      childAgentId: edge.childAgentId,
      source: edge.source,
      instance: options.instance,
      hostId: options.hostId,
    })),
    usage: parsed.usage,
  };
}
