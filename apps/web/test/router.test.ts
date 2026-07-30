import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, parseHash, VIEW_IDS, viewHash } from '../src/router';

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
  });
});

describe('viewHash', () => {
  it('round-trips through parseHash for every view', () => {
    for (const id of VIEW_IDS) {
      expect(parseHash(viewHash(id))).toBe(id);
    }
  });
});
