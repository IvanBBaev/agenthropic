/**
 * WP-C4/C5 cost-analysis DTO schemas. The load-bearing assertions are the
 * honesty rules: `isEstimate` is the literal `true` (a `false` estimate label
 * is a contract violation, not a value), and `additionalProperties: false`
 * everywhere so nothing undeclared can leak through the endpoint.
 */
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CostAnalysisSchema, type CostAnalysisDto } from '../src/index';

const validAnalysis: CostAnalysisDto = {
  compaction: {
    naiveUsd: 0.003183,
    repricedUsd: 0.003183,
    deltaUsd: 0,
    compactionCount: 1,
    segments: [
      {
        agentId: null,
        index: 0,
        boundary: null,
        usd: 0,
        messageCount: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      },
      {
        agentId: 'c0ffee42',
        index: 1,
        boundary: {
          agentId: 'c0ffee42',
          timestamp: '2026-01-17T14:00:00.000Z',
          trigger: 'auto',
          preTokens: 165000,
        },
        usd: 0.003183,
        messageCount: 1,
        tokens: { input: 19, output: 64, cacheRead: 3100, cacheWrite5m: 0, cacheWrite1h: 0 },
      },
    ],
  },
  delegationSavings: {
    actualUsd: 0.003183,
    hypotheticalUsd: 0.03183,
    savingsUsd: 0.028647,
    perAgent: [
      {
        agentId: 'c0ffee42',
        parentAgentId: null,
        actualUsd: 0.003183,
        hypotheticalUsd: 0.03183,
        savingsUsd: 0.028647,
        hypotheticalModel: 'synthetic-model-b',
        isEstimate: true,
      },
    ],
    skippedAgentIds: ['deadbeef'],
    isEstimate: true,
  },
};

/** Deep-clone + patch helper so each rejection case mutates a fresh copy. */
function withPatch(patch: (draft: typeof validAnalysis) => void): unknown {
  const draft = structuredClone(validAnalysis) as typeof validAnalysis;
  patch(draft);
  return draft;
}

describe('CostAnalysisSchema (WP-C4 + WP-C5 DTO)', () => {
  it('accepts a fully populated analysis', () => {
    expect(Value.Check(CostAnalysisSchema, validAnalysis)).toBe(true);
  });

  it('rejects isEstimate: false - the estimate label is a literal true', () => {
    expect(
      Value.Check(
        CostAnalysisSchema,
        withPatch((draft) => {
          (draft.delegationSavings as { isEstimate: boolean }).isEstimate = false;
        }),
      ),
    ).toBe(false);
    expect(
      Value.Check(
        CostAnalysisSchema,
        withPatch((draft) => {
          (draft.delegationSavings.perAgent[0] as { isEstimate: boolean }).isEstimate = false;
        }),
      ),
    ).toBe(false);
  });

  it('rejects undeclared properties at every level', () => {
    expect(
      Value.Check(
        CostAnalysisSchema,
        withPatch((draft) => {
          (draft as Record<string, unknown>)['absolutePath'] = '/leak';
        }),
      ),
    ).toBe(false);
    expect(
      Value.Check(
        CostAnalysisSchema,
        withPatch((draft) => {
          (draft.compaction.segments[0] as unknown as Record<string, unknown>)['extra'] = 1;
        }),
      ),
    ).toBe(false);
  });

  it('rejects a negative dollar amount and a missing section', () => {
    expect(
      Value.Check(
        CostAnalysisSchema,
        withPatch((draft) => {
          draft.delegationSavings.actualUsd = -0.01;
        }),
      ),
    ).toBe(false);
    expect(Value.Check(CostAnalysisSchema, { compaction: validAnalysis.compaction })).toBe(false);
  });

  it('allows a negative deltaUsd - the reconciliation delta is signed', () => {
    expect(
      Value.Check(
        CostAnalysisSchema,
        withPatch((draft) => {
          draft.compaction.deltaUsd = -1e-15;
        }),
      ),
    ).toBe(true);
  });
});
