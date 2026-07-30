/**
 * WP-X4 negative-test catalogue — the PURE core scenarios.
 *
 * Catalogue of record: docs/site/contributing/testing.md section 5 / 5.1.
 * This file implements the parser/cost facets:
 *
 *   #3  missing parent id      -> orphan, never a fabricated root
 *   #4  malformed JSON (JSONL facet) -> loud SubstrateError, never silent
 *   #8  unknown model pricing  -> PricingError halt, never silent $0
 *   #11 compaction mid-session -> tree survives via task_notification re-anchor
 *   #12 PreCompact re-pricing  -> baseline preserved, deltaUsd ~ 0
 *
 * The HTTP/persistence facets of #3/#4/#8 live in apps/server/test/negative/.
 */
import { describe, expect, it } from 'vitest';
import {
  computeCompactionAwareCost,
  computeCostUsd,
  extractCompactionBoundaries,
  parseSession,
  PricingError,
  SubstrateError,
  type CompactionBoundary,
  type DedupedUsage,
  type PricingEntry,
  type SessionSubstrate,
} from '../../src/index';
import { EVICTED_TOOL_USE_ID, getFixture } from '@agenthropic/test-fixtures';

// --- helpers ----------------------------------------------------------------

function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

/** Flat $1/MTok for every bucket of the synthetic fixture model. */
const PRICING: PricingEntry[] = BUCKETS.map((bucket) => ({
  model: 'synthetic-model-a',
  bucket,
  usdPerMtok: 1,
  effectiveFrom: '2020-01-01T00:00:00.000Z',
}));

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

function usageRow(overrides: Partial<DedupedUsage> = {}): DedupedUsage {
  return {
    messageId: 'msg_neg_core_0001',
    model: 'synthetic-model-a',
    timestamp: '2026-01-15T10:00:05.000Z',
    usage: { ...ZERO },
    agentId: null,
    ...overrides,
  };
}

// --- Scenario #3 — missing parent id ----------------------------------------
// Catalogue: "orphan/pending reparent; no fake root". Maps to CD-4
// (self-referential parent_agent_id), WP-D6 (orphan-safe self-FK) and
// NFR-DATA-01 (the tree is a data fact, never a UI guess).

describe('Scenario #3 — missing parent id => orphan, no fabricated root (CD-4, WP-D6, NFR-DATA-01)', () => {
  const SESSION = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  const HEX = 'abcdef01';

  // A legacy-style child with NO sidecar, NO parent-side tool_use, NO
  // queue_operation and NO <task-notification>: every join path misses.
  const substrate: SessionSubstrate = {
    files: [
      {
        relativePath: `${SESSION}.jsonl`,
        lines: [
          jline({
            parentUuid: null,
            isSidechain: false,
            sessionId: SESSION,
            type: 'user',
            message: {
              role: 'user',
              content: 'Synthetic prompt; deliberately no Agent tool_use anywhere.',
            },
            uuid: 'cccccccc-0000-4000-8000-000000000001',
            timestamp: '2026-03-01T09:00:00.000Z',
          }),
        ],
      },
      {
        relativePath: `subagents/agent-${HEX}.jsonl`,
        lines: [
          jline({
            parentUuid: null,
            isSidechain: true,
            sessionId: SESSION,
            agentId: HEX,
            type: 'user',
            message: {
              role: 'user',
              content: 'Synthetic orphan subagent task with no structural anchor.',
            },
            uuid: 'cccccccc-0000-4000-8000-000000000002',
            timestamp: '2026-03-01T09:00:02.000Z',
          }),
          jline({
            parentUuid: 'cccccccc-0000-4000-8000-000000000002',
            isSidechain: true,
            sessionId: SESSION,
            agentId: HEX,
            type: 'assistant',
            message: {
              id: 'msg_neg_orphan_child_0001',
              type: 'message',
              role: 'assistant',
              model: 'synthetic-model-a',
              content: [{ type: 'text', text: 'Synthetic orphan output.' }],
              usage: {
                input_tokens: 10,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 5,
              },
            },
            uuid: 'cccccccc-0000-4000-8000-000000000003',
            timestamp: '2026-03-01T09:00:04.000Z',
          }),
        ],
      },
    ],
  };
  const result = parseSession(substrate);

  it('keeps the agent visible with parentAgentId null — never a fabricated parent', () => {
    const child = result.agents.find((agent) => agent.id === HEX);
    expect(child).toBeDefined();
    expect(child?.type).toBe('subagent');
    expect(child?.parentAgentId).toBeNull();
    // Explicitly NOT re-parented onto the main agent as a fake root.
    expect(child?.parentAgentId).not.toBe(SESSION);
  });

  it('emits NO orchestration edge for the orphan (no fake edge either)', () => {
    expect(result.edges).toEqual([]);
  });

  it('still attributes the orphan usage honestly (token counts never vanish)', () => {
    const usage = result.usage.find((u) => u.messageId === 'msg_neg_orphan_child_0001');
    expect(usage?.agentId).toBe(HEX);
    expect(usage?.usage.input).toBe(10);
    expect(usage?.usage.output).toBe(5);
  });
});

// --- Scenario #4 — malformed JSON (JSONL substrate facet) -------------------
// Catalogue: malformed input is rejected loudly, never silently swallowed
// (CD-2, FR-01). The HTTP 400 facet lives in hook-receiver.negative.test.ts;
// here a poisoned JSONL line must abort THIS session's parse with a
// SubstrateError naming file and line — the corpus runner then isolates the
// failure per-session (proved in ingest-restart.negative.test.ts).

describe('Scenario #4 — malformed JSONL line fails loudly with file:line (CD-2, FR-01)', () => {
  const SESSION = '88888888-9999-4aaa-8bbb-cccccccccccc';

  it('throws SubstrateError citing the exact file and line number', () => {
    const substrate: SessionSubstrate = {
      files: [
        {
          relativePath: `${SESSION}.jsonl`,
          lines: [
            jline({
              parentUuid: null,
              sessionId: SESSION,
              type: 'user',
              message: { role: 'user', content: 'Synthetic healthy first line.' },
              uuid: 'dddddddd-0000-4000-8000-000000000001',
              timestamp: '2026-03-02T08:00:00.000Z',
            }),
            '{"type": "assistant", "sessionId":', // truncated write — not JSON
          ],
        },
      ],
    };
    expect(() => parseSession(substrate)).toThrowError(SubstrateError);
    expect(() => parseSession(substrate)).toThrowError(/:2: line is not valid JSON/);
    expect(() => parseSession(substrate)).toThrowError(new RegExp(`${SESSION}\\.jsonl`));
  });

  it('distinguishes malformed JSON from UNKNOWN record types, which are tolerated (CD-2)', () => {
    // The accept-and-store posture: a syntactically valid record of a type
    // the parser has never seen must NOT crash the session.
    const substrate: SessionSubstrate = {
      files: [
        {
          relativePath: `${SESSION}.jsonl`,
          lines: [
            jline({
              type: 'shiny_future_record_type',
              sessionId: SESSION,
              payload: { novel: true },
              uuid: 'dddddddd-0000-4000-8000-000000000002',
              timestamp: '2026-03-02T08:00:01.000Z',
            }),
            jline({
              parentUuid: null,
              sessionId: SESSION,
              type: 'user',
              message: { role: 'user', content: 'Synthetic prompt after the unknown record.' },
              uuid: 'dddddddd-0000-4000-8000-000000000003',
              timestamp: '2026-03-02T08:00:02.000Z',
            }),
          ],
        },
      ],
    };
    const result = parseSession(substrate);
    expect(result.sessionId).toBe(SESSION);
    expect(result.agents.some((agent) => agent.id === SESSION)).toBe(true);
  });
});

// --- Scenario #8 — unknown model pricing (core facet) -----------------------
// Catalogue (hardened): "token counts shown; cost NOT silently zero" — the
// cost engine HALTS with PricingError instead of pricing at $0 (CD-3, CD-4,
// WP-C6). The ingest halt-before-write facet lives in
// ingest-restart.negative.test.ts.

describe('Scenario #8 — unknown model pricing halts, never silent $0 (CD-3, CD-4, WP-C6)', () => {
  it('unknown model id throws PricingError refusing to price at $0', () => {
    const rows = [usageRow({ model: 'unpriced-model-z', usage: { ...ZERO, input: 100 } })];
    expect(() => computeCostUsd(rows, PRICING)).toThrowError(PricingError);
    expect(() => computeCostUsd(rows, PRICING)).toThrowError(/refusing to price at \$0/);
    expect(() => computeCostUsd(rows, PRICING)).toThrowError(/unpriced-model-z/);
  });

  it('a missing bucket price for a known model also halts (no partial silent $0)', () => {
    const inputOnly: PricingEntry[] = [
      {
        model: 'synthetic-model-a',
        bucket: 'input',
        usdPerMtok: 1,
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      },
    ];
    const rows = [usageRow({ usage: { ...ZERO, input: 10, output: 50 } })];
    expect(() => computeCostUsd(rows, inputOnly)).toThrowError(PricingError);
    expect(() => computeCostUsd(rows, inputOnly)).toThrowError(/no price for bucket "output"/);
  });

  it('a price that is not yet effective at the usage timestamp halts too', () => {
    const future: PricingEntry[] = [
      {
        model: 'synthetic-model-a',
        bucket: 'input',
        usdPerMtok: 1,
        effectiveFrom: '2030-01-01T00:00:00.000Z',
      },
    ];
    const rows = [usageRow({ usage: { ...ZERO, input: 10 } })];
    expect(() => computeCostUsd(rows, future)).toThrowError(PricingError);
    expect(() => computeCostUsd(rows, future)).toThrowError(/no price effective at/);
  });

  it('zero-token buckets need no price row — no false halt on quiet buckets', () => {
    const inputOnly: PricingEntry[] = [
      {
        model: 'synthetic-model-a',
        bucket: 'input',
        usdPerMtok: 3,
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      },
    ];
    const rows = [usageRow({ usage: { ...ZERO, input: 100 } })];
    expect(computeCostUsd(rows, inputOnly)).toBeCloseTo((100 / 1_000_000) * 3, 12);
  });
});

// --- Scenario #11 — compaction mid-session ----------------------------------
// Project addition (concept-analysis-v2 section 6): a compact_boundary in the
// main transcript evicts the parent-side tool_use, yet the subagent tree AND
// the cost baseline must both survive. The task-notification-recovery fixture
// models exactly this legacy no-sidecar shape.

describe('Scenario #11 — compaction mid-session: tree and baseline survive (CD-4, WP-C4, parser-spec N1)', () => {
  const SESSION = '33333333-4444-4555-8666-777777777777';
  const HEX = 'c0ffee42';
  const fixture = getFixture('task-notification-recovery');
  const result = parseSession(fixture);

  it('re-anchors the child to the main agent via the <task-notification> tags', () => {
    const child = result.agents.find((agent) => agent.id === HEX);
    expect(child?.parentAgentId).toBe(SESSION);
  });

  it('the recovered edge is DISTINGUISHABLE from an observed tool_use edge', () => {
    const edge = result.edges.find((e) => e.childAgentId === HEX);
    expect(edge?.source).toBe('task_notification');
    expect(edge?.source).not.toBe('tool_use'); // inferred stays visibly inferred
    expect(edge?.toolUseId).toBe(EVICTED_TOOL_USE_ID);
  });

  it('usage recorded before the boundary is not lost', () => {
    const usage = result.usage.find((u) => u.messageId === 'msg_synth_recover_child_0001');
    expect(usage?.agentId).toBe(HEX);
    expect(usage?.usage).toEqual({
      input: 19,
      output: 64,
      cacheRead: 3100,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
  });

  it('extracts the compaction boundary with its preserved preTokens baseline', () => {
    const boundaries = extractCompactionBoundaries(fixture);
    expect(boundaries).toEqual([
      {
        agentId: null, // main transcript
        timestamp: '2026-01-17T14:00:00.000Z',
        trigger: 'auto',
        preTokens: 165000, // the PreCompact baseline, preserved verbatim
      },
    ]);
  });
});

// --- Scenario #12 — PreCompact re-pricing -----------------------------------
// Project addition (WP-C4): repricing the usage stream segment-by-segment
// around compaction boundaries must agree with the naive sum (deltaUsd ~ 0)
// while keeping the per-boundary baseline visible on each segment.

describe('Scenario #12 — PreCompact re-pricing preserves the baseline, deltaUsd ~ 0 (WP-C4, CD-3)', () => {
  it('fixture-derived usage reprices to the same total across the boundary', () => {
    const fixture = getFixture('task-notification-recovery');
    const parsed = parseSession(fixture);
    const boundaries = extractCompactionBoundaries(fixture);
    const report = computeCompactionAwareCost(parsed.usage, boundaries, PRICING);

    // (19 + 64 + 3100) tokens at $1/MTok across all buckets.
    expect(report.naiveUsd).toBeCloseTo(3183 / 1_000_000, 12);
    expect(report.repricedUsd).toBeCloseTo(report.naiveUsd, 12);
    expect(report.deltaUsd).toBeCloseTo(0, 12);
    expect(report.compactionCount).toBe(1);

    // Main transcript first: boundaryCount+1 = 2 (empty) segments, then the
    // child's single segment carrying the usage.
    expect(report.segments).toHaveLength(3);
    const [mainInitial, mainPost, childSegment] = report.segments;
    expect(mainInitial?.agentId).toBeNull();
    expect(mainInitial?.boundary).toBeNull();
    expect(mainPost?.boundary?.preTokens).toBe(165000); // baseline survives
    expect(mainPost?.messageCount).toBe(0);
    expect(childSegment?.agentId).toBe('c0ffee42');
    expect(childSegment?.messageCount).toBe(1);
    expect(childSegment?.usd).toBeCloseTo(3183 / 1_000_000, 12);
  });

  it('a row stamped exactly at the boundary belongs to the segment the boundary OPENS', () => {
    const boundary: CompactionBoundary = {
      agentId: null,
      timestamp: '2026-06-01T12:00:00.000Z',
      trigger: 'manual',
      preTokens: 90000,
    };
    const rows: DedupedUsage[] = [
      usageRow({
        messageId: 'msg_neg_seg_a',
        timestamp: '2026-06-01T11:00:00.000Z',
        usage: { ...ZERO, input: 100 },
      }),
      usageRow({
        messageId: 'msg_neg_seg_b',
        timestamp: '2026-06-01T12:00:00.000Z', // exactly the boundary instant
        usage: { ...ZERO, input: 200 },
      }),
    ];
    const report = computeCompactionAwareCost(rows, [boundary], PRICING);
    expect(report.segments).toHaveLength(2);
    expect(report.segments[0]?.messageCount).toBe(1);
    expect(report.segments[0]?.tokens.input).toBe(100);
    expect(report.segments[1]?.boundary).toEqual(boundary);
    expect(report.segments[1]?.messageCount).toBe(1);
    expect(report.segments[1]?.tokens.input).toBe(200);
    expect(report.deltaUsd).toBeCloseTo(0, 12);
  });

  it('PricingError still halts INSIDE the repricing path — never silent $0 (#8 x #12)', () => {
    const rows = [usageRow({ model: 'unpriced-model-z', usage: { ...ZERO, input: 5 } })];
    expect(() => computeCompactionAwareCost(rows, [], PRICING)).toThrowError(PricingError);
  });
});
