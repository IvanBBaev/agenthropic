/**
 * Owner decisions 1 and 2 (NN1) on the wire: every DTO that shows a session
 * total carries `partial` + `usageRecordsDropped`, and the cost summary
 * carries the corpus-wide aggregates. Both are REQUIRED - a payload without
 * them is the pre-decision shape, which a client must refuse rather than
 * render as "whole, nothing dropped".
 */
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CostSummaryResponseSchema,
  SessionCostSchema,
  SessionDetailSchema,
  SessionPartialSchema,
  SessionSummarySchema,
  SessionTreeResponseSchema,
  type SessionPartialDto,
  type SessionSummaryDto,
} from '../src/index';

const PARTIAL: SessionPartialDto = { reason: 'main-transcript-oversize', skippedBytes: 73400320 };

const summary: SessionSummaryDto = {
  id: 's',
  projectSlug: null,
  status: null,
  startedAt: null,
  lastActivityAt: null,
  agentCount: 1,
  totalTokens: 10,
  totalCostUsd: 0,
  unpricedTokens: 10,
  statusCounts: { working: 0, waiting: 0, completed: 0, error: 0, unknown: 1 },
  partial: PARTIAL,
  usageRecordsDropped: 3,
};

function without(record: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy[key];
  return copy;
}

describe('SessionPartialSchema', () => {
  it('accepts the one known reason with a byte size or null', () => {
    expect(Value.Check(SessionPartialSchema, PARTIAL)).toBe(true);
    expect(Value.Check(SessionPartialSchema, { ...PARTIAL, skippedBytes: null })).toBe(true);
  });

  it('is a closed union and a closed object', () => {
    expect(Value.Check(SessionPartialSchema, { ...PARTIAL, reason: 'unreadable' })).toBe(false);
    expect(Value.Check(SessionPartialSchema, { ...PARTIAL, skippedBytes: -1 })).toBe(false);
    expect(Value.Check(SessionPartialSchema, { ...PARTIAL, extra: 1 })).toBe(false);
    expect(Value.Check(SessionPartialSchema, without(PARTIAL, 'skippedBytes'))).toBe(false);
  });
});

describe('per-session DTOs require both honesty fields', () => {
  it('summary and detail', () => {
    expect(Value.Check(SessionSummarySchema, summary)).toBe(true);
    expect(Value.Check(SessionSummarySchema, { ...summary, partial: null })).toBe(true);
    expect(Value.Check(SessionSummarySchema, without(summary, 'partial'))).toBe(false);
    expect(Value.Check(SessionSummarySchema, without(summary, 'usageRecordsDropped'))).toBe(false);
    expect(Value.Check(SessionSummarySchema, { ...summary, usageRecordsDropped: -1 })).toBe(false);
    expect(Value.Check(SessionSummarySchema, { ...summary, usageRecordsDropped: 0.5 })).toBe(false);

    const detail = { ...summary, edgeCount: 0, models: [] };
    expect(Value.Check(SessionDetailSchema, detail)).toBe(true);
    expect(Value.Check(SessionDetailSchema, without(detail, 'partial'))).toBe(false);
  });

  it('tree', () => {
    const tree = {
      sessionId: 's',
      agents: [],
      edges: [],
      agentCount: 0,
      edgeCount: 0,
      unattributed: { totalTokens: 0, costUsd: 0, unpricedTokens: 0 },
      partial: PARTIAL,
      usageRecordsDropped: 0,
    };
    expect(Value.Check(SessionTreeResponseSchema, tree)).toBe(true);
    expect(Value.Check(SessionTreeResponseSchema, without(tree, 'partial'))).toBe(false);
    expect(Value.Check(SessionTreeResponseSchema, without(tree, 'usageRecordsDropped'))).toBe(
      false,
    );
  });

  it('a cost-summary top session', () => {
    const row = {
      sessionId: 's',
      projectSlug: null,
      tokens: 1,
      costUsd: 0,
      unpricedTokens: 1,
      partial: null,
      usageRecordsDropped: 0,
    };
    expect(Value.Check(SessionCostSchema, row)).toBe(true);
    expect(Value.Check(SessionCostSchema, { ...row, partial: PARTIAL })).toBe(true);
    expect(Value.Check(SessionCostSchema, without(row, 'partial'))).toBe(false);
    expect(Value.Check(SessionCostSchema, without(row, 'usageRecordsDropped'))).toBe(false);
  });
});

describe('the cost summary requires the corpus-wide aggregates', () => {
  const base = {
    totals: { tokens: 0, costUsd: 0, unpricedTokens: 0 },
    perModel: [],
    perDay: [],
    topSessions: [],
    sessionCount: 0,
    hasMore: false,
    partialSessions: 2,
    usageRecordsDropped: 7,
  };

  it('accepts them and refuses a payload without either', () => {
    expect(Value.Check(CostSummaryResponseSchema, base)).toBe(true);
    expect(Value.Check(CostSummaryResponseSchema, without(base, 'partialSessions'))).toBe(false);
    expect(Value.Check(CostSummaryResponseSchema, without(base, 'usageRecordsDropped'))).toBe(
      false,
    );
    expect(Value.Check(CostSummaryResponseSchema, { ...base, partialSessions: -1 })).toBe(false);
  });
});
