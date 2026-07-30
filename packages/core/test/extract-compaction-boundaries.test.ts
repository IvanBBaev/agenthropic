/**
 * Tests for the compaction-boundary extractor (parser-spec gate #8).
 *
 * The extractor is the parser-gap fill for WP-C4: `parseSession` does not
 * surface `compact_boundary` records, so a separate pure pass over the raw
 * substrate must find them, attribute each to its owning transcript, and stay
 * loud on structural corruption (non-JSON line, unplaceable boundary) while
 * tolerating benign shape drift (missing `compactMetadata`).
 */
import { describe, expect, it } from 'vitest';
import { extractCompactionBoundaries, SubstrateError } from '../src/index';
import type { SessionSubstrate } from '../src/index';
import { getFixture } from '@agenthropic/test-fixtures';

/** JSON-encode a record as one JSONL line (mirrors the fixtures' `jsonLine`). */
function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function substrate(files: Array<{ path: string; lines: string[] }>): SessionSubstrate {
  return { files: files.map((f) => ({ relativePath: f.path, lines: f.lines })) };
}

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function boundaryLine(timestamp: string, metadata?: Record<string, unknown>): string {
  return jline({
    sessionId: SESSION,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp,
    ...(metadata === undefined ? {} : { compactMetadata: metadata }),
  });
}

describe('extractCompactionBoundaries', () => {
  it('returns [] for an empty substrate and for transcripts without boundaries', () => {
    expect(extractCompactionBoundaries({ files: [] })).toEqual([]);
    const noBoundaries = substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [jline({ sessionId: SESSION, type: 'user', timestamp: '2026-01-01T00:00:00Z' })],
      },
    ]);
    expect(extractCompactionBoundaries(noBoundaries)).toEqual([]);
  });

  it('extracts a main-transcript boundary with trigger and the preTokens baseline', () => {
    const result = extractCompactionBoundaries(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [boundaryLine('2026-02-01T10:00:00.000Z', { trigger: 'auto', preTokens: 119208 })],
        },
      ]),
    );
    expect(result).toEqual([
      {
        agentId: null,
        timestamp: '2026-02-01T10:00:00.000Z',
        trigger: 'auto',
        preTokens: 119208,
      },
    ]);
  });

  it('attributes an agent-transcript boundary to the filename hex (compaction mid-agent)', () => {
    const result = extractCompactionBoundaries(
      substrate([
        {
          path: 'subagents/agent-3fa9c2d1.jsonl',
          lines: [boundaryLine('2026-02-01T11:00:00.000Z', { trigger: 'manual', preTokens: 42 })],
        },
      ]),
    );
    expect(result).toEqual([
      {
        agentId: '3fa9c2d1',
        timestamp: '2026-02-01T11:00:00.000Z',
        trigger: 'manual',
        preTokens: 42,
      },
    ]);
  });

  it('collects multiple boundaries across files in file-then-line order', () => {
    const result = extractCompactionBoundaries(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            boundaryLine('2026-02-01T10:00:00.000Z', { trigger: 'auto', preTokens: 100 }),
            jline({ sessionId: SESSION, type: 'user', timestamp: '2026-02-01T10:00:01Z' }),
            boundaryLine('2026-02-01T12:00:00.000Z', { trigger: 'auto', preTokens: 200 }),
          ],
        },
        {
          path: 'subagents/agent-c0ffee42.jsonl',
          lines: [boundaryLine('2026-02-01T11:00:00.000Z', { trigger: 'auto', preTokens: 150 })],
        },
      ]),
    );
    expect(result.map((b) => [b.agentId, b.preTokens])).toEqual([
      [null, 100],
      [null, 200],
      ['c0ffee42', 150],
    ]);
  });

  it('tolerates a missing or malformed compactMetadata (trigger/preTokens become null)', () => {
    const result = extractCompactionBoundaries(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            boundaryLine('2026-02-01T10:00:00.000Z'),
            boundaryLine('2026-02-01T10:05:00.000Z', { trigger: 7, preTokens: 'many' }),
            boundaryLine('2026-02-01T10:10:00.000Z', { trigger: 'auto', preTokens: Number.NaN }),
          ],
        },
      ]),
    );
    expect(result).toHaveLength(3);
    for (const boundary of result) {
      expect(boundary.preTokens).toBeNull();
    }
    expect(result.map((b) => b.trigger)).toEqual([null, null, 'auto']);
  });

  it('ignores non-boundary records, non-object lines and blank lines', () => {
    const result = extractCompactionBoundaries(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            jline({ type: 'system', subtype: 'other', timestamp: '2026-02-01T09:00:00Z' }),
            jline({ type: 'assistant', subtype: 'compact_boundary' }), // wrong type
            '"just a string"',
            '[1,2,3]',
            '   ',
            boundaryLine('2026-02-01T10:00:00.000Z', { trigger: 'auto', preTokens: 1 }),
          ],
        },
      ]),
    );
    expect(result).toHaveLength(1);
  });

  it('skips sidecar, journal and other non-transcript files entirely', () => {
    const boundary = boundaryLine('2026-02-01T10:00:00.000Z', { trigger: 'auto', preTokens: 1 });
    const result = extractCompactionBoundaries(
      substrate([
        { path: 'subagents/agent-3fa9c2d1.meta.json', lines: [boundary] },
        { path: 'subagents/workflows/wf_x/journal.jsonl', lines: [boundary] },
        { path: 'notes/readme.txt', lines: [boundary] },
      ]),
    );
    expect(result).toEqual([]);
  });

  it('throws SubstrateError on a non-JSON line in a transcript file', () => {
    const bad = substrate([{ path: `${SESSION}.jsonl`, lines: ['{not json'] }]);
    expect(() => extractCompactionBoundaries(bad)).toThrow(SubstrateError);
    expect(() => extractCompactionBoundaries(bad)).toThrow(/not valid JSON/);
  });

  it('throws SubstrateError on a boundary without a string timestamp', () => {
    const noTs = substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [jline({ type: 'system', subtype: 'compact_boundary', compactMetadata: {} })],
      },
    ]);
    expect(() => extractCompactionBoundaries(noTs)).toThrow(SubstrateError);
    expect(() => extractCompactionBoundaries(noTs)).toThrow(/cannot be placed in time/);
  });

  it('finds the compact_boundary of the task-notification-recovery fixture', () => {
    const result = extractCompactionBoundaries(getFixture('task-notification-recovery'));
    expect(result).toEqual([
      {
        agentId: null,
        timestamp: '2026-01-17T14:00:00.000Z',
        trigger: 'auto',
        preTokens: 165000,
      },
    ]);
  });

  it('finds no boundaries in the compaction-free fixtures', () => {
    for (const name of ['flat-tool-use', 'depth-2-sync'] as const) {
      expect(extractCompactionBoundaries(getFixture(name))).toEqual([]);
    }
  });
});
