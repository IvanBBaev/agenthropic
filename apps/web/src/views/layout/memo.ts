/**
 * UX-17 - one derived value per served payload.
 *
 * The graph views lay out up to `DAG_NODE_LIMIT` nodes (`computeLayeredLayout`
 * is O(N + E)) and they re-render on every tick of the shared clock, because
 * the snapshot's age label has to keep moving. The tick changes the age; it
 * does not change the payload, so it should not change the layout either.
 *
 * Keyed by object identity in a WeakMap rather than with `useMemo`: the DAG
 * view computes its layout after its loading and error branches have returned,
 * where a hook cannot be called, and a payload held in state keeps its
 * identity for exactly as long as it is the payload on screen. A new read, or
 * a live patch that rebuilds the tree, is a new object and gets a new layout;
 * a dropped payload takes its cache entry with it.
 */
export function memoizeOnPayload<P extends object, R>(
  compute: (payload: P) => R,
): (payload: P) => R {
  // Boxed, so a computed `undefined` would still be a cache hit.
  const cache = new WeakMap<P, { readonly value: R }>();
  return (payload) => {
    const hit = cache.get(payload);
    if (hit !== undefined) return hit.value;
    const value = compute(payload);
    cache.set(payload, { value });
    return value;
  };
}
