/**
 * Pure layered graph layout (WP-U7/U8) - deterministic, synchronous, no DOM.
 * Longest-path layering over the PERSISTED edges: the hierarchy is the data
 * fact served by the API, so this module only assigns coordinates - it never
 * invents or drops relationships. What it cannot place it reports honestly:
 * edges whose endpoints are missing from the payload are counted in
 * `droppedEdges` (and not drawn), and nodes trapped in a cycle are still
 * placed on a fallback layer and counted in `cyclicNodes` instead of hanging
 * the layout.
 */

export interface LayoutEdge<E> {
  readonly parentId: string;
  readonly childId: string;
  /** The domain edge, carried through untouched for the renderer. */
  readonly payload: E;
}

export interface PlacedNode<N> {
  readonly node: N;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
}

export interface PlacedEdge<E> {
  readonly payload: E;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface LayeredLayout<N, E> {
  readonly nodes: readonly PlacedNode<N>[];
  readonly edges: readonly PlacedEdge<E>[];
  /** Edges referencing a node id absent from the payload - reported, not drawn. */
  readonly droppedEdges: number;
  /** Nodes that sit in a cycle; placed on one fallback layer below the rest. */
  readonly cyclicNodes: number;
  readonly width: number;
  readonly height: number;
}

export interface LayeredOptions {
  readonly gapX?: number;
  readonly gapY?: number;
  readonly marginX?: number;
  readonly marginY?: number;
}

const DEFAULTS: Required<LayeredOptions> = { gapX: 130, gapY: 90, marginX: 70, marginY: 40 };

/**
 * Layer nodes by longest path from a root (Kahn order), then order each layer
 * by the mean x of already-placed parents (stable on ties by input order) so
 * children cluster under their parent. Coordinates are a fixed grid - the
 * result is identical for identical input.
 */
export function computeLayeredLayout<N extends { readonly id: string }, E>(
  nodes: readonly N[],
  edges: readonly LayoutEdge<E>[],
  options: LayeredOptions = {},
): LayeredLayout<N, E> {
  const { gapX, gapY, marginX, marginY } = { ...DEFAULTS, ...options };
  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      droppedEdges: edges.length,
      cyclicNodes: 0,
      width: 0,
      height: 0,
    };
  }

  const order = new Map<string, number>();
  nodes.forEach((node, index) => order.set(node.id, index));
  const validEdges = edges.filter((edge) => order.has(edge.parentId) && order.has(edge.childId));
  const droppedEdges = edges.length - validEdges.length;

  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const edge of validEdges) {
    (children.get(edge.parentId) ?? children.set(edge.parentId, []).get(edge.parentId)!).push(
      edge.childId,
    );
    indegree.set(edge.childId, indegree.get(edge.childId)! + 1);
  }

  // Kahn topological pass; depth = longest path from any root.
  const depth = new Map<string, number>();
  const queue: string[] = nodes.filter((node) => indegree.get(node.id) === 0).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  const remaining = new Map(indegree);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    for (const childId of children.get(id) ?? []) {
      depth.set(childId, Math.max(depth.get(childId) ?? 0, depth.get(id)! + 1));
      const left = remaining.get(childId)! - 1;
      remaining.set(childId, left);
      if (left === 0) queue.push(childId);
    }
  }

  // Cycle members never reach indegree 0; park them on one fallback layer.
  const processed = new Set(queue);
  const cyclic = nodes.filter((node) => !processed.has(node.id));
  const maxProcessedDepth = Math.max(0, ...[...processed].map((id) => depth.get(id)!));
  const fallbackDepth = processed.size > 0 && cyclic.length > 0 ? maxProcessedDepth + 1 : 0;
  for (const node of cyclic) depth.set(node.id, fallbackDepth);

  // Group into layers (input order within a layer as the initial order).
  const layers = new Map<number, N[]>();
  for (const node of nodes) {
    const d = depth.get(node.id)!;
    (layers.get(d) ?? layers.set(d, []).get(d)!).push(node);
  }

  // Parents-of map for the barycenter pass (only parents on shallower layers).
  const parents = new Map<string, string[]>();
  for (const edge of validEdges) {
    if (depth.get(edge.parentId)! < depth.get(edge.childId)!) {
      (parents.get(edge.childId) ?? parents.set(edge.childId, []).get(edge.childId)!).push(
        edge.parentId,
      );
    }
  }

  const position = new Map<string, { x: number; y: number }>();
  const sortedDepths = [...layers.keys()].sort((a, b) => a - b);
  let maxLayerSize = 0;
  for (const d of sortedDepths) {
    const layer = layers.get(d)!;
    const keyed = layer.map((node) => {
      const parentXs = (parents.get(node.id) ?? [])
        .map((id) => position.get(id)?.x)
        .filter((x): x is number => x !== undefined);
      const barycenter =
        parentXs.length > 0
          ? parentXs.reduce((sum, x) => sum + x, 0) / parentXs.length
          : Number.POSITIVE_INFINITY;
      return { node, barycenter, tiebreak: order.get(node.id)! };
    });
    keyed.sort((a, b) => a.barycenter - b.barycenter || a.tiebreak - b.tiebreak);
    keyed.forEach((entry, index) => {
      position.set(entry.node.id, { x: marginX + index * gapX, y: marginY + d * gapY });
    });
    maxLayerSize = Math.max(maxLayerSize, layer.length);
  }

  const placedNodes: PlacedNode<N>[] = nodes.map((node) => {
    const { x, y } = position.get(node.id)!;
    return { node, x, y, depth: depth.get(node.id)! };
  });
  const placedEdges: PlacedEdge<E>[] = validEdges.map((edge) => {
    const from = position.get(edge.parentId)!;
    const to = position.get(edge.childId)!;
    return { payload: edge.payload, x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  });
  const maxDepth = Math.max(...sortedDepths);

  return {
    nodes: placedNodes,
    edges: placedEdges,
    droppedEdges,
    cyclicNodes: cyclic.length,
    width: marginX * 2 + (maxLayerSize - 1) * gapX,
    height: marginY * 2 + maxDepth * gapY,
  };
}
