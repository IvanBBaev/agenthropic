import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, parseHash, parseRoute, VIEW_IDS, viewHash } from '../src/router';

describe('parseHash', () => {
  it('resolves each canonical view hash', () => {
    for (const id of VIEW_IDS) {
      expect(parseHash(`#/${id}`)).toBe(id);
    }
  });

  it('tolerates a missing slash and a trailing slash', () => {
    expect(parseHash('#cost')).toBe('cost');
    expect(parseHash('#/cost/')).toBe('cost');
  });

  it('falls back to the default view for empty and unknown hashes', () => {
    expect(parseHash('')).toBe(DEFAULT_VIEW);
    expect(parseHash('#')).toBe(DEFAULT_VIEW);
    expect(parseHash('#/')).toBe(DEFAULT_VIEW);
    expect(parseHash('#/nope')).toBe(DEFAULT_VIEW);
    expect(parseHash('#/live/extra')).toBe(DEFAULT_VIEW);
    // AMENDED 2026-09-07 (RT-2). The line above claimed to prove that a hash
    // with a trailing segment is NOT treated as the view it starts with. It
    // cannot prove that: `DEFAULT_VIEW` is `'live'`, so a parser that matched
    // `live` and threw `/extra` away returns the same string and the assertion
    // passes for the wrong reason. The behaviour is right; only the evidence
    // was vacuous. The assertion is kept, and one that can actually fail is
    // added next to it - `cost` is not the default, so this passes only if the
    // trailing segment really did make the hash unrecognisable.
    expect(parseHash('#/cost/extra')).toBe(DEFAULT_VIEW);
  });
});

describe('viewHash', () => {
  it('round-trips through parseHash for every view', () => {
    for (const id of VIEW_IDS) {
      expect(parseHash(viewHash(id))).toBe(id);
    }
  });
});

/**
 * Red-team pass on the routing surface, 2026-09-07 (RT-1).
 *
 * WRONG BELIEF: "the view on screen is the one this URL names."
 *
 * `parseHash` answers every unrecognised hash with the default view and keeps
 * no record of having done so. So `#/agents` - a stale bookmark, a typo, a link
 * from a build that has a view this one does not - lands on Live, the sidebar
 * marks Live with `aria-current="page"`, and the address bar goes on naming a
 * route that does not exist here. Nothing on screen and nothing in a live
 * region distinguishes "I asked for Live" from "what I asked for is not here",
 * and the reader's next act is to bookmark or share a URL that will keep
 * landing somewhere it did not ask for.
 *
 * The fallback itself is right - there is nothing else to render - so it stays.
 * `parseRoute` adds back the one fact the fallback destroyed: whether the hash
 * named a view at all.
 */
describe('parseRoute reports whether the hash named a real view (RT-1)', () => {
  it('marks every canonical view hash as recognised', () => {
    for (const id of VIEW_IDS) {
      const route = parseRoute(viewHash(id));
      expect(route.view).toBe(id);
      expect(route.recognised).toBe(true);
      expect(route.requested).toBe(viewHash(id));
    }
  });

  it('marks an empty hash as recognised, because nothing was asked for', () => {
    // Opening the dashboard with no hash is not a refused request. Warning
    // about it would put a notice on the ordinary path, which is how a reader
    // learns to stop reading notices.
    for (const hash of ['', '#', '#/']) {
      expect(parseRoute(hash).recognised).toBe(true);
      expect(parseRoute(hash).view).toBe(DEFAULT_VIEW);
    }
  });

  it('marks a hash this build has no view for as NOT recognised', () => {
    // `#/Cost` is in this list deliberately: hashes are case-sensitive by
    // spec and this router does not fold case, so the capitalised form is a
    // route that does not exist. Folding it would make the URL and the view
    // disagree in the other direction; disclosing the miss does not.
    for (const hash of ['#/agents', '#/Cost', '#/cost/extra', '#/live/extra', '#/nope']) {
      const route = parseRoute(hash);
      expect(route.view).toBe(DEFAULT_VIEW);
      expect(route.recognised).toBe(false);
      // Carried verbatim so the reader can be shown what they actually asked
      // for rather than this module's normalisation of it.
      expect(route.requested).toBe(hash);
    }
  });

  it('keeps parseHash as exactly the view half of the same answer', () => {
    for (const hash of ['#/cost', '#/nope', '', '#/dag/']) {
      expect(parseHash(hash)).toBe(parseRoute(hash).view);
    }
  });
});
