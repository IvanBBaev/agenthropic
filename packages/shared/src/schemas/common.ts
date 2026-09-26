/**
 * WP-U2 - shared API conventions consumed by both the server routes and the
 * web app: the uniform error DTO, the enum schemas mirroring the SQLite CHECK
 * constraints, and the pagination caps every read endpoint enforces.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';

/** `Union[T, null]` helper - SQLite TEXT columns are nullable by default. */
export function nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

/** The uniform error shape of every non-2xx API response. */
export const ApiErrorSchema = Type.Object(
  {
    error: Type.String(),
  },
  { additionalProperties: false },
);

export type ApiErrorDto = Static<typeof ApiErrorSchema>;

/**
 * Agent status incl. `'unknown'` (OPEN-2: assigned by the missing-Stop
 * watchdog; the UI depends on it being always visible, never hidden).
 */
export const AgentStatusSchema = Type.Union([
  Type.Literal('working'),
  Type.Literal('waiting'),
  Type.Literal('completed'),
  Type.Literal('error'),
  Type.Literal('unknown'),
]);

export type AgentStatus = Static<typeof AgentStatusSchema>;

export const AgentTypeSchema = Type.Union([Type.Literal('main'), Type.Literal('subagent')]);

export type AgentType = Static<typeof AgentTypeSchema>;

/**
 * Why a spawned agent's run ended the way it did, read from the PARENT-side
 * `Agent`/`Workflow` `tool_result` that answered the spawn block. Mirrors the
 * migration-17 CHECK on `agents.outcome_cause`.
 *
 * The causes are kept DISTINCT rather than flattened into one "failed" flag,
 * because they do not mean the same thing and most of them are not failures:
 *
 *  - `concurrency_limit`     the spawn was REFUSED ("Concurrent subagent limit
 *                            reached") - the agent never ran.
 *  - `user_interrupt`        a human stopped it. NOT a failure; never 'error'.
 *  - `permission_failed`     a tool-permission stream closed before an answer.
 *  - `dispatch_unavailable`  the model was unavailable at dispatch time.
 *  - `terminated_early`      the agent RAN and was killed. The one cause that
 *                            is honestly an 'error'.
 *  - `unclassified`          an error result matching none of the above,
 *                            recorded so the evidence is not lost and
 *                            deliberately NOT promoted to 'error'.
 *
 * On the measured corpus 19 of 33 are `concurrency_limit` - a scheduling fact
 * with no failed agent in it. That is the whole reason this is a six-valued
 * enum on the wire and not a boolean: collapsing it would invent 33 failures
 * where there are 2.
 */
export const AgentOutcomeCauseSchema = Type.Union([
  Type.Literal('concurrency_limit'),
  Type.Literal('user_interrupt'),
  Type.Literal('permission_failed'),
  Type.Literal('dispatch_unavailable'),
  Type.Literal('terminated_early'),
  Type.Literal('unclassified'),
]);

export type AgentOutcomeCause = Static<typeof AgentOutcomeCauseSchema>;

/**
 * The four structural spawn-edge join paths (parser-spec section 4), plus the
 * `legacy_explore` heuristic join for pre-2.1.71 bare-`Explore` sidecars
 * (parser-spec gate #7). Served verbatim as persisted - the
 * observed-vs-inferred provenance distinction is the honesty rule and must
 * survive every hop to the UI; collapsing `legacy_explore` into `tool_use`
 * would present a name-based guess as an observed spawn.
 */
export const OrchestrationEdgeSourceSchema = Type.Union([
  Type.Literal('tool_use'),
  Type.Literal('directory'),
  Type.Literal('task_notification'),
  Type.Literal('queue_operation'),
  Type.Literal('legacy_explore'),
]);

export type OrchestrationEdgeSource = Static<typeof OrchestrationEdgeSourceSchema>;

/** Pagination caps shared by the paginated read endpoints (sessions, events, changes). */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MAX_PAGE_OFFSET = 1_000_000;

/** Caps for the cost summary's top-N session leaderboard. */
export const DEFAULT_COST_TOP_N = 5;
export const MAX_COST_TOP_N = 50;

/** Node caps for the global DAG so the client can bound its render. */
export const DEFAULT_DAG_NODE_LIMIT = 1000;
export const MAX_DAG_NODE_LIMIT = 5000;
