/**
 * M-9 aggregate half: corpus-wide delegation savings and its cache.
 *
 * Split out of `api/queries.ts` (ARC-4, 2026-11-19), which stays the public
 * entry point and re-exports this module. The cost and honesty rules that
 * govern every read here are documented at the top of that file.
 */
import {
  MAX_AGGREGATE_SKIPPED_SAMPLE,
  type AggregateDelegationSavingsDto,
  type AggregateSavingsSkipDto,
} from '@agenthropic/shared';
import { PricingError, computeDelegationSavings } from '@agenthropic/core';
import type { DedupedUsage, ParsedAgent, ParsedSession, PricingEntry } from '@agenthropic/core';
import type { SqliteDatabase } from '../../db/connection';
import { ledgerEpoch } from '../../db/ledger-epoch';
import { byBinary } from './cost';

/* -------------------------------------------------------------------------
 * M-9 (aggregate half) — corpus-wide delegation savings.
 *
 * The per-session route answers the same counterfactual from the JSONL
 * substrate. This one answers it from the STORED ROWS, and deliberately so:
 * a KPI on the cost page cannot re-parse every transcript in the corpus on
 * each cold request, and the DB is the project's declared ground truth for
 * token counts. Both paths feed the SAME pure `computeDelegationSavings`, so
 * the only question is whether the reconstruction below is faithful.
 *
 * It is, mechanically, for any session ingested by this server:
 *   - `token_usage` stores a complete (message_id, bucket) matrix — all five
 *     buckets, zero-token ones included — with the message-level settled
 *     `model` and `occurred_at` replicated across the five rows, so grouping
 *     by message_id reproduces a `DedupedUsage` exactly (see db/token-usage.ts);
 *   - the estimator reads only `{id, type, parentAgentId}` off each agent plus
 *     the usage rows — never `startedAt`/`endedAt`/`subagentType`/`edges`;
 *   - the one real translation is the main-agent key (see `mainAgentIds`).
 * `api-aggregate-savings-equivalence.test.ts` proves it end to end: ingest a
 * fixture, then assert this function equals the substrate-parsed per-session
 * figure to the micro-dollar.
 *
 * Where the two CAN diverge is where the database itself lacks the rows, and
 * every such case is either reported or provably zero:
 *   1. M-12 cross-session `message_id` ownership — when two transcripts (fork
 *      or resume) carry the same message id, the earlier-starting session
 *      keeps it (DAT-15; ties to the smaller session id) and the loser's rows
 *      are not written at all, or are deleted when the owner arrives later. The aggregate therefore
 *      counts that usage once, under the owning session; a per-session
 *      substrate analysis of the LOSING session counts it too. This one is not
 *      countable from the DB (the loser leaves no row) — the server's
 *      cross-session collision counter is the place that fact is surfaced.
 *   2. Hand-run retention tooling CAN prune `token_usage` (acknowledgeCostLoss;
 *      the server's signed policy never does) but never `agents`, so such a
 *      session can keep subagents with no usage. Those price to $0 honestly (no rows, no
 *      cost, no hypothetical) rather than erroring.
 *   3. A residual-cycle `parent_agent_id` nulled at ingest makes a subagent's
 *      top-tier model underivable — it self-reports in `subagentsSkipped`.
 *   4. Sessions on disk that were never ingested are outside `sessionsTotal`
 *      entirely, exactly as they are for every other DB-backed figure.
 * ------------------------------------------------------------------------- */

/**
 * The scan's universe, with each session's change stamp. A session with no
 * persisted subagent cannot contribute a cent — the estimator sums over
 * `type = 'subagent'` agents only — so it is left out of the scan and
 * reported as a measured zero (`sessionsTotal - sessionsWithSubagents`),
 * never as a gap.
 *
 * LEFT JOIN, not JOIN: this connection enforces the `agents.session_id`
 * foreign key, but a foreign writer (a hand-run sqlite3 repair) need not, and
 * an agent whose session row is missing must still be counted exactly as it
 * was before the cache existed. Such a session carries a NULL stamp and is
 * never served from the cache (see {@link UNSTAMPED}).
 *
 * The ORDER BY is load-bearing: totals are summed in this order, and binary
 * `session_id` order is the order the pre-cache single-scan reader summed in,
 * so the floating-point totals stay bit-identical to it.
 */
const DELEGATING_SESSIONS_SQL = `
  SELECT d.session_id AS session_id, s.ingest_seq AS ingest_seq
  FROM (SELECT DISTINCT session_id FROM agents WHERE type = 'subagent') d
  LEFT JOIN sessions s ON s.id = d.session_id
  ORDER BY d.session_id ASC
`;

interface DelegatingSessionRow {
  readonly session_id: string;
  readonly ingest_seq: number | null;
}

interface DelegationAgentRow {
  readonly id: string;
  readonly type: ParsedAgent['type'];
  readonly subagent_type: string | null;
  readonly parent_agent_id: string | null;
}

/**
 * Agents of ONE delegating session. The `type IN (...)` filter is not
 * cosmetic: the column is nullable and a NULL type has no meaning in the
 * estimator's tree walk. Such rows are counted separately (`untypedAgents`)
 * so their exclusion is stated rather than silently applied.
 */
const DELEGATION_AGENTS_SQL = `
  SELECT id, type, subagent_type, parent_agent_id
  FROM agents
  WHERE session_id = ? AND type IN ('main', 'subagent')
  ORDER BY id ASC
`;

interface DelegationUsageRow {
  readonly message_id: string;
  readonly agent_id: string | null;
  readonly model: string;
  readonly occurred_at: string;
  readonly undated_rows: number;
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
}

/**
 * One row per stored message of ONE session — the DB's own dedup, since
 * ingest already collapsed each `message.id` to its per-bucket maximum before
 * writing. Scoped by `session_id`, so it is an `idx_token_usage_session_id`
 * range read bounded by that session's rows, not a corpus-wide GROUP BY.
 *
 * The `MAX()`s over `agent_id`/`model`/`occurred_at` are identities on
 * anything this server wrote (the writer settles all three at MESSAGE level
 * and replicates them across the five bucket rows); they exist so a
 * hand-inserted row set that disagrees resolves deterministically instead of
 * depending on scan order. `undated_rows` counts the timestamps SQLite cannot
 * price against — the session carrying any is excluded and named, never priced
 * from an empty date.
 */
const DELEGATION_USAGE_SQL = `
  SELECT
    message_id,
    MAX(agent_id) AS agent_id,
    MAX(model) AS model,
    COALESCE(MAX(occurred_at), '') AS occurred_at,
    SUM(CASE WHEN occurred_at IS NULL THEN 1 ELSE 0 END) AS undated_rows,
    SUM(CASE WHEN bucket = 'input' THEN tokens ELSE 0 END) AS input,
    SUM(CASE WHEN bucket = 'output' THEN tokens ELSE 0 END) AS output,
    SUM(CASE WHEN bucket = 'cache_read' THEN tokens ELSE 0 END) AS cache_read,
    SUM(CASE WHEN bucket = 'cache_write_5m' THEN tokens ELSE 0 END) AS cache_write_5m,
    SUM(CASE WHEN bucket = 'cache_write_1h' THEN tokens ELSE 0 END) AS cache_write_1h
  FROM token_usage
  WHERE session_id = ?
  GROUP BY message_id
  ORDER BY message_id ASC
`;

/** A prepared statement on {@link SqliteDatabase}. */
type SqliteStatement = ReturnType<SqliteDatabase['prepare']>;

/** What one delegating session contributes to the aggregate. */
type SessionSavingsOutcome =
  | {
      readonly kind: 'priced';
      readonly actualUsd: number;
      readonly hypotheticalUsd: number;
      readonly savingsUsd: number;
      readonly subagentsPriced: number;
      readonly subagentsSkipped: number;
      readonly hypotheticalModels: readonly string[];
    }
  | { readonly kind: 'skipped'; readonly skip: AggregateSavingsSkipDto };

/**
 * Rebuild one session as a `ParsedSession`-shaped value straight off the
 * stored rows, and price it. Module-private on purpose: the placeholder
 * timestamps below must never reach a DTO.
 */
function priceDelegatingSession(
  agentsStmt: SqliteStatement,
  usageStmt: SqliteStatement,
  sessionId: string,
  pricing: readonly PricingEntry[],
  savingsOptions: { readonly topTierModel?: string },
): SessionSavingsOutcome {
  const agents: ParsedAgent[] = [];
  // The main-agent ids of THIS session. Scoped per session on purpose (the
  // pre-cache reader used one corpus-wide set): a usage row that names
  // another session's main agent is this session's unattributed usage, never
  // that agent's — the same rule the session tree and the global DAG apply —
  // and per-session scope is what lets one session be repriced alone.
  // Typed to accept the nullable usage column: `has(null)` is false and the
  // false arm returns that same null, so the inversion below needs no separate
  // null guard for usage rows that carry no agent id.
  const mainAgentIds = new Set<string | null>();
  for (const row of agentsStmt.all(sessionId) as DelegationAgentRow[]) {
    agents.push({
      id: row.id,
      type: row.type,
      subagentType: row.subagent_type,
      parentAgentId: row.parent_agent_id,
      // NOT measurements, and never presented as any. `computeDelegationSavings`
      // reads neither field; they exist only to satisfy `ParsedAgent`. Empty
      // strings rather than a fabricated timestamp, so a future core version
      // that starts reading them fails loudly instead of pricing a lie.
      startedAt: '',
      endedAt: '',
    });
    if (row.type === 'main') mainAgentIds.add(row.id);
  }

  let undatedRows = 0;
  const usage: DedupedUsage[] = [];
  for (const row of usageStmt.all(sessionId) as DelegationUsageRow[]) {
    undatedRows += row.undated_rows;
    usage.push({
      messageId: row.message_id,
      model: row.model,
      timestamp: row.occurred_at,
      // The one mandatory translation. Ingest stores the MAIN agent's usage
      // under that agent's id, while the parser — and therefore the estimator —
      // keys main-transcript usage as `null`. Without inverting it here, every
      // subagent whose nearest usage-bearing ancestor is the main agent would
      // be reported as having no derivable top-tier model.
      agentId: mainAgentIds.has(row.agent_id) ? null : row.agent_id,
      usage: {
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite5m: row.cache_write_5m,
        cacheWrite1h: row.cache_write_1h,
      },
    });
  }

  if (undatedRows > 0) {
    // Pricing is date-driven; an empty timestamp has no rate, and inventing
    // one (say, "now") would silently reprice history.
    return {
      kind: 'skipped',
      skip: {
        sessionId,
        reason: 'undated-usage',
        detail: `${String(undatedRows)} stored usage row(s) carry no timestamp, so no dated rate applies`,
      },
    };
  }
  try {
    const result = computeDelegationSavings(
      {
        sessionId,
        agents,
        // The estimator walks `parentAgentId`; it never reads `edges`. An
        // equivalence test guards that claim against a core change.
        edges: [],
        usage,
      } satisfies ParsedSession,
      pricing,
      savingsOptions,
    );
    return {
      kind: 'priced',
      actualUsd: result.actualUsd,
      hypotheticalUsd: result.hypotheticalUsd,
      savingsUsd: result.savingsUsd,
      subagentsPriced: result.perAgent.length,
      subagentsSkipped: result.skippedAgentIds.length,
      hypotheticalModels: result.perAgent.map((agent) => agent.hypotheticalModel),
    };
  } catch (error) {
    if (!(error instanceof PricingError)) throw error; // → uniform detail-free 500
    return {
      kind: 'skipped',
      skip: { sessionId, reason: 'unpriceable', detail: error.message },
    };
  }
}

/**
 * Marker for a delegating session whose `sessions` row is missing (see
 * {@link DELEGATING_SESSIONS_SQL}). No real stamp is negative — migration 22
 * CHECKs `ingest_seq >= 0` — so it can never match a cached stamp, and such a
 * session is recomputed on every request instead of trusted.
 */
export const UNSTAMPED = -1;

interface DelegationSavingsCacheEntry {
  /** Everything that reprices EVERY session at once; see the cache note. */
  readonly globalKey: string;
  readonly perSession: Map<
    string,
    { readonly seq: number; readonly outcome: SessionSavingsOutcome }
  >;
}

/**
 * Incremental cache for the aggregate (row-1 performance work, 2026-11-13).
 *
 * WHY. The pre-cache reader re-priced every delegating session on every
 * request: one corpus-wide GROUP BY over `token_usage` plus the estimator per
 * session. Measured on the owner's real corpus (scratch copy, 2026-11-12)
 * that scan alone took 80-142 s wall under machine load, and the cost-summary
 * style key (`total_changes()`) moves on every ingest tick, so a
 * whole-answer memo would almost never hit on a live server.
 *
 * HOW. Each session's outcome is cached with the session's `ingest_seq`
 * stamp. Migration 22's triggers bump that stamp on every INSERT and every
 * value-changing UPDATE of the session row or of its agents, usage rows or
 * spawn edges — exactly the rows a session's figure reads, because agents and
 * usage rows never move between sessions (both upserts leave `session_id`
 * untouched). A request lists the delegating sessions with their stamps (one
 * index-friendly read of `agents`), recomputes only the sessions whose stamp
 * moved or that are new, drops sessions that stopped delegating, and sums.
 * An actively ingesting server therefore reprices one or two live sessions
 * per request instead of the corpus.
 *
 * WHAT THE STAMP CANNOT SEE, and what covers it — all folded into
 * `globalKey`, any change of which flushes every session:
 * - DELETEs bump no stamp. This process deletes ledger rows only through
 *   retention, which bumps the in-process ledger epoch (`db/ledger-epoch.ts`).
 * - Another connection's INSERTs and UPDATEs do bump stamps (the triggers
 *   live in the schema), but its DELETEs do not and its epoch is not ours;
 *   `PRAGMA data_version` moves on any foreign commit, so it rides in the
 *   key exactly as it does in the cost-summary key.
 * - Pricing and the routing override reprice every session; both ride in the
 *   key verbatim. `pricing` is the caller's argument, not a table read, so
 *   whatever the caller priced with is what the key fingerprints.
 *
 * The transaction caveat of {@link costSummaryStateKey} applies unchanged: an
 * outcome computed INSIDE a transaction that later rolls back can outlive it.
 * No HTTP handler can run inside ingest's or retention's transaction on this
 * synchronous handle, so it is not reachable through the server.
 */
const delegationSavingsCache = new WeakMap<SqliteDatabase, DelegationSavingsCacheEntry>();

/**
 * Execution-count seam for the cache tests, in the spirit of
 * {@link CostSummaryProbe}: `onSessionPriced` fires exactly when one session
 * is actually rebuilt and priced, and never for a session served from cache.
 */
export interface DelegationSavingsProbe {
  onSessionPriced(sessionId: string): void;
}

export interface AggregateDelegationSavingsOptions {
  /** WP-C5 rule-1 routing override, passed straight through to the estimator. */
  readonly topTierModel?: string;
}

/**
 * Corpus-wide delegation savings (M-9). Never refuses on account of one bad
 * session and never quietly drops one either: a session whose usage cannot be
 * priced is excluded from the sums AND named in `skippedSessions` with the
 * pricing error that caused it, so the reader can see the aggregate's true
 * scope. That follows the house precedent — `getCostSummary` reports
 * `unpricedTokens` rather than withholding the whole figure — and it is the
 * only choice that scales: on a corpus of hundreds of sessions, refusing
 * everything because one names an unknown model would make the KPI useless
 * exactly when it matters.
 */
export function getAggregateDelegationSavings(
  db: SqliteDatabase,
  pricing: readonly PricingEntry[],
  options: AggregateDelegationSavingsOptions = {},
  probe?: DelegationSavingsProbe,
): AggregateDelegationSavingsDto {
  const countOf = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const sessionsTotal = countOf('SELECT COUNT(*) AS n FROM sessions');
  const untypedAgents = countOf('SELECT COUNT(*) AS n FROM agents WHERE type IS NULL');
  const savingsOptions =
    options.topTierModel === undefined ? {} : { topTierModel: options.topTierModel };

  const dataVersion = db.pragma('data_version', { simple: true }) as number;
  const globalKey = JSON.stringify([
    dataVersion,
    ledgerEpoch(db),
    options.topTierModel ?? null,
    pricing,
  ]);
  const previous = delegationSavingsCache.get(db);
  const cached =
    previous?.globalKey === globalKey
      ? previous.perSession
      : new Map<string, { seq: number; outcome: SessionSavingsOutcome }>();

  const delegating = db.prepare(DELEGATING_SESSIONS_SQL).all() as DelegatingSessionRow[];
  const agentsStmt = db.prepare(DELEGATION_AGENTS_SQL);
  const usageStmt = db.prepare(DELEGATION_USAGE_SQL);
  // Rebuilt from the listing on every request, so a session that stopped
  // delegating (or vanished) drops out instead of lingering in the cache.
  const perSession = new Map<string, { seq: number; outcome: SessionSavingsOutcome }>();

  let actualUsd = 0;
  let hypotheticalUsd = 0;
  let savingsUsd = 0;
  let sessionsPriced = 0;
  let subagentsPriced = 0;
  let subagentsSkipped = 0;
  const hypotheticalModels = new Set<string>();
  const skipped: AggregateSavingsSkipDto[] = [];

  for (const { session_id: sessionId, ingest_seq } of delegating) {
    const seq = ingest_seq ?? UNSTAMPED;
    const hit = cached.get(sessionId);
    let outcome: SessionSavingsOutcome;
    if (hit !== undefined && seq !== UNSTAMPED && hit.seq === seq) {
      outcome = hit.outcome;
    } else {
      probe?.onSessionPriced(sessionId);
      outcome = priceDelegatingSession(agentsStmt, usageStmt, sessionId, pricing, savingsOptions);
    }
    perSession.set(sessionId, { seq, outcome });

    if (outcome.kind === 'skipped') {
      skipped.push(outcome.skip);
      continue;
    }
    sessionsPriced += 1;
    actualUsd += outcome.actualUsd;
    hypotheticalUsd += outcome.hypotheticalUsd;
    savingsUsd += outcome.savingsUsd;
    subagentsPriced += outcome.subagentsPriced;
    subagentsSkipped += outcome.subagentsSkipped;
    for (const model of outcome.hypotheticalModels) hypotheticalModels.add(model);
  }
  // Stored only after every session priced: a non-pricing failure above
  // throws out of the loop and leaves the previous entry in place.
  delegationSavingsCache.set(db, { globalKey, perSession });

  return {
    actualUsd,
    hypotheticalUsd,
    savingsUsd,
    isEstimate: true,
    basis: 'stored-usage-rows',
    sessionsTotal,
    sessionsWithSubagents: delegating.length,
    sessionsPriced,
    // The COUNT is authoritative and uncapped; the array is a bounded sample so
    // one KPI request cannot turn a broken corpus into a huge payload.
    skippedSessionCount: skipped.length,
    skippedSessions: skipped.slice(0, MAX_AGGREGATE_SKIPPED_SAMPLE),
    subagentsPriced,
    subagentsSkipped,
    untypedAgents,
    hypotheticalModels: [...hypotheticalModels].sort(byBinary),
  };
}
