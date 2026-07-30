/**
 * Contract table for {@link classifyRelativePath} — the ONE classifier the
 * WP-IN5 disk adapter reuses as its artifact allowlist (the anti-drift
 * linchpin). This locks the keep/reject boundary, including the traps a naive
 * substring/extension check would misfile: uppercase names, uppercase hex, a
 * `wf_<id>.json` workflow marker, `agent-<non-hex>.jsonl`, and stray
 * `.txt`/`.js`/`.pdf` companions under `subagents/`.
 */
import { describe, expect, it } from 'vitest';
import { classifyRelativePath } from '../src/index';

describe('classifyRelativePath (WP-IN5 allowlist contract)', () => {
  it.each([
    // --- the four section-2 artifact kinds that the adapter INGESTS ---
    ['11111111-2222-4333-8444-555555555555.jsonl', 'main'],
    ['subagents/agent-3fa9c2d1.jsonl', 'agent'],
    ['subagents/workflows/wf_synth01/agent-ab12cd34.jsonl', 'agent'],
    ['subagents/agent-3fa9c2d1.meta.json', 'meta'],
    ['subagents/workflows/wf_synth01/agent-ab12cd34.meta.json', 'meta'],
    ['subagents/journal.jsonl', 'journal'],
    ['subagents/workflows/wf_synth01/journal.jsonl', 'journal'],
  ])('classifies %s as %s (kept)', (relativePath, kind) => {
    expect(classifyRelativePath(relativePath)).toBe(kind);
  });

  it.each([
    // --- traps: everything the adapter must SKIP as a non-artifact ---
    ['subagents/notes.txt', 'other'],
    ['subagents/scripts/run.js', 'other'],
    ['subagents/agent-3fa9c2d1.pdf', 'other'],
    // a `wf_<id>.json` marker is NOT an agent/meta/journal artifact
    ['subagents/workflows/wf_synth01.json', 'other'],
    // uppercase filename — the agent regex is case-sensitive lowercase
    ['subagents/AGENT-ABCD.JSONL', 'other'],
    // uppercase hex is not [0-9a-f]
    ['subagents/agent-ABCD.jsonl', 'other'],
    // a non-hex "hex" segment
    ['subagents/agent-notes.jsonl', 'other'],
    // a project-root companion that is not a `<uuid>.jsonl` main is still 'main'
    // ONLY structurally (no slash + .jsonl); a non-jsonl root file is 'other'
    ['README.md', 'other'],
  ])('classifies %s as %s (skipped)', (relativePath, kind) => {
    expect(classifyRelativePath(relativePath)).toBe(kind);
  });

  it('treats ANY no-slash *.jsonl as a main (structural), even a non-uuid stem', () => {
    // classifyRelativePath is structural; the SESSION-uuid gate lives in
    // enumerateSessions, not here. A bare `foo.jsonl` is 'main' to the classifier.
    expect(classifyRelativePath('foo.jsonl')).toBe('main');
  });

  it('classifies a root-level agent-<hex>.jsonl as agent by basename (no slash needed)', () => {
    // Such a file never reaches the walk (which only descends subagents/), but
    // the classifier keys on the basename, so this documents the true contract.
    expect(classifyRelativePath('agent-deadbeef.jsonl')).toBe('agent');
  });
});
