/**
 * Pure layered layout tests (WP-U7/U8): deterministic placement of the
 * persisted graph, honest reporting of dropped edges and cycles.
 */
import { describe, expect, it } from 'vitest';
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
