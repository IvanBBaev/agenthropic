/**
 * Pure layered layout tests (WP-U7/U8): deterministic placement of the
 * persisted graph, honest reporting of dropped edges and cycles.
 */
import { describe, expect, it } from 'vitest';
import type { AgentNodeDto, OrchestrationEdgeDto, OrchestrationEdgeSource } from '../src/dto';
import { describeAgentGraph } from '../src/views/chart-summary';
import {
  computeLayeredLayout,
  fallbackLayerNotice,
  type LayoutEdge,
} from '../src/views/layout/layered';

interface Node {
  readonly id: string;
}

function nodes(...ids: string[]): Node[] {
  return ids.map((id) => ({ id }));
}

function edge(parentId: string, childId: string): LayoutEdge<string> {
  return { parentId, childId, payload: `${parentId}->${childId}` };
}

describe('computeLayeredLayout', () => {
  it('returns an empty layout for no nodes and counts all edges as dropped', () => {
    const layout = computeLayeredLayout([], [edge('a', 'b')]);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.droppedEdges).toBe(1);
    expect(layout.belowCycleNodes).toBe(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  it('layers by longest path from the root', () => {
    // a -> b -> c and a -> c: c must sit on layer 2, not 1.
    const layout = computeLayeredLayout(nodes('a', 'b', 'c'), [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('a', 'c'),
    ]);
    const depthOf = new Map(layout.nodes.map((placed) => [placed.node.id, placed.depth]));
    expect(depthOf.get('a')).toBe(0);
    expect(depthOf.get('b')).toBe(1);
    expect(depthOf.get('c')).toBe(2);
    expect(layout.droppedEdges).toBe(0);
    expect(layout.cyclicNodes).toBe(0);
  });

  it('is deterministic and clusters children under their parent', () => {
    const graph = nodes('r1', 'r2', 'c1', 'c2');
    const edges = [edge('r2', 'c1'), edge('r1', 'c2')];
    const first = computeLayeredLayout(graph, edges);
    const second = computeLayeredLayout(graph, edges);
    expect(second).toEqual(first);

    const positionOf = new Map(first.nodes.map((placed) => [placed.node.id, placed.x]));
    // r1 sits left of r2 (input order); barycenter puts c2 under r1, c1 under r2.
    expect(positionOf.get('r1')!).toBeLessThan(positionOf.get('r2')!);
    expect(positionOf.get('c2')!).toBeLessThan(positionOf.get('c1')!);
  });

  it('connects placed edges to their endpoint coordinates and carries payloads', () => {
    const layout = computeLayeredLayout(nodes('a', 'b'), [edge('a', 'b')]);
    const [a, b] = layout.nodes;
    const placed = layout.edges[0]!;
    expect(placed.payload).toBe('a->b');
    expect(placed.x1).toBe(a!.x);
    expect(placed.y1).toBe(a!.y);
    expect(placed.x2).toBe(b!.x);
    expect(placed.y2).toBe(b!.y);
  });

  it('drops (and counts) edges whose endpoints are missing from the payload', () => {
    const layout = computeLayeredLayout(nodes('a'), [edge('a', 'ghost'), edge('ghost', 'a')]);
    expect(layout.edges).toHaveLength(0);
    expect(layout.droppedEdges).toBe(2);
    expect(layout.nodes).toHaveLength(1);
  });

  it('parks cycle members on a fallback layer instead of hanging', () => {
    const layout = computeLayeredLayout(nodes('root', 'x', 'y'), [
      edge('root', 'x'),
      edge('x', 'y'),
      edge('y', 'x'),
    ]);
    expect(layout.cyclicNodes).toBe(2);
    const depthOf = new Map(layout.nodes.map((placed) => [placed.node.id, placed.depth]));
    expect(depthOf.get('root')).toBe(0);
    expect(depthOf.get('x')).toBe(1);
    expect(depthOf.get('y')).toBe(1);
    // Every node still gets coordinates.
    expect(layout.nodes).toHaveLength(3);
  });

  it('KK1: counts only true cycle members, not the nodes hanging below a cycle', () => {
    // a <-> b is the cycle; c and d are reachable only through it.
    const layout = computeLayeredLayout(nodes('a', 'b', 'c', 'd'), [
      edge('a', 'b'),
      edge('b', 'a'),
      edge('b', 'c'),
      edge('c', 'd'),
    ]);
    expect(layout.cyclicNodes).toBe(2);
    expect(layout.belowCycleNodes).toBe(2);
    expect(layout.nodes).toHaveLength(4);
  });

  it('KK1: a self-loop is a cycle of one; its descendants are not', () => {
    const layout = computeLayeredLayout(nodes('root', 'x', 'y'), [
      edge('root', 'x'),
      edge('x', 'x'),
      edge('x', 'y'),
    ]);
    expect(layout.cyclicNodes).toBe(1);
    expect(layout.belowCycleNodes).toBe(1);
  });

  it('KK1: a pure two-cycle is two members and nothing below', () => {
    const layout = computeLayeredLayout(nodes('a', 'b'), [edge('a', 'b'), edge('b', 'a')]);
    expect(layout.cyclicNodes).toBe(2);
    expect(layout.belowCycleNodes).toBe(0);
    // No ranked node exists, so the fallback layer is layer 0.
    expect(layout.nodes.map((placed) => placed.depth)).toEqual([0, 0]);
  });

  it('KK1: a node reached from two cycle members is below the cycle, counted once', () => {
    // c is reached from both a and b (a cross edge into a finished component).
    const layout = computeLayeredLayout(nodes('a', 'b', 'c'), [
      edge('a', 'b'),
      edge('b', 'a'),
      edge('b', 'c'),
      edge('a', 'c'),
    ]);
    expect(layout.cyclicNodes).toBe(2);
    expect(layout.belowCycleNodes).toBe(1);
  });

  it('KK1: reports no cycle and nothing below one for an acyclic graph', () => {
    const layout = computeLayeredLayout(nodes('a', 'b', 'c'), [edge('a', 'b'), edge('b', 'c')]);
    expect(layout.cyclicNodes).toBe(0);
    expect(layout.belowCycleNodes).toBe(0);
  });

  it('KK1: the notice states both numbers truthfully', () => {
    expect(fallbackLayerNotice(1, 0)).toBe(
      '1 agent sit in a cycle and are placed on a fallback layer.',
    );
    expect(fallbackLayerNotice(2, 0)).toBe(
      '2 agents sit in a cycle and are placed on a fallback layer.',
    );
    expect(fallbackLayerNotice(2, 1)).toBe(
      '2 agents sit in a cycle and are placed on a fallback layer; 1 more agent below the cycle is not in it but shares that layer.',
    );
    expect(fallbackLayerNotice(1, 2)).toBe(
      '1 agent sit in a cycle and are placed on a fallback layer; 2 more agents below the cycle are not in it but share that layer.',
    );
  });

  it('honors spacing options in the reported extent', () => {
    const layout = computeLayeredLayout(nodes('a', 'b', 'c'), [edge('a', 'b'), edge('a', 'c')], {
      gapX: 100,
      gapY: 50,
      marginX: 10,
      marginY: 5,
    });
    // Widest layer has 2 nodes -> width 10*2 + 100; depth max 1 -> height 5*2 + 50.
    expect(layout.width).toBe(120);
    expect(layout.height).toBe(60);
  });
});

/**
 * ADDED 2026-09-07 (CS-1, CS-2). `describeAgentGraph` is the screen-reader half
 * of the picture `computeLayeredLayout` draws, so its census is tested here,
 * against that layout's own drop rule, rather than in isolation - the two must
 * agree about what the reader is actually being shown.
 *
 * Local fixtures on purpose: `test/fixtures.ts` is shared with the view tests
 * and these cases need field values (a non-finite unpriced count) that no view
 * fixture should default to.
 */
function agent(overrides: Partial<AgentNodeDto> = {}): AgentNodeDto {
  return {
    id: 'agent-main',
    sessionId: 'session-1',
    type: 'main',
    subagentType: null,
    status: 'working',
    outcomeCause: null,
    parentAgentId: null,
    firstSeenAt: '2026-09-07T10:00:00.000Z',
    lastSeenAt: '2026-09-07T10:05:00.000Z',
    totalTokens: 800,
    costUsd: 0.3,
    unpricedTokens: 0,
    ...overrides,
  };
}

function graphEdge(overrides: Partial<OrchestrationEdgeDto> = {}): OrchestrationEdgeDto {
  return {
    id: 1,
    sessionId: 'session-1',
    parentAgentId: 'agent-main',
    childAgentId: 'agent-child',
    source: 'tool_use',
    instance: 'default',
    hostId: 'host-1',
    createdAt: '2026-09-07T10:01:00.000Z',
    ...overrides,
  };
}

describe('describeAgentGraph', () => {
  it('does not count edges the layout cannot draw as part of the picture', () => {
    const agents = [agent({ id: 'a' }), agent({ id: 'b' })];
    const edges = [
      graphEdge({ id: 1, parentAgentId: 'a', childAgentId: 'b' }),
      graphEdge({ id: 2, parentAgentId: 'a', childAgentId: 'ghost', source: 'directory' }),
      graphEdge({ id: 3, parentAgentId: 'ghost', childAgentId: 'b', source: 'directory' }),
    ];
    // The geometry these words describe drops both ghost-ended edges.
    const layout = computeLayeredLayout(
      agents,
      edges.map((e) => ({ parentId: e.parentAgentId, childId: e.childAgentId, payload: e })),
    );
    expect(layout.edges).toHaveLength(1);
    expect(layout.droppedEdges).toBe(2);

    const text = describeAgentGraph(agents, edges);
    expect(text).toContain('Edges: 1 observed (tool_use), 2 inferred (directory).');
    expect(text).toContain('Not drawn: 2 edges pointing at an agent that is not in this picture.');

    // Singular reads as singular; one undrawn edge is still worth one sentence.
    const one = describeAgentGraph(agents, [edges[1]!]);
    expect(one).toContain('Not drawn: 1 edge pointing at an agent that is not in this picture.');
  });

  it('says nothing about undrawn edges when every edge is drawn', () => {
    const agents = [agent({ id: 'a' }), agent({ id: 'b' })];
    const text = describeAgentGraph(agents, [graphEdge({ parentAgentId: 'a', childAgentId: 'b' })]);
    expect(text).toContain('Edges: 1 observed (tool_use), 0 inferred.');
    expect(text).not.toContain('not in this picture');
  });

  it('states an unreadable unpriced total instead of dropping the caveat', () => {
    const readable = describeAgentGraph([agent({ id: 'a', unpricedTokens: 4000 })], []);
    expect(readable).toContain('4,000 tokens carry no price');

    // A NaN in the sum poisons it, and `> 0` is false for NaN - so before this
    // the string was indistinguishable from a graph where everything is priced.
    const agents = [
      agent({ id: 'a', unpricedTokens: 4000 }),
      agent({ id: 'b', unpricedTokens: Number.NaN }),
    ];
    const text = describeAgentGraph(agents, []);
    expect(text).toContain('tokens unreadable');
    // KK5: the readable 4,000 is no longer poisoned away by the NaN beside it;
    // it is stated as a floor, next to the agent whose count cannot be read.
    expect(text).toContain(
      ' At least 4,000 tokens carry no price and are excluded from every dollar figure. 1 agent reported an unpriced-token count that cannot be right (tokens unreadable), so how much of this graph is excluded from every dollar figure is unknown.',
    );
  });

  it('KK5: discloses a negative per-agent unpriced count instead of swallowing it', () => {
    const text = describeAgentGraph([agent({ id: 'a', unpricedTokens: -50 })], []);
    expect(text).toContain(
      ' 1 agent reported an unpriced-token count that cannot be right (-50), so how much of this graph is excluded from every dollar figure is unknown.',
    );
    expect(text).not.toContain('carry no price');
  });

  it('KK5: counts that cancel in a sum are still disclosed per agent', () => {
    const text = describeAgentGraph(
      [
        agent({ id: 'a', unpricedTokens: 100 }),
        agent({ id: 'b', unpricedTokens: -100 }),
        agent({ id: 'c', unpricedTokens: Number.POSITIVE_INFINITY }),
      ],
      [],
    );
    expect(text).toContain(' At least 100 tokens carry no price');
    expect(text).toContain(
      '2 agents reported an unpriced-token count that cannot be right (-100, tokens unreadable)',
    );
  });

  it('KK5: a fully priced graph still says nothing about unpriced tokens', () => {
    const text = describeAgentGraph([agent({ id: 'a', unpricedTokens: 0 })], []);
    expect(text).not.toContain('unpriced');
    expect(text).not.toContain('carry no price');
  });

  /**
   * ADDED 2026-09-23 (lane-EP). The census used to be two-way: every edge whose
   * source was not `tool_use` was counted as `inferred`, on the sole evidence
   * that the word was not the observed one. `inferred` is a positive claim that
   * the server DERIVED the link, so a source word this build has not learned
   * had the paragraph asserting a derivation nobody performed - and if the new
   * word is in fact a second OBSERVATION, the same sentence understates the
   * graph. Either way the claim originates in the client, which is the one
   * thing a provenance channel exists to prevent. The third bucket is asked of
   * `edgeProvenance`, the same function the two charts stroke from, so the
   * paragraph and the picture cannot answer differently about one edge.
   */
  it('counts an unreadable source word as unrecognised rather than as inferred', () => {
    const agents = [agent({ id: 'a' }), agent({ id: 'b' })];
    const edges = [
      graphEdge({ id: 1, parentAgentId: 'a', childAgentId: 'b' }),
      graphEdge({ id: 2, parentAgentId: 'a', childAgentId: 'b', source: 'directory' }),
      graphEdge({
        id: 3,
        parentAgentId: 'a',
        childAgentId: 'b',
        source: 'mcp_spawn' as OrchestrationEdgeSource,
      }),
    ];

    const text = describeAgentGraph(agents, edges);
    expect(text).toContain(
      'Edges: 1 observed (tool_use), 1 inferred (directory), 1 unrecognised ("mcp_spawn").',
    );
    // The word this build cannot read is never folded into the derived count.
    expect(text).not.toContain('2 inferred');

    // A blank source is the same finding wearing a different value, and it is
    // quoted for the same reason `unrecognisedStatusMeta` quotes: `unrecognised
    // ()` promises a value and exhibits none, which reads as a rendering fault.
    const blank = describeAgentGraph(agents, [
      graphEdge({ parentAgentId: 'a', childAgentId: 'b', source: '' as OrchestrationEdgeSource }),
    ]);
    expect(blank).toContain('0 inferred, 1 unrecognised ("").');
  });

  /**
   * ADDED 2026-09-23 (SA-Z4). `totalEdges` is a COUNT over the whole table
   * while `edges` carries only the edges whose endpoints are among the returned
   * agents, and the table has no foreign key to agents - so an edge naming an
   * agent id with no stored row is counted forever and returned never. That gap
   * is invisible from inside `edges`, which is why the caller passes it in: no
   * inspection of the served list can see an edge that is not in the served
   * list. It is stated beside `Not drawn` and kept distinct from it, because the
   * two are different gaps and a reader given one number twice would be told
   * less, not more.
   */
  it('states edges the read counted but never returned, without naming a cause', () => {
    const agents = [agent({ id: 'a' }), agent({ id: 'b' })];
    const edges = [graphEdge({ parentAgentId: 'a', childAgentId: 'b' })];

    const text = describeAgentGraph(agents, edges, {
      unreturnedEdges: { returnedEdges: 1, totalEdges: 3 },
    });
    expect(text).toContain(
      'Not returned: 2 of the 3 edges this same read counts were not in the answer, so they are' +
        ' neither drawn nor described here.',
    );

    // Omitting the context is not the same as passing an agreeing pair: a
    // caller that cannot see both numbers must produce no clause at all.
    expect(describeAgentGraph(agents, edges)).not.toContain('Not returned:');
  });

  /**
   * RR1 (2026-09-26). The clause subtracted the two counts raw, so a read that
   * returned MORE edges than it counted said "-1 of the 2 edges ... were not in
   * the answer". That direction is a disagreement too, and it is stated as one -
   * without the subtraction and without the claim that anything is missing.
   */
  it('states edges returned in excess of the count as a disagreement, not a negative gap', () => {
    const agents = [agent({ id: 'a' }), agent({ id: 'b' })];
    const edges = [graphEdge({ parentAgentId: 'a', childAgentId: 'b' })];

    const text = describeAgentGraph(agents, edges, {
      unreturnedEdges: { returnedEdges: 3, totalEdges: 2 },
    });
    expect(text).toContain(
      'The answer carried 3 edges while the same read counts only 2 - the two disagree, and' +
        ' this page cannot say which is right.',
    );
    expect(text).not.toContain('Not returned:');
    expect(text).not.toContain('-1');
  });
});
