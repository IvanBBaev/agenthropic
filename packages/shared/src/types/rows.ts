/**
 * Shared row types mirroring the SQLite schema (DESIGN.md section 4,
 * parser-spec sections 4-5). These are the cross-package data contracts;
 * every workspace consumes them from `@agenthropic/shared`.
 *
 * Conventions:
 * - Timestamps are ISO-8601 UTC strings (SQLite TEXT).
 * - `snake_case` field names mirror column names 1:1.
 */

export type AgentType = 'main' | 'subagent';

/**
 * `'unknown'` is required: the WP-IN12 missing-`Stop` watchdog assigns it and
 * the UI depends on it (open-decisions.md OPEN-2 resolution).
 */
export type AgentStatus = 'working' | 'waiting' | 'completed' | 'error' | 'unknown';

/**
 * The four structural spawn-edge join paths (parser-spec section 4), plus the
 * `legacy_explore` heuristic join (parser-spec gate #7) - kept distinct so a
 * name-based legacy guess is never persisted as an observed spawn.
 */
export type OrchestrationEdgeSource =
  'tool_use' | 'directory' | 'task_notification' | 'queue_operation' | 'legacy_explore';

/** The five priced token buckets (parser-spec section 5.4). */
export type TokenBucket = 'input' | 'output' | 'cache_read' | 'cache_write_5m' | 'cache_write_1h';

export type RawEventSource = 'hook' | 'jsonl';

export interface SessionRow {
  id: string;
  /** Claude Code project directory slug (`~/.claude/projects/<slug>`). */
  project_slug: string;
  /** Instance key for future fleet aggregation (DESIGN.md section 2.4). */
  instance: string;
  host_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface AgentRow {
  id: string;
  session_id: string;
  type: AgentType;
  subagent_type: string | null;
  status: AgentStatus;
  /** Self-referential: builds the subagent tree as a data fact. */
  parent_agent_id: string | null;
  started_at: string;
  ended_at: string | null;
}

/** Append-only raw event substrate (`events_raw`). */
export interface EventRawRow {
  id: number;
  idempotency_key: string;
  source: RawEventSource;
  event_type: string;
  /** Raw payload as received, JSON-encoded. */
  payload: string;
  received_at: string;
}

/** Normalized event projection derived from `events_raw`. */
export interface EventRow {
  id: number;
  raw_event_id: number;
  session_id: string;
  agent_id: string | null;
  event_type: string;
  occurred_at: string;
}

/**
 * Persisted, per-instance spawn edge (the moat): a data fact, never a UI
 * reconstruction. `instance` and `host_id` are non-null by design.
 */
export interface OrchestrationEdgeRow {
  id: number;
  session_id: string;
  parent_agent_id: string;
  child_agent_id: string;
  source: OrchestrationEdgeSource;
  /** Structural anchor (`tool_use.id`) when the source carries one. */
  tool_use_id: string | null;
  instance: string;
  host_id: string;
  created_at: string;
}

/**
 * Token usage per message, deduped by `message_id` before summation
 * (parser-spec section 5.2 - naive row summation over-counts ~2.4-2.7x).
 * `agent_id` is null for the main agent's own turns (ROOT usage).
 */
export interface TokenUsageRow {
  id: number;
  session_id: string;
  agent_id: string | null;
  message_id: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  recorded_at: string;
}

/** Bucket-and-model-aware pricing (parser-spec section 5.4). */
export interface ModelPricingRow {
  model: string;
  bucket: TokenBucket;
  usd_per_mtok: number;
  effective_from: string;
}
