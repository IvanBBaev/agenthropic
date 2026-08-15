/**
 * Parser output types — the in-memory reconstruction the pure parser returns
 * (parser-spec sections 4-6). These are the read-side domain shapes; the
 * snake_case SQLite row contracts live in `@agenthropic/shared`.
 */
import type { OrchestrationEdgeSource } from '@agenthropic/shared';
import type { DedupedUsage } from '../types';

export type ParsedAgentType = 'main' | 'subagent';

/**
 * One reconstructed agent node. Deliberately carries NO `status`: status is
 * the WP-IN12 missing-`Stop` watchdog's territory, not the parser's. The
 * subagent tree is a data fact via the self-referential `parentAgentId`.
 */
export interface ParsedAgent {
  /** `sessionId` for the main agent; the `agent-<hex>` filename hex for a subagent. */
  id: string;
  type: ParsedAgentType;
  /** Populated only when a resolving `tool_use` block carried `input.subagent_type` (join path 1). */
  subagentType: string | null;
  /** Resolved spawn parent, or `null` for the main agent and for orphan subagents (no join path). */
  parentAgentId: string | null;
  /** First record timestamp of this agent's transcript. */
  startedAt: string;
  /**
   * Last record timestamp of this agent's transcript — ALWAYS present.
   *
   * Not nullable, and deliberately so: a transcript with no timestamped record
   * raises `SubstrateError` in `transcriptTimespan` rather than yielding an
   * agent with an open end, so the parser has no path that produces null here.
   * Declaring it `string | null` invented a state the parser cannot reach and
   * pushed a dead `?? startedAt` fallback onto every consumer.
   *
   * NOTE THIS IS NOT AN ENDING. It is the most recent activity observed in the
   * transcript; a file that stopped growing is indistinguishable from one whose
   * next line has not been flushed. Terminal status comes from hooks or the
   * watchdog — see `LIVENESS_STATUS` in the server's normalizer.
   */
  endedAt: string;
}

/**
 * The DISTINCT provenance of a parser-spec gate-#7 legacy join: a pre-2.1.71
 * bare-`Explore` child anchored via a raw `agentId` on a parent progress line.
 * Deliberately NOT one of the four modern structural literals — collapsing it
 * into `tool_use` (or any modern value) would let a weak legacy inference
 * masquerade downstream as a strong observed anchor, breaking the
 * observed-vs-inferred honesty rule. The literal is a full member of the
 * shared `OrchestrationEdgeSourceSchema` union and the server persists it
 * verbatim (the migration-13 CHECK on `orchestration_edges.source` admits it),
 * so the provenance survives every hop to the UI. This constant is the named
 * handle core emits it under, where the edge is born; `satisfies` pins it to
 * the shared union so a drift there fails compilation here.
 */
export const LEGACY_EXPLORE_EDGE_SOURCE = 'legacy_explore' satisfies OrchestrationEdgeSource;

/**
 * Everything a parsed edge's `source` can be. A direct alias of the shared
 * union (which carries the four modern structural literals AND
 * `legacy_explore`), kept as the parser-side name so read-side code does not
 * couple to the wire-schema module for a domain concept of its own.
 */
export type ParsedEdgeSource = OrchestrationEdgeSource;

/**
 * One reconstructed spawn edge. Emitted only for a subagent whose parent
 * resolved via one of the four structural join paths (parser-spec section 4)
 * or the gate-#7 legacy fallback; orphans emit no edge. Every `source` value —
 * `legacy_explore` included — is single-sourced from `@agenthropic/shared` and
 * flows through to persistence verbatim (see {@link LEGACY_EXPLORE_EDGE_SOURCE}).
 */
export interface ParsedEdge {
  sessionId: string;
  parentAgentId: string;
  childAgentId: string;
  source: ParsedEdgeSource;
  /**
   * The structural anchor id when the resolving path carried one; `null` for
   * directory joins and for `legacy_explore` joins (whose join key is the raw
   * child hex, not a tool-use id).
   */
  toolUseId: string | null;
}

/** The full read-side reconstruction of one session. */
export interface ParsedSession {
  sessionId: string;
  agents: ParsedAgent[];
  edges: ParsedEdge[];
  /** Usage deduped by `message.id` (parser-spec section 5.2); `agentId === null` is ROOT/main usage. */
  usage: DedupedUsage[];
}
