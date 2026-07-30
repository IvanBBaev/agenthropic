/**
 * Hand-rolled hash router (WP-U5). No dependency: the four v1.0 views are a
 * flat hub-and-spoke (ux0-design SS1), so a `#/live | #/sessions | #/dag |
 * #/cost` hash is the whole routing surface. Unknown or empty hashes fall
 * back to the live status board (the default/home view).
 */
import { useSyncExternalStore } from 'react';

export const VIEW_IDS = ['live', 'sessions', 'dag', 'cost'] as const;

export type ViewId = (typeof VIEW_IDS)[number];

export const DEFAULT_VIEW: ViewId = 'live';

/** `'#/cost'` (also `'#cost'`, `'#/cost/'`) -> `'cost'`; anything else -> default. */
export function parseHash(hash: string): ViewId {
  const normalized = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  return (VIEW_IDS as readonly string[]).includes(normalized)
    ? (normalized as ViewId)
    : DEFAULT_VIEW;
}

/** The canonical href for a view, usable directly in an anchor. */
export function viewHash(view: ViewId): string {
  return `#/${view}`;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function readRoute(): ViewId {
  return parseHash(window.location.hash);
}

/** Current view id, re-rendering on `hashchange`. */
export function useHashRoute(): ViewId {
  return useSyncExternalStore(subscribeToHash, readRoute);
}
