/**
 * QA-8 — property tests for `parseSession` over generated transcripts.
 *
 * Three claims, each universally quantified:
 *  1. Usage mapping never double counts a cache write: a record's 5m + 1h
 *     total is `max(flat, split)`, whichever shapes it carries (NN2).
 *  2. Torn or non-JSON lines (DAT-7) are skipped and counted, and nothing
 *     else about the parse changes, wherever they sit.
 *  3. On arbitrary JSON records and junk lines the parser either returns or
 *     fails loudly with one of its two declared errors — never a TypeError
 *     from a shape it did not expect.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseSession,
  SubstrateError,
  UsageConflictError,
  type ParsedSession,
  type SessionSubstrate,
} from '../src/index';

// A fixed run count over generated inputs is CPU-bound: its wall-clock time
// measures the machine's load, not the property. 2000 runs under coverage on
// a loaded host passed the package's 15 s bound, so these tests get their own.
const PROPERTY_TIMEOUT_MS = 120_000;

const SESSION = 'a8a80000-1111-4222-8333-444444444444';
const MAIN = `${SESSION}.jsonl`;

interface UsageShape {
  input: number;
  output: number;
  cacheRead: number;
  flat: number | undefined;
  split: { m5: number; h1: number } | undefined;
}

const count = fc.nat({ max: 10_000 });
const usageShape: fc.Arbitrary<UsageShape> = fc.record({
  input: count,
  output: count,
  cacheRead: count,
  flat: fc.option(count, { nil: undefined }),
  split: fc.option(fc.record({ m5: count, h1: count }), { nil: undefined }),
});

function timestamp(i: number): string {
  return new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString();
}

function assistantLine(i: number, u: UsageShape): string {
  const usage: Record<string, unknown> = {
    input_tokens: u.input,
    output_tokens: u.output,
    cache_read_input_tokens: u.cacheRead,
  };
  if (u.flat !== undefined) {
    usage['cache_creation_input_tokens'] = u.flat;
  }
  if (u.split !== undefined) {
    usage['cache_creation'] = {
      ephemeral_5m_input_tokens: u.split.m5,
      ephemeral_1h_input_tokens: u.split.h1,
    };
  }
  return JSON.stringify({
    sessionId: SESSION,
    type: 'assistant',
    timestamp: timestamp(i),
    message: { id: `msg_${i}`, model: 'synthetic-model', usage },
  });
}

function substrate(lines: string[]): SessionSubstrate {
  return { files: [{ relativePath: MAIN, lines }] };
}

/** A non-blank line that is not valid JSON: what a torn append or a stray write leaves. */
const malformedLine = fc
  .oneof(
    // A strict prefix of a real record: the torn-append case.
    fc.tuple(usageShape, fc.nat()).map(([u, cut]) => {
      const full = assistantLine(0, u);
      return full.slice(0, 1 + (cut % (full.length - 1)));
    }),
    fc.string({ minLength: 1 }),
    fc.string({ unit: 'binary', minLength: 1 }),
  )
  .filter((line) => {
    if (line.trim() === '') {
      return false;
    }
    try {
      JSON.parse(line);
      return false;
    } catch {
      return true;
    }
  });

function withoutCensus(parsed: ParsedSession): Omit<ParsedSession, 'formatCensus'> {
  const rest = { ...parsed };
  delete rest.formatCensus;
  return rest;
}

describe('parseSession — properties (QA-8)', () => {
  it('a record reports max(flat, 5m + 1h) cache-write tokens, never their sum', () => {
    fc.assert(
      fc.property(fc.array(usageShape, { minLength: 1, maxLength: 8 }), (shapes) => {
        const parsed = parseSession(substrate(shapes.map((u, i) => assistantLine(i, u))));
        expect(parsed.usage).toHaveLength(shapes.length);
        shapes.forEach((u, i) => {
          const entry = parsed.usage.find((d) => d.messageId === `msg_${i}`)!;
          const splitTotal = u.split === undefined ? 0 : u.split.m5 + u.split.h1;
          expect(entry.usage.cacheWrite5m + entry.usage.cacheWrite1h).toBe(
            Math.max(u.flat ?? 0, splitTotal),
          );
          // The 1h bucket is only ever what the split says.
          expect(entry.usage.cacheWrite1h).toBe(u.split?.h1 ?? 0);
          expect([entry.usage.input, entry.usage.output, entry.usage.cacheRead]).toEqual([
            u.input,
            u.output,
            u.cacheRead,
          ]);
        });
      }),
    );
  });

  it('malformed lines anywhere are skipped and counted, and change nothing else', () => {
    fc.assert(
      fc.property(
        fc.array(usageShape, { minLength: 1, maxLength: 6 }),
        fc.array(fc.tuple(fc.nat(), malformedLine), { maxLength: 6 }),
        (shapes, insertions) => {
          const clean = shapes.map((u, i) => assistantLine(i, u));
          const dirty = [...clean];
          for (const [at, line] of insertions) {
            dirty.splice(at % (dirty.length + 1), 0, line);
          }
          const baseline = parseSession(substrate(clean));
          const parsed = parseSession(substrate(dirty));
          expect(parsed.formatCensus?.malformedLines).toBe(insertions.length);
          expect(withoutCensus(parsed)).toEqual(withoutCensus(baseline));
        },
      ),
    );
  });

  it(
    'on arbitrary records and junk lines, returns or throws only its declared errors',
    { timeout: PROPERTY_TIMEOUT_MS },
    () => {
      // Records that LOOK like transcript lines, with every field allowed to take
      // a wrong type — the shapes a format drift would produce.
      const loose = fc.jsonValue();
      const record = fc.record(
        {
          sessionId: fc.oneof(fc.constant(SESSION), loose),
          type: fc.oneof(fc.constantFrom('assistant', 'user', 'system', 'summary'), loose),
          timestamp: fc.oneof(fc.integer({ min: 0, max: 50 }).map(timestamp), loose),
          message: fc.oneof(
            fc.record(
              {
                id: fc.oneof(fc.constantFrom('msg_0', 'msg_1'), loose),
                model: fc.oneof(fc.constantFrom('m-a', 'm-b'), loose),
                usage: fc.oneof(
                  fc.record(
                    {
                      input_tokens: fc.oneof(count, loose),
                      output_tokens: fc.oneof(count, loose),
                      cache_creation_input_tokens: fc.oneof(count, loose),
                      cache_creation: loose,
                    },
                    { requiredKeys: [] },
                  ),
                  loose,
                ),
                content: loose,
              },
              { requiredKeys: [] },
            ),
            loose,
          ),
          uuid: loose,
          parentUuid: loose,
          isSidechain: loose,
          toolUseResult: loose,
        },
        { requiredKeys: [] },
      );
      const line = fc.oneof(
        { weight: 4, arbitrary: record.map((r) => JSON.stringify(r)) },
        { weight: 1, arbitrary: malformedLine },
        { weight: 1, arbitrary: loose.map((v) => JSON.stringify(v)) },
      );
      fc.assert(
        fc.property(fc.array(line, { maxLength: 10 }), (lines) => {
          try {
            parseSession(substrate(lines));
          } catch (error) {
            expect([SubstrateError, UsageConflictError].some((E) => error instanceof E)).toBe(true);
          }
        }),
        { numRuns: 2000 },
      );
    },
  );
});
