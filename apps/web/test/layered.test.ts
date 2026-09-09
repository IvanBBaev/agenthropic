/**
 * Pure layered layout tests (WP-U7/U8): deterministic placement of the
 * persisted graph, honest reporting of dropped edges and cycles.
 */
import { describe, expect, it } from 'vitest';
import type { AgentNodeDto, OrchestrationEdgeDto } from '../src/dto';
import { describeAgentGraph } from '../src/views/chart-summary';
import { computeLayeredLayout, type LayoutEdge } from '../src/views/layout/layered';

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
    expect(text).not.toContain('4,000 tokens carry no price');
  });
});
