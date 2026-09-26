/**
 * Edge-provenance vocabulary tests (lane-EP, 2026-09-23).
 *
 * The defect these pin is not a crash and not a missing value: it is the UI
 * making a claim the server did not. `source === 'tool_use' ? observed :
 * inferred` said "this link was DERIVED" about every word it had not learned,
 * and both legends then enumerated the four derivations beside the stroke it
 * drew for them. These tests hold the third answer open from the renderer's
 * end, the way `status.test.ts` holds `statusMeta` open from its own -
 * `dto-guards.ts` exempts this field from validation on the explicit grounds
 * that the renderer handles it, so tightening one of the two must fail the
 * other.
 */
import { describe, expect, it } from 'vitest';
import {
  ABSENT_EDGE_SOURCE_REASON,
  edgeProvenance,
  EDGE_PROVENANCE_LEGEND,
  EDGE_SOURCES,
  INFERRED_EDGE_SOURCES,
  OBSERVED_EDGE_SOURCE,
} from '../src/views/provenance';

describe('EDGE_SOURCES', () => {
  it('lists every source the schema can persist', () => {
    expect(EDGE_SOURCES).toEqual([
      'tool_use',
      'directory',
      'task_notification',
      'queue_operation',
      'legacy_explore',
    ]);
  });

  it('derives the inferred set rather than keeping a second copy of it', () => {
    expect(INFERRED_EDGE_SOURCES).toEqual([
      'directory',
      'task_notification',
      'queue_operation',
      'legacy_explore',
    ]);
    expect(INFERRED_EDGE_SOURCES).not.toContain(OBSERVED_EDGE_SOURCE);
    expect([OBSERVED_EDGE_SOURCE, ...INFERRED_EDGE_SOURCES]).toEqual(EDGE_SOURCES);
  });
});

describe('edgeProvenance', () => {
  it('calls the parent-side tool_use block what it is: an observation', () => {
    expect(edgeProvenance('tool_use')).toEqual({
      kind: 'observed',
      detail: 'tool_use',
      className: 'edge edge-observed',
      title: 'observed (tool_use)',
    });
  });

  it('names the derivation for each of the four inferred join paths', () => {
    for (const source of INFERRED_EDGE_SOURCES) {
      const provenance = edgeProvenance(source);
      expect(provenance.kind).toBe('inferred');
      expect(provenance.className).toBe('edge edge-inferred');
      // The source word itself, unquoted: it is a term this build knows and
      // the legend defines, not a raw byte sequence being exhibited.
      expect(provenance.title).toBe(`inferred (${source})`);
    }
  });

  it('refuses to call an unlearned source inferred', () => {
    // The whole finding, in one assertion. A server one version ahead joins two
    // agents by some new structural path; this build has never read the word.
    // The old code drew a dashed line titled `inferred (mcp_spawn)`, which
    // asserts the link was DERIVED - and it may well have been observed, in
    // which case the page understated its own graph. Either way the claim was
    // the client's.
    const provenance = edgeProvenance('mcp_spawn');
    expect(provenance.kind).toBe('unrecognised');
    expect(provenance.title).toBe('unrecognised ("mcp_spawn")');
    expect(provenance.className).toBe('edge edge-unrecognised');
    expect(provenance.className).not.toContain('edge-inferred');
  });

  it('exhibits a blank source instead of rendering an empty parenthesis', () => {
    // `dto-guards.ts` checks containers and load-bearing numbers and
    // deliberately not strings, so `''` reaches here as legitimately as
    // `'mcp_spawn'` does. It used to render `inferred ()` - a parenthesis that
    // promises a value and shows none, indistinguishable from a rendering
    // fault in the page. The quotes are what make the emptiness legible.
    expect(edgeProvenance('').title).toBe('unrecognised ("")');
    expect(edgeProvenance('   ').title).toBe('unrecognised ("   ")');
  });

  it('states the absence when no source word arrived at all', () => {
    // A field the server stopped sending, or renamed, arrives as `undefined`
    // and used to interpolate into `inferred (undefined)` - the same sentence
    // SV-3 removed from `statusMeta`, telling the reader their server sent the
    // source "undefined" when it had sent no source.
    for (const value of [undefined, null, 42, {}, ['directory']]) {
      const provenance = edgeProvenance(value);
      expect(provenance.kind).toBe('unrecognised');
      expect(provenance.title).toBe(`unrecognised (${ABSENT_EDGE_SOURCE_REASON})`);
      expect(provenance.className).toBe('edge edge-unrecognised');
    }
  });

  it('gives the three kinds three strokes, never a shade of one another', () => {
    const classes = [
      edgeProvenance('tool_use').className,
      edgeProvenance('directory').className,
      edgeProvenance('mcp_spawn').className,
    ];
    expect(new Set(classes).size).toBe(3);
  });
});

describe('EDGE_PROVENANCE_LEGEND', () => {
  it('explains every stroke the views can draw', () => {
    expect(EDGE_PROVENANCE_LEGEND).toBe(
      '— observed (tool_use) ┄ inferred (directory, task_notification, queue_operation, legacy_explore) ⋯ unrecognised (the raw word in quotes, or "no source word sent")',
    );
  });

  it('is generated from the same list the renderer routes on', () => {
    // The invariant the shell legend keeps, applied here: never draw a stroke
    // the legend does not explain. A legend written out beside the router is a
    // second source of truth, and the first edit to either desynchronises them.
    for (const source of INFERRED_EDGE_SOURCES) {
      expect(EDGE_PROVENANCE_LEGEND).toContain(source);
    }
    expect(EDGE_PROVENANCE_LEGEND).toContain(ABSENT_EDGE_SOURCE_REASON);
  });
});
