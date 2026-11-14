/**
 * Hand-rolled hash router (WP-U5). No dependency: the four v1.0 views are a
 * flat hub-and-spoke (ux0-design SS1), so a `#/live | #/sessions | #/dag |
 * #/cost` hash is the whole routing surface. Unknown or empty hashes fall
 * back to the live status board (the default/home view).
 *
 * AMENDED 2026-09-07 (RT-1). The fallback above was the whole answer: an
 * unrecognised hash produced the default view and no record that anything had
 * been refused. `#/agents` - a typo, a stale bookmark, a link from a build that
 * has a view this one does not - therefore rendered Live, the nav marked Live
 * with `aria-current="page"`, and the address bar went on naming a route that
 * does not exist here. Nothing distinguished "I asked for Live" from "what I
 * asked for is not in this build", and the reader's next act is to trust, share
 * or bookmark a URL that will keep landing somewhere it did not ask for.
 *
 * The fallback itself stays - there is nothing else to render - and `parseHash`
 * keeps its exact old signature and answer. `parseRoute` adds back the one fact
 * the fallback destroyed, so the caller can disclose it.
 *
 * AMENDED 2026-11-14 (R21, UX-1): one view takes a parameter. `#/sessions/<id>`
 * opens the session view with that session selected, so a session is something
 * a reader can bookmark, share or reach from a Live card - before this the
 * selection lived only in component state and every reload or link forgot it.
 * Exactly one non-empty segment is accepted after `sessions`; every other
 * trailing segment (`#/cost/extra`, `#/sessions/a/b`) stays unrecognised, and
 * so does an id that does not percent-decode, because a selection this module
 * cannot read is a route it cannot honour.
 */
import { useSyncExternalStore } from 'react';

export const VIEW_IDS = ['live', 'sessions', 'dag', 'cost'] as const;

export type ViewId = (typeof VIEW_IDS)[number];

export const DEFAULT_VIEW: ViewId = 'live';

/** A hash resolved to a view, plus what the hash actually asked for. */
export interface Route {
  /** The view to render - the fallback when the hash named nothing known. */
  readonly view: ViewId;
  /**
   * The hash verbatim, as the address bar shows it. Not normalised: a reader
   * being told their route does not exist has to see the string they typed or
   * followed, not this module's cleaned-up version of it.
   */
  readonly requested: string;
  /**
   * `false` only when the hash asked for something this build has no view for.
   * An empty hash asked for nothing, so nothing was refused and the home view
   * IS the answer - warning there would put a notice on the ordinary path,
   * which is how a reader learns to stop reading notices.
   */
  readonly recognised: boolean;
  /**
   * The session a `#/sessions/<id>` hash selects, percent-decoded; `null` for
   * every other hash, including a bare `#/sessions`.
   */
  readonly sessionId: string | null;
}

/** The view that accepts a `/<id>` parameter (UX-1). */
const PARAM_VIEW: ViewId = 'sessions';

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** `'#/cost'` (also `'#cost'`, `'#/cost/'`) -> `'cost'`; anything else -> default. */
export function parseRoute(hash: string): Route {
  const normalized = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  const known = (VIEW_IDS as readonly string[]).includes(normalized);
  const prefix = `${PARAM_VIEW}/`;
  if (!known && normalized.startsWith(prefix)) {
    const segment = normalized.slice(prefix.length);
    const sessionId = segment.includes('/') ? null : decodeSegment(segment);
    if (sessionId !== null && sessionId !== '') {
      return { view: PARAM_VIEW, requested: hash, recognised: true, sessionId };
    }
  }
  return {
    view: known ? (normalized as ViewId) : DEFAULT_VIEW,
    requested: hash,
    // Deliberately case-sensitive, matching the URL spec: `#/Cost` is a route
    // that does not exist here. Folding case would make the address bar and
    // the view disagree in the other direction, which is the same lie with
    // better manners; disclosing the miss costs nothing and hides nothing.
    recognised: known || normalized === '',
    sessionId: null,
  };
}

/** The view half of `parseRoute`, unchanged since WP-U5. */
export function parseHash(hash: string): ViewId {
  return parseRoute(hash).view;
}

/** The canonical href for a view, usable directly in an anchor. */
export function viewHash(view: ViewId): string {
  return `#/${view}`;
}

/** The canonical href that opens the session view on one session (UX-1). */
export function sessionHash(sessionId: string): string {
  return `#/${PARAM_VIEW}/${encodeURIComponent(sessionId)}`;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/**
 * `useSyncExternalStore` compares snapshots by identity and re-renders forever
 * if a fresh object comes back from every call, so the last parse is held here
 * and re-used until the hash itself changes. Keyed on the raw hash string,
 * which is the entire input: same hash, same route, same object.
 */
let lastRoute: Route = parseRoute('');

function readRoute(): Route {
  const hash = window.location.hash;
  if (lastRoute.requested !== hash) {
    lastRoute = parseRoute(hash);
  }
  return lastRoute;
}

/** Current route, re-rendering on `hashchange`. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribeToHash, readRoute);
}

/** Current view id, re-rendering on `hashchange`. */
export function useHashRoute(): ViewId {
  return useRoute().view;
}
