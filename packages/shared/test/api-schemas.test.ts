import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AgentNodeSchema,
  AgentStatusSchema,
  AgentStatusChangedEventSchema,
  ApiErrorSchema,
  CostSummaryResponseSchema,
  DEFAULT_COST_TOP_N,
  DEFAULT_DAG_NODE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  GenericRealtimeEventSchema,
  GlobalDagResponseSchema,
  MAX_COST_TOP_N,
  MAX_DAG_NODE_LIMIT,
  MAX_PAGE_LIMIT,
  OrchestrationEdgeDtoSchema,
  RealtimeEventSchema,
  SessionDetailSchema,
  SessionEventsResponseSchema,
  SessionHookEventSchema,
  SessionIngestedEventSchema,
  SessionListResponseSchema,
  SessionTreeResponseSchema,
  nullable,
  type AgentNodeDto,
  type OrchestrationEdgeDto,
  type SessionHookEventDto,
  type SessionSummaryDto,
} from '../src/index';
import { Type } from '@sinclair/typebox';

const agentNode: AgentNodeDto = {
  id: 'agent-1',
  sessionId: 'session-1',
  type: 'subagent',
  subagentType: 'explorer',
  status: 'working',
  parentAgentId: 'agent-0',
  firstSeenAt: '2026-07-11T00:00:00Z',
  lastSeenAt: '2026-07-11T00:05:00Z',
  totalTokens: 1200,
  costUsd: 0.012,
  unpricedTokens: 0,
};

const edge: OrchestrationEdgeDto = {
  id: 1,
  sessionId: 'session-1',
  parentAgentId: 'agent-0',
  childAgentId: 'agent-1',
  source: 'tool_use',
  instance: 'default',
  hostId: 'host-1',
  createdAt: '2026-07-11T00:00:00Z',
};

const sessionSummary: SessionSummaryDto = {
  id: 'session-1',
  projectSlug: 'demo',
  status: 'active',
  startedAt: '2026-07-11T00:00:00Z',
  lastActivityAt: '2026-07-11T01:00:00Z',
  agentCount: 2,
  totalTokens: 3400,
  totalCostUsd: 0.05,
  unpricedTokens: 100,
  statusCounts: { working: 1, waiting: 0, completed: 1, error: 0, unknown: 0 },
};

describe('common API schemas', () => {
  it('nullable() accepts both the base type and null', () => {
    const schema = nullable(Type.String());
    expect(Value.Check(schema, 'text')).toBe(true);
    expect(Value.Check(schema, null)).toBe(true);
    expect(Value.Check(schema, 5)).toBe(false);
  });

  it('ApiErrorSchema is exactly { error: string }', () => {
    expect(Value.Check(ApiErrorSchema, { error: 'Unauthorized.' })).toBe(true);
    expect(Value.Check(ApiErrorSchema, { error: 'x', detail: 'leak' })).toBe(false);
    expect(Value.Check(ApiErrorSchema, {})).toBe(false);
  });

  it('AgentStatusSchema accepts all five statuses including unknown', () => {
    for (const status of ['working', 'waiting', 'completed', 'error', 'unknown']) {
      expect(Value.Check(AgentStatusSchema, status)).toBe(true);
    }
    expect(Value.Check(AgentStatusSchema, 'idle')).toBe(false);
  });

  it('pagination and cap constants are coherent (default never above max)', () => {
    expect(DEFAULT_PAGE_LIMIT).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
    expect(DEFAULT_COST_TOP_N).toBeLessThanOrEqual(MAX_COST_TOP_N);
    expect(DEFAULT_DAG_NODE_LIMIT).toBeLessThanOrEqual(MAX_DAG_NODE_LIMIT);
  });
});

describe('graph schemas', () => {
  it('accepts a full agent node and a node with nullable fields at null', () => {
    expect(Value.Check(AgentNodeSchema, agentNode)).toBe(true);
    expect(
      Value.Check(AgentNodeSchema, {
        ...agentNode,
        type: null,
        subagentType: null,
        status: null,
        parentAgentId: null,
        firstSeenAt: null,
        lastSeenAt: null,
      }),
    ).toBe(true);
  });

  it('rejects an agent node with negative tokens or extra properties', () => {
    expect(Value.Check(AgentNodeSchema, { ...agentNode, totalTokens: -1 })).toBe(false);
    expect(Value.Check(AgentNodeSchema, { ...agentNode, secret: true })).toBe(false);
  });

  it('accepts every persisted edge source and rejects an unknown one', () => {
    for (const source of ['tool_use', 'directory', 'task_notification', 'queue_operation']) {
      expect(Value.Check(OrchestrationEdgeDtoSchema, { ...edge, source })).toBe(true);
    }
    expect(Value.Check(OrchestrationEdgeDtoSchema, { ...edge, source: 'guessed' })).toBe(false);
    expect(Value.Check(OrchestrationEdgeDtoSchema, { ...edge, extra: 1 })).toBe(false);
  });
});

describe('session schemas', () => {
  it('accepts a session list response and rejects a summary missing statusCounts', () => {
    expect(
      Value.Check(SessionListResponseSchema, {
        sessions: [sessionSummary],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toBe(true);
    const withoutCounts: Record<string, unknown> = { ...sessionSummary };
    delete withoutCounts.statusCounts;
    expect(
      Value.Check(SessionListResponseSchema, {
        sessions: [withoutCounts],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toBe(false);
  });

  it('statusCounts must include the unknown bucket', () => {
    const counts = { working: 0, waiting: 0, completed: 0, error: 0 };
    expect(
      Value.Check(SessionListResponseSchema, {
        sessions: [{ ...sessionSummary, statusCounts: counts }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toBe(false);
  });

  it('accepts a session detail (summary + edgeCount + models)', () => {
    const detail = {
      ...sessionSummary,
      edgeCount: 1,
      models: [{ model: 'claude-fable-5', tokens: 3400, costUsd: 0.05, unpricedTokens: 100 }],
    };
    expect(Value.Check(SessionDetailSchema, detail)).toBe(true);
    expect(Value.Check(SessionDetailSchema, { ...detail, extra: 1 })).toBe(false);
    expect(Value.Check(SessionDetailSchema, sessionSummary)).toBe(false);
  });

  it('accepts a session tree with agents, edges and the unattributed rollup', () => {
    const tree = {
      sessionId: 'session-1',
      agents: [agentNode],
      edges: [edge],
      agentCount: 1,
      edgeCount: 1,
      unattributed: { totalTokens: 10, costUsd: 0.0001, unpricedTokens: 0 },
    };
    expect(Value.Check(SessionTreeResponseSchema, tree)).toBe(true);
    expect(Value.Check(SessionTreeResponseSchema, { ...tree, unattributed: {} })).toBe(false);
  });
});

describe('hook liveness event schemas (WP-D5)', () => {
  const hookEvent: SessionHookEventDto = {
    id: 1,
    rawEventId: 10,
    agentId: 'agent-1',
    eventType: 'Stop',
    occurredAt: '2026-07-11T10:00:00Z',
    occurredAtSource: 'receipt',
  };

  it('accepts a full event and one with nullable fields at null', () => {
    expect(Value.Check(SessionHookEventSchema, hookEvent)).toBe(true);
    expect(
      Value.Check(SessionHookEventSchema, {
        ...hookEvent,
        agentId: null,
        eventType: null,
        occurredAt: null,
      }),
    ).toBe(true);
  });

  it("occurredAtSource is a closed union - only 'receipt' exists today", () => {
    expect(Value.Check(SessionHookEventSchema, { ...hookEvent, occurredAtSource: 'event' })).toBe(
      false,
    );
    const withoutSource: Record<string, unknown> = { ...hookEvent };
    delete withoutSource.occurredAtSource;
    expect(Value.Check(SessionHookEventSchema, withoutSource)).toBe(false);
  });

  it('the DTO is closed - a payload field can never ride along', () => {
    expect(Value.Check(SessionHookEventSchema, { ...hookEvent, payload: { x: 1 } })).toBe(false);
    expect(Value.Check(SessionHookEventSchema, { ...hookEvent, prompt: 'leak' })).toBe(false);
  });

  it('accepts the session events response and rejects a missing total', () => {
    const response = {
      sessionId: 'session-1',
      events: [hookEvent],
      total: 1,
      limit: 50,
      offset: 0,
    };
    expect(Value.Check(SessionEventsResponseSchema, response)).toBe(true);
    const withoutTotal: Record<string, unknown> = { ...response };
    delete withoutTotal.total;
    expect(Value.Check(SessionEventsResponseSchema, withoutTotal)).toBe(false);
    expect(Value.Check(SessionEventsResponseSchema, { ...response, extra: 1 })).toBe(false);
  });
});

describe('cost and DAG schemas', () => {
  it('accepts a full cost summary', () => {
    const summary = {
      totals: { tokens: 5000, costUsd: 0.07, unpricedTokens: 100 },
      perModel: [{ model: 'claude-fable-5', tokens: 5000, costUsd: 0.07, unpricedTokens: 100 }],
      perDay: [
        { day: '2026-07-11', tokens: 4000, costUsd: 0.06, unpricedTokens: 0 },
        { day: 'unknown', tokens: 1000, costUsd: 0.01, unpricedTokens: 100 },
      ],
      topSessions: [
        {
          sessionId: 'session-1',
          projectSlug: null,
          tokens: 5000,
          costUsd: 0.07,
          unpricedTokens: 100,
        },
      ],
    };
    expect(Value.Check(CostSummaryResponseSchema, summary)).toBe(true);
    expect(Value.Check(CostSummaryResponseSchema, { ...summary, totals: undefined })).toBe(false);
  });

  it('rejects a negative dollar figure anywhere in the cost summary', () => {
    expect(
      Value.Check(CostSummaryResponseSchema, {
        totals: { tokens: 0, costUsd: -0.01, unpricedTokens: 0 },
        perModel: [],
        perDay: [],
        topSessions: [],
      }),
    ).toBe(false);
  });

  it('accepts a global DAG response with counts and the truncated flag', () => {
    const dag = {
      nodes: [agentNode],
      edges: [edge],
      counts: {
        totalSessions: 1,
        totalAgents: 2,
        totalEdges: 1,
        returnedAgents: 1,
        returnedEdges: 1,
        truncated: true,
      },
    };
    expect(Value.Check(GlobalDagResponseSchema, dag)).toBe(true);
    expect(
      Value.Check(GlobalDagResponseSchema, {
        ...dag,
        counts: { ...dag.counts, truncated: 'yes' },
      }),
    ).toBe(false);
  });
});

describe('realtime event schemas', () => {
  const ingested = {
    type: 'session-ingested',
    sessionId: 'session-1',
    projectSlug: 'demo',
    agentCount: 3,
    edgesInserted: 2,
    usageRowsInserted: 40,
    costUsd: 0.12,
    occurredAt: '2026-07-11T00:00:00Z',
  };

  const statusChanged = {
    type: 'agent-status-changed',
    sessionId: 'session-1',
    agentId: 'agent-1',
    status: 'completed',
    previousStatus: 'working',
    occurredAt: '2026-07-11T00:00:00Z',
  };

  it('accepts the two specific events and the generic envelope', () => {
    expect(Value.Check(SessionIngestedEventSchema, ingested)).toBe(true);
    expect(Value.Check(AgentStatusChangedEventSchema, statusChanged)).toBe(true);
    expect(Value.Check(GenericRealtimeEventSchema, { type: 'custom', payload: { a: 1 } })).toBe(
      true,
    );
    for (const event of [ingested, statusChanged, { type: 'custom', payload: {} }]) {
      expect(Value.Check(RealtimeEventSchema, event)).toBe(true);
    }
  });

  it('allows null costUsd (not-yet-priced) but never a missing field', () => {
    expect(Value.Check(SessionIngestedEventSchema, { ...ingested, costUsd: null })).toBe(true);
    const withoutCost: Record<string, unknown> = { ...ingested };
    delete withoutCost.costUsd;
    expect(Value.Check(SessionIngestedEventSchema, withoutCost)).toBe(false);
  });

  it('rejects an unknown status and extra properties on status-changed', () => {
    expect(Value.Check(AgentStatusChangedEventSchema, { ...statusChanged, status: 'done' })).toBe(
      false,
    );
    expect(Value.Check(AgentStatusChangedEventSchema, { ...statusChanged, extra: 1 })).toBe(false);
  });

  it('a bare { type } without payload matches no member of the union', () => {
    expect(Value.Check(RealtimeEventSchema, { type: 'mystery' })).toBe(false);
  });
});
