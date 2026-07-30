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
  /** Last record timestamp of this agent's transcript. */
  endedAt: string | null;
}

/**
 * One reconstructed spawn edge. Emitted only for a subagent whose parent
 * resolved via one of the four structural join paths (parser-spec section 4);
 * orphans emit no edge. `source` is single-sourced from `@agenthropic/shared`.
 */
export interface ParsedEdge {
  sessionId: string;
  parentAgentId: string;
  childAgentId: string;
  source: OrchestrationEdgeSource;
  /** The structural anchor id when the resolving path carried one; `null` for directory joins. */
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
