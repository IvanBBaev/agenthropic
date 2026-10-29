/**
 * Shared DTO builders + fetch-response helper for the view tests (WP-U6..U9).
 * Every builder returns a fully-populated, schema-shaped object; tests
 * override only the fields they assert on. Nothing here touches the network
 * or the real ~/.claude tree.
 */
import type {
  AggregateDelegationSavingsDto,
  AgentDelegationSavingsDto,
  AgentNodeDto,
  ChangedSessionDto,
  ChangesDto,
  CompactionSegmentDto,
  CostAnalysisDto,
  CostSummaryDto,
  GlobalDagDto,
  OrchestrationEdgeDto,
  SessionCostDto,
  SessionListDto,
  SessionPartialDto,
  SessionOutcomeCauseCountsDto,
  SessionStatusCountsDto,
  SessionSummaryDto,
  SessionTreeDto,
} from '../src/dto';

export function statusCounts(
  overrides: Partial<SessionStatusCountsDto> = {},
): SessionStatusCountsDto {
  return { working: 0, waiting: 0, completed: 0, error: 0, unknown: 0, ...overrides };
}

export function outcomeCauseCounts(
  overrides: Partial<SessionOutcomeCauseCountsDto> = {},
): SessionOutcomeCauseCountsDto {
  return {
    concurrency_limit: 0,
    user_interrupt: 0,
    permission_failed: 0,
    dispatch_unavailable: 0,
    terminated_early: 0,
    unclassified: 0,
    ...overrides,
  };
}

export function sessionSummary(overrides: Partial<SessionSummaryDto> = {}): SessionSummaryDto {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    projectSlug: 'agenthropic',
    status: 'working',
    startedAt: '2026-07-29T10:00:00.000Z',
    lastActivityAt: '2026-07-29T10:05:00.000Z',
    agentCount: 3,
    totalTokens: 1200,
    totalCostUsd: 0.42,
    unpricedTokens: 0,
    statusCounts: statusCounts({ working: 1, completed: 2 }),
    outcomeCauseCounts: outcomeCauseCounts(),
    partial: null,
    usageRecordsDropped: 0,
    ...overrides,
  };
}

export function sessionList(
  sessions: readonly SessionSummaryDto[] = [],
  overrides: Partial<Omit<SessionListDto, 'sessions'>> = {},
): SessionListDto {
  return {
    sessions: [...sessions],
    total: sessions.length,
    limit: 50,
    offset: 0,
    ...overrides,
  };
}

export function agentNode(overrides: Partial<AgentNodeDto> = {}): AgentNodeDto {
  return {
    id: 'agent-main',
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    type: 'main',
    subagentType: null,
    status: 'working',
    // NULL is the honest default: "no parent-side outcome was observed", not
    // a claim that the agent finished cleanly. A fixture that defaulted to a
    // cause would put a reason on every agent in every test.
    outcomeCause: null,
    parentAgentId: null,
    firstSeenAt: '2026-07-29T10:00:00.000Z',
    lastSeenAt: '2026-07-29T10:05:00.000Z',
    totalTokens: 800,
    costUsd: 0.3,
    unpricedTokens: 0,
    ...overrides,
  };
}

export function orchestrationEdge(
  overrides: Partial<OrchestrationEdgeDto> = {},
): OrchestrationEdgeDto {
  return {
    id: 1,
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    parentAgentId: 'agent-main',
    childAgentId: 'agent-child',
    source: 'tool_use',
    instance: 'default',
    hostId: 'host-1',
    createdAt: '2026-07-29T10:01:00.000Z',
    ...overrides,
  };
}

export function sessionTree(overrides: Partial<SessionTreeDto> = {}): SessionTreeDto {
  const agents = overrides.agents ?? [
    agentNode(),
    agentNode({
      id: 'agent-child',
      type: 'subagent',
      subagentType: 'Explore',
      status: 'completed',
    }),
  ];
  const edges = overrides.edges ?? [orchestrationEdge()];
  return {
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    agentCount: agents.length,
    edgeCount: edges.length,
    unattributed: { totalTokens: 0, costUsd: 0, unpricedTokens: 0 },
    partial: null,
    usageRecordsDropped: 0,
    ...overrides,
    agents,
    edges,
  };
}

export function globalDag(
  overrides: Omit<Partial<GlobalDagDto>, 'counts'> & {
    counts?: Partial<GlobalDagDto['counts']>;
  } = {},
): GlobalDagDto {
  const nodes = overrides.nodes ?? [];
  const edges = overrides.edges ?? [];
  return {
    counts: {
      totalSessions: 0,
      totalAgents: nodes.length,
      totalEdges: edges.length,
      returnedAgents: nodes.length,
      returnedEdges: edges.length,
      truncated: false,
      ...overrides.counts,
    },
    nodes,
    edges,
  };
}

/**
 * `GET /api/cost/summary`.
 *
 * `sessionCount` and `hasMore` (added 2026-09-09, L1) default to what the rest
 * of the fixture already implies rather than to a flat zero. A builder called
 * as `costSummary({ topSessions: [a, b, c] })` yields `sessionCount: 3` and
 * `hasMore: false`, so a test that omits the counter cannot hand a view three
 * rows and a denominator of nought: "3 of 0 sessions" is not a smaller lie than
 * the hedge CV-5 replaced, it is a louder one, and it would be produced by
 * forgetting rather than by deciding.
 *
 * The two numbers legitimately disagree in exactly one case - a corpus larger
 * than the slice - and a test that wants that case says so by passing
 * `sessionCount` itself. Passing `hasMore` on its own is possible too, and is
 * how the suite builds the payloads a consistent server cannot send.
 */
export function costSummary(overrides: Partial<CostSummaryDto> = {}): CostSummaryDto {
  const topSessions = overrides.topSessions ?? [];
  const sessionCount = overrides.sessionCount ?? topSessions.length;
  return {
    totals: { tokens: 0, costUsd: 0, unpricedTokens: 0 },
    perModel: [],
    perDay: [],
    partialSessions: 0,
    usageRecordsDropped: 0,
    ...overrides,
    topSessions,
    sessionCount,
    hasMore: overrides.hasMore ?? sessionCount > topSessions.length,
  };
}

/**
 * One `topSessions` row of the cost summary, whole by default: `partial: null`
 * and nothing dropped, so a test opts INTO the owner-decision-1/2 disclosures.
 */
export function sessionCost(overrides: Partial<SessionCostDto> = {}): SessionCostDto {
  return {
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    projectSlug: 'agenthropic',
    tokens: 1000,
    costUsd: 1,
    unpricedTokens: 0,
    partial: null,
    usageRecordsDropped: 0,
    ...overrides,
  };
}

/** Owner decision 1: the main transcript was over the 64 MiB read cap. */
export const OVERSIZE_PARTIAL: SessionPartialDto = {
  reason: 'main-transcript-oversize',
  skippedBytes: 73_400_320,
};

/**
 * `GET /api/cost/delegation-savings` (M-9, aggregate half). Like the
 * per-session builder below, `isEstimate` and `basis` are schema literals a
 * fixture may not flip - and the default is the HONEST empty shape: an empty
 * corpus, every counter zero, so a test that forgets to set a scope counter
 * cannot accidentally render a dollar figure with a fabricated denominator.
 */
export function aggregateSavings(
  overrides: Partial<AggregateDelegationSavingsDto> = {},
): AggregateDelegationSavingsDto {
  return {
    actualUsd: 0,
    hypotheticalUsd: 0,
    savingsUsd: 0,
    isEstimate: true,
    basis: 'stored-usage-rows',
    sessionsTotal: 0,
    sessionsWithSubagents: 0,
    sessionsPriced: 0,
    skippedSessionCount: 0,
    skippedSessions: [],
    subagentsPriced: 0,
    subagentsSkipped: 0,
    untypedAgents: 0,
    hypotheticalModels: [],
    ...overrides,
  };
}

/**
 * `GET /api/sessions/:id/cost-analysis` (WP-C4 + WP-C5). `isEstimate` is a
 * literal `true` in the schema, not a flag a fixture may flip: the delegation
 * counterfactual is not observable, so no builder is allowed to produce a
 * shape that presents it as a measured dollar amount.
 */
export function costAnalysis(overrides: Partial<CostAnalysisDto> = {}): CostAnalysisDto {
  return {
    compaction: {
      naiveUsd: 0,
      repricedUsd: 0,
      deltaUsd: 0,
      compactionCount: 0,
      segments: [],
    },
    delegationSavings: {
      actualUsd: 0,
      hypotheticalUsd: 0,
      savingsUsd: 0,
      perAgent: [],
      skippedAgentIds: [],
      isEstimate: true,
    },
    partial: null,
    usageRecordsDropped: 0,
    ...overrides,
  };
}

/**
 * One compaction-delimited slice of a transcript. `boundary` defaults to null -
 * the segment that opens a transcript is opened by nothing, and that is a fact
 * about the stream rather than a missing field a fixture should paper over.
 */
export function compactionSegment(
  overrides: Partial<CompactionSegmentDto> = {},
): CompactionSegmentDto {
  return {
    agentId: null,
    index: 0,
    boundary: null,
    usd: 0.5,
    messageCount: 12,
    tokens: { input: 100, output: 200, cacheRead: 300, cacheWrite5m: 40, cacheWrite1h: 5 },
    ...overrides,
  };
}

/** One subagent's delegation counterfactual; `isEstimate` is not overridable. */
export function agentSavings(
  overrides: Partial<Omit<AgentDelegationSavingsDto, 'isEstimate'>> = {},
): AgentDelegationSavingsDto {
  return {
    agentId: 'cafebabe-0000-1111-2222-333333333333',
    parentAgentId: 'aaaaaaaa-1111-2222-3333-444444444444',
    actualUsd: 0.2,
    hypotheticalUsd: 0.9,
    savingsUsd: 0.7,
    hypotheticalModel: 'claude-opus-5',
    ...overrides,
    isEstimate: true,
  };
}

/** Minimal Response stand-in covering exactly what the api helpers touch. */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** A promise plus its resolver, so a test can hold a fetch in flight on purpose. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A response whose body is not JSON (json() rejects). */
export function textResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError('not json')),
  } as Response;
}

/**
 * L5 (2026-09-09, WP-U13): one agent per persisted outcome cause, plus one
 * that carries none - the payload a view has to render honestly.
 *
 * Mirrors the SHAPE of the `agent-outcome-errors` fixture in
 * @agenthropic/test-fixtures, which this package cannot import (it is not a
 * dependency of apps/web, on purpose - the web tests never touch the ingest
 * side). The two agent ids that fixture defines are reused verbatim for the
 * two causes it actually carries, so a reader who greps `fa11ed01` or
 * `de1e7ed2` lands on both halves of the same story, and the statuses match
 * what the normalizer assigns there: `terminated_early` is the ONE cause in
 * `ERROR_CAUSES`, and `user_interrupt` deliberately keeps its ordinary
 * liveness status. The remaining four causes exist in the measured corpus
 * (19 concurrency_limit, 3 permission_failed, 2 dispatch_unavailable of 33)
 * but not in that two-agent fixture, so they get synthetic ids here.
 *
 * Deliberately spread across statuses: a surface that filtered on
 * `status === 'error'` would render exactly one of these seven rows.
 */
export function outcomeCauseAgents(): readonly AgentNodeDto[] {
  return [
    agentNode({
      id: 'fa11ed01',
      type: 'subagent',
      subagentType: 'Explore',
      status: 'error',
      outcomeCause: 'terminated_early',
    }),
    agentNode({
      id: 'de1e7ed2',
      type: 'subagent',
      subagentType: 'general-purpose',
      status: 'completed',
      outcomeCause: 'user_interrupt',
    }),
    agentNode({
      id: 'c0ffee01',
      type: 'subagent',
      subagentType: 'Plan',
      status: 'unknown',
      outcomeCause: 'concurrency_limit',
    }),
    agentNode({
      id: 'c0ffee02',
      type: 'subagent',
      subagentType: 'statusline-setup',
      status: 'completed',
      outcomeCause: 'permission_failed',
    }),
    agentNode({
      id: 'c0ffee03',
      type: 'subagent',
      subagentType: 'code-reviewer',
      status: 'waiting',
      outcomeCause: 'dispatch_unavailable',
    }),
    agentNode({
      id: 'c0ffee04',
      type: 'subagent',
      subagentType: 'doc-writer',
      status: 'working',
      outcomeCause: 'unclassified',
    }),
    // No parent-side outcome was ever observed for this one - by far the
    // commonest case, and NOT a claim that it finished cleanly.
    agentNode({
      id: 'c0ffee05',
      type: 'subagent',
      subagentType: 'Explore',
      status: 'completed',
      outcomeCause: null,
    }),
  ];
}

/** D11(a): one session that changed inside a `/api/changes` window. */
export function changedSession(overrides: Partial<ChangedSessionDto> = {}): ChangedSessionDto {
  return {
    id: 'cccccccc-1111-2222-3333-444444444444',
    projectSlug: 'agenthropic',
    status: 'completed',
    startedAt: '2026-09-29T08:00:00.000Z',
    lastActivityAt: '2026-09-29T09:30:00.000Z',
    changedAt: '2026-09-29T09:30:00.000Z',
    change: 'new',
    agentsAppeared: 2,
    tokensAdded: 12_000,
    costAddedUsd: 0.42,
    unpricedTokensAdded: 0,
    ...overrides,
  };
}

/**
 * D11(a): a `/api/changes` answer. By default one new session, a consistent
 * `total`, zero residue and zero undated rows - the complete, unremarkable
 * window, so each honesty notice appears only when a test asks for it.
 */
export function changes(overrides: Partial<ChangesDto> = {}): ChangesDto {
  const sessions = overrides.sessions ?? [changedSession()];
  return {
    since: '2026-09-29T00:00:00.000Z',
    until: '2026-09-29T09:30:00.000Z',
    interval: '(since, until]',
    basis: 'event-time',
    ingestCursor: 7,
    lateIngested: null,
    sessions,
    totals: {
      sessionsNew: 1,
      sessionsUpdated: 0,
      sessionsUnknownStart: 0,
      agentsAppeared: 2,
      tokensAdded: 12_000,
      costAddedUsd: 0.42,
      unpricedTokensAdded: 0,
      tokensAddedOutsideChangedSessions: 0,
    },
    coverage: { undatedSessions: 0, undatedAgents: 0, undatedUsageRows: 0 },
    total: sessions.length,
    limit: 50,
    offset: 0,
    ...overrides,
  };
}
