/**
 * Shared DTO builders + fetch-response helper for the view tests (WP-U6..U9).
 * Every builder returns a fully-populated, schema-shaped object; tests
 * override only the fields they assert on. Nothing here touches the network
 * or the real ~/.claude tree.
 */
import type {
  AgentNodeDto,
  CostSummaryDto,
  GlobalDagDto,
  OrchestrationEdgeDto,
  SessionListDto,
  SessionStatusCountsDto,
  SessionSummaryDto,
  SessionTreeDto,
} from '../src/dto';

export function statusCounts(
  overrides: Partial<SessionStatusCountsDto> = {},
): SessionStatusCountsDto {
  return { working: 0, waiting: 0, completed: 0, error: 0, unknown: 0, ...overrides };
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

export function costSummary(overrides: Partial<CostSummaryDto> = {}): CostSummaryDto {
  return {
    totals: { tokens: 0, costUsd: 0, unpricedTokens: 0 },
    perModel: [],
    perDay: [],
    topSessions: [],
    ...overrides,
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

/** A response whose body is not JSON (json() rejects). */
export function textResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError('not json')),
  } as Response;
}
