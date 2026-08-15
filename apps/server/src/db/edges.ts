/**
 * WP-D7 - insert path for orchestration edges (the moat artifact).
 *
 * Dedup lives in the storage engine: INSERT OR IGNORE against the UNIQUE
 * (session_id, parent_agent_id, child_agent_id) key, so replaying the same
 * logical edge - e.g. re-parsing a transcript - yields exactly one row.
 */
import type { OrchestrationEdgeSource } from '@agenthropic/shared';
import type { SqliteDatabase } from './connection';

export interface OrchestrationEdgeInsert {
  readonly sessionId: string;
  readonly parentAgentId: string;
  readonly childAgentId: string;
  /** A structural join path (parser-spec section 4) or `legacy_explore` (gate #7). */
  readonly source: OrchestrationEdgeSource;
  readonly instance: string;
  readonly hostId: string;
  readonly createdAt: string;
}

export interface EdgeInsertResult {
  /** False when the logical edge already existed (idempotent no-op). */
  readonly inserted: boolean;
}

export function insertOrchestrationEdge(
  db: SqliteDatabase,
  edge: OrchestrationEdgeInsert,
): EdgeInsertResult {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO orchestration_edges
         (session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      edge.sessionId,
      edge.parentAgentId,
      edge.childAgentId,
      edge.source,
      edge.instance,
      edge.hostId,
      edge.createdAt,
    );
  return { inserted: info.changes === 1 };
}
