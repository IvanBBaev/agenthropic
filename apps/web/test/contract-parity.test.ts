/**
 * QA-11 + ARC-10: the web <-> server contract, checked at runtime.
 *
 * `src/dto.ts` is an erased `import type` bridge and `src/dto-guards.ts`
 * hand-mirrors the shared TypeBox schemas, both on purpose: the browser bundle
 * carries no validator library. The price is that nothing at runtime tied the
 * three shapes together - the server's schemas, the guards, and the fixture
 * builders every view test is written against. TypeBox is a devDependency
 * here, so these checks cost the bundle nothing.
 *
 * Three claims, each against the real `@agenthropic/shared` schemas:
 *   1. every fixture builder produces a schema-valid DTO, so view tests cannot
 *      drift onto a shape the server is not allowed to send;
 *   2. the payloads the server actually sent in the P0 proof (recorded by
 *      `apps/server/test/p0/p0-five-daily-questions.test.ts` as file
 *      snapshots) are schema-valid and pass the guards;
 *   3. the guards are never STRICTER than the contract. They are deliberately
 *      looser (rule 1 "shape, not sanity" and rule 2 "defer to a renderer that
 *      is already honest", see dto-guards.ts), so equality is not the claim.
 *      The claim is the direction that turns into a blackout when it breaks:
 *      a payload the guard refuses must be one the schema refuses too. Every
 *      single-leaf mutation of every guarded payload is checked for it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  AgentDelegationSavingsSchema,
  AgentNodeSchema,
  AggregateDelegationSavingsSchema,
  ChangedSessionSchema,
  ChangesResponseSchema,
  CompactionSegmentSchema,
  CostAnalysisSchema,
  CostSummaryResponseSchema,
  GlobalDagResponseSchema,
  OrchestrationEdgeDtoSchema,
  SessionCostSchema,
  SessionListResponseSchema,
  SessionOutcomeCauseCountsSchema,
  SessionPartialSchema,
  SessionStatusCountsSchema,
  SessionSummarySchema,
  SessionTreeResponseSchema,
} from '../../../packages/shared/src/index';
import {
  isAggregateSavings,
  isChanges,
  isCostAnalysis,
  isCostSummary,
  isGlobalDag,
  isSessionList,
  isSessionTree,
} from '../src/dto-guards';
import * as fixtures from './fixtures';

type Guard = (body: Record<string, unknown>) => boolean;

/** Schema violations as readable `path: message` lines; `[]` means valid. */
function schemaErrors(schema: TSchema, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((error) => `${error.path}: ${error.message}`);
}

// --- 1. fixture builders -----------------------------------------------------

/**
 * Every DTO builder exported by `fixtures.ts`, with the schema it stands in
 * for and the samples worth checking: the default call, plus a populated one
 * wherever the default leaves a nested array empty (an empty array checks
 * nothing about its element shape).
 */
const BUILDERS: ReadonlyArray<{
  readonly name: keyof typeof fixtures;
  readonly schema: TSchema;
  readonly samples: () => readonly unknown[];
}> = [
  {
    name: 'statusCounts',
    schema: SessionStatusCountsSchema,
    samples: () => [fixtures.statusCounts()],
  },
  {
    name: 'outcomeCauseCounts',
    schema: SessionOutcomeCauseCountsSchema,
    samples: () => [fixtures.outcomeCauseCounts()],
  },
  {
    name: 'sessionSummary',
    schema: SessionSummarySchema,
    samples: () => [
      fixtures.sessionSummary(),
      fixtures.sessionSummary({ partial: fixtures.OVERSIZE_PARTIAL, usageRecordsDropped: 2 }),
    ],
  },
  {
    name: 'sessionList',
    schema: SessionListResponseSchema,
    samples: () => [fixtures.sessionList(), fixtures.sessionList([fixtures.sessionSummary()])],
  },
  { name: 'agentNode', schema: AgentNodeSchema, samples: () => [fixtures.agentNode()] },
  {
    name: 'orchestrationEdge',
    schema: OrchestrationEdgeDtoSchema,
    samples: () => [fixtures.orchestrationEdge()],
  },
  {
    name: 'sessionTree',
    schema: SessionTreeResponseSchema,
    samples: () => [fixtures.sessionTree()],
  },
  {
    name: 'globalDag',
    schema: GlobalDagResponseSchema,
    samples: () => [
      fixtures.globalDag(),
      fixtures.globalDag({
        nodes: [fixtures.agentNode()],
        edges: [fixtures.orchestrationEdge()],
        counts: { totalSessions: 1 },
      }),
    ],
  },
  {
    name: 'costSummary',
    schema: CostSummaryResponseSchema,
    samples: () => [
      fixtures.costSummary(),
      fixtures.costSummary({ topSessions: [fixtures.sessionCost()] }),
    ],
  },
  {
    name: 'sessionCost',
    schema: SessionCostSchema,
    samples: () => [
      fixtures.sessionCost(),
      fixtures.sessionCost({ partial: fixtures.OVERSIZE_PARTIAL }),
    ],
  },
  {
    name: 'OVERSIZE_PARTIAL',
    schema: SessionPartialSchema,
    samples: () => [fixtures.OVERSIZE_PARTIAL],
  },
  {
    name: 'aggregateSavings',
    schema: AggregateDelegationSavingsSchema,
    samples: () => [fixtures.aggregateSavings()],
  },
  {
    name: 'costAnalysis',
    schema: CostAnalysisSchema,
    samples: () => [
      fixtures.costAnalysis(),
      fixtures.costAnalysis({
        compaction: {
          naiveUsd: 0.5,
          repricedUsd: 0.5,
          deltaUsd: 0,
          compactionCount: 0,
          segments: [fixtures.compactionSegment()],
        },
        delegationSavings: {
          actualUsd: 0.2,
          hypotheticalUsd: 0.9,
          savingsUsd: 0.7,
          perAgent: [fixtures.agentSavings()],
          skippedAgentIds: [],
          isEstimate: true,
        },
      }),
    ],
  },
  {
    name: 'compactionSegment',
    schema: CompactionSegmentSchema,
    samples: () => [fixtures.compactionSegment()],
  },
  {
    name: 'agentSavings',
    schema: AgentDelegationSavingsSchema,
    samples: () => [fixtures.agentSavings()],
  },
  {
    name: 'outcomeCauseAgents',
    schema: AgentNodeSchema,
    samples: () => fixtures.outcomeCauseAgents(),
  },
  {
    name: 'changedSession',
    schema: ChangedSessionSchema,
    samples: () => [fixtures.changedSession()],
  },
  { name: 'changes', schema: ChangesResponseSchema, samples: () => [fixtures.changes()] },
];

/** Exports of `fixtures.ts` that are test plumbing, not DTOs. */
const NOT_A_DTO = new Set(['jsonResponse', 'textResponse', 'deferred']);

describe('web fixture builders match the shared schemas (QA-11)', () => {
  it('covers every DTO builder fixtures.ts exports, so a new one cannot skip the check', () => {
    const exported = Object.keys(fixtures).filter((name) => !NOT_A_DTO.has(name));
    expect(BUILDERS.map((builder) => builder.name).sort()).toEqual(exported.sort());
  });

  it.each(BUILDERS)('$name builds a schema-valid DTO', ({ schema, samples }) => {
    for (const sample of samples()) {
      expect(schemaErrors(schema, sample)).toEqual([]);
    }
  });
});

// --- 2. recorded P0 payloads -------------------------------------------------

/** Every route `api.ts` guards: its recording, its schema and its guard. */
const GUARDED_ROUTES: ReadonlyArray<{
  readonly recording: string;
  readonly schema: TSchema;
  readonly guard: Guard;
}> = [
  { recording: 'sessions', schema: SessionListResponseSchema, guard: isSessionList },
  { recording: 'session-tree', schema: SessionTreeResponseSchema, guard: isSessionTree },
  { recording: 'session-cost-analysis', schema: CostAnalysisSchema, guard: isCostAnalysis },
  { recording: 'cost-summary', schema: CostSummaryResponseSchema, guard: isCostSummary },
  {
    recording: 'delegation-savings',
    schema: AggregateDelegationSavingsSchema,
    guard: isAggregateSavings,
  },
  { recording: 'dag-global', schema: GlobalDagResponseSchema, guard: isGlobalDag },
  { recording: 'changes', schema: ChangesResponseSchema, guard: isChanges },
];

function readRecording(name: string): Record<string, unknown> {
  // Resolved from the package root, as honesty.test.tsx does: under jsdom
  // `import.meta.url` is not a file URL.
  const file = resolve(process.cwd(), 'test', 'recorded', `p0-${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('recorded P0 server payloads pass the schemas and the web guards (QA-11)', () => {
  it.each(GUARDED_ROUTES)('$recording', ({ recording, schema, guard }) => {
    const body = readRecording(recording);
    expect(schemaErrors(schema, body)).toEqual([]);
    expect(guard(body)).toBe(true);
  });

  it('records a corpus that is not empty, so the checks above are not vacuous', () => {
    expect((readRecording('sessions')['sessions'] as unknown[]).length).toBeGreaterThan(0);
    expect((readRecording('dag-global')['nodes'] as unknown[]).length).toBeGreaterThan(0);
    expect((readRecording('session-tree')['agents'] as unknown[]).length).toBeGreaterThan(0);
  });
});

// --- 3. the guards are never stricter than the contract ------------------------

type Path = readonly (string | number)[];

/**
 * Every path to a property in `value`. For arrays only the first element is
 * walked: guards check elements uniformly, so one element per array covers
 * every rule without multiplying the run by the corpus size.
 */
function propertyPaths(value: unknown, prefix: Path = []): Path[] {
  if (Array.isArray(value)) {
    return value.length > 0 ? [[...prefix, 0], ...propertyPaths(value[0], [...prefix, 0])] : [];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [
      [...prefix, key],
      ...propertyPaths(child, [...prefix, key]),
    ]);
  }
  return [];
}

type Mutation = 'deleted' | 'null' | 'string' | 'number';

/** A deep copy of `body` with the property at `path` removed or replaced. */
function mutate(
  body: Record<string, unknown>,
  path: Path,
  kind: Mutation,
): Record<string, unknown> {
  const copy = structuredClone(body);
  let parent: Record<string | number, unknown> = copy;
  for (const step of path.slice(0, -1)) {
    parent = parent[step] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1] as string | number;
  if (kind === 'deleted') {
    if (Array.isArray(parent)) parent.splice(last as number, 1);
    else delete parent[last];
  } else {
    parent[last] = { null: null, string: 'not-the-contract', number: 7 }[kind];
  }
  return copy;
}

/** Fixture payloads for the guarded routes, alongside the recordings. */
const FIXTURE_PAYLOADS: ReadonlyArray<{ readonly label: string; readonly body: unknown }> = [
  { label: 'fixture sessionList', body: fixtures.sessionList([fixtures.sessionSummary()]) },
  { label: 'fixture sessionTree', body: fixtures.sessionTree() },
  {
    label: 'fixture costAnalysis',
    body: BUILDERS.find((builder) => builder.name === 'costAnalysis')?.samples()[1],
  },
  {
    label: 'fixture costSummary',
    body: fixtures.costSummary({ topSessions: [fixtures.sessionCost()] }),
  },
  { label: 'fixture aggregateSavings', body: fixtures.aggregateSavings() },
  {
    label: 'fixture globalDag',
    body: fixtures.globalDag({
      nodes: [fixtures.agentNode()],
      edges: [fixtures.orchestrationEdge()],
    }),
  },
  { label: 'fixture changes', body: fixtures.changes() },
];

describe('the web guards are never stricter than the shared schemas (ARC-10)', () => {
  const cases = GUARDED_ROUTES.flatMap((route, index) => [
    { label: `recorded ${route.recording}`, body: readRecording(route.recording), ...route },
    { ...FIXTURE_PAYLOADS[index]!, schema: route.schema, guard: route.guard },
  ]);

  it.each(cases)(
    '$label: no mutation the schema accepts is refused by the guard',
    ({ body, schema, guard }) => {
      const payload = body as Record<string, unknown>;
      expect(guard(payload)).toBe(true);
      const tooStrict: string[] = [];
      let refusedByGuard = 0;
      for (const path of propertyPaths(payload)) {
        for (const kind of ['deleted', 'null', 'string', 'number'] as const) {
          const mutated = mutate(payload, path, kind);
          if (guard(mutated)) continue;
          refusedByGuard += 1;
          if (Value.Check(schema, mutated)) tooStrict.push(`${path.join('.')} ${kind}`);
        }
      }
      expect(tooStrict).toEqual([]);
      // Anti-vacuity: the guard really does refuse damaged payloads here.
      expect(refusedByGuard).toBeGreaterThan(0);
    },
  );
});
