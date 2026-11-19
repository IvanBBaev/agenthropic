/**
 * QA-8 — byte-level fuzz of the two places raw transcript bytes become lines.
 *
 *  - `splitTranscriptLines`: a `.jsonl` read must yield exactly the
 *    newline-terminated records, dropping the torn tail of a live append, and a
 *    growing file must only ever EXTEND the line list it yielded before.
 *  - The tail cache (review M-15) promises "cached read ≡ full read". Its
 *    anchors are byte-level (0x0A never sits inside a multi-byte UTF-8
 *    sequence; a torn remainder is never cached; BOM kept), so the fuzz drives
 *    it with arbitrary BYTES — invalid UTF-8, a split multi-byte character, a
 *    leading BOM, NULs — through appends, truncations and same-size rewrites,
 *    and compares every read with a fresh decode of the whole file.
 *
 * Excluded on purpose: a rewrite that GROWS the file and happens to leave the
 * overlap window byte-identical. That is the cache's documented residual blind
 * spot (tail-cache.ts, STO-2), not a property it claims.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitTranscriptLines } from '../src/corpus/corpus-paths';
import type { CorpusFs, TailRead } from '../src/corpus/fs-port';
import { createTailCachingFs } from '../src/corpus/tail-cache';

const PATH = '/corpus/project/session.jsonl';
const BOM = String.fromCharCode(0xfeff);
const CAP = 1 << 20;

/** One mutable in-memory file behind the {@link CorpusFs} port. */
function memoryFs(): { fs: CorpusFs; file: { bytes: Uint8Array; mtimeMs: number } } {
  const file = { bytes: new Uint8Array(0), mtimeMs: 1 };
  const unused = (): never => {
    throw new Error('not used by this test');
  };
  const fs: CorpusFs = {
    readDirNames: unused,
    lstat: unused,
    realpath: unused,
    // Mirrors node-corpus-fs: `readFileSync(fd, 'utf8')`, which keeps a BOM.
    readFileConfined: () => Buffer.from(file.bytes).toString('utf8'),
    readFileTailConfined: (_path, fromByte): TailRead => ({
      data: file.bytes.slice(Math.min(fromByte, file.bytes.length)),
      sizeBytes: file.bytes.length,
      mtimeMs: file.mtimeMs,
    }),
  };
  return { fs, file };
}

/** Bytes biased toward the ones that matter: newlines, UTF-8 lead/continuation bytes, BOM, NUL. */
const interestingByte = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0x20, max: 0x7e }) },
  { weight: 2, arbitrary: fc.constant(0x0a) },
  { weight: 2, arbitrary: fc.integer({ min: 0x80, max: 0xff }) },
  { weight: 1, arbitrary: fc.constantFrom(0x00, 0x0d, 0xef, 0xbb, 0xbf) },
);
const chunk = fc.oneof(
  fc.uint8Array({ maxLength: 24 }),
  fc.array(interestingByte, { maxLength: 24 }).map((b) => Uint8Array.from(b)),
  // Real text split at an arbitrary BYTE, so multi-byte characters tear.
  fc.string({ unit: 'binary', maxLength: 12 }).map((s) => new TextEncoder().encode(`${s}\n`)),
  // A whole BOM: at the file start or at the start of a freshly appended
  // region, a decoder that strips BOMs would silently drop it.
  fc
    .string({ maxLength: 6 })
    .map((s) => new TextEncoder().encode(`${BOM}${s}${s.length % 2 === 0 ? '\n' : ''}`)),
);

type Op =
  | { kind: 'append'; bytes: Uint8Array }
  | { kind: 'truncate'; keep: number }
  | { kind: 'rewriteSameSize'; seed: Uint8Array }
  | { kind: 'touch' };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: chunk.map((bytes) => ({ kind: 'append' as const, bytes })) },
  { weight: 1, arbitrary: fc.nat().map((keep) => ({ kind: 'truncate' as const, keep })) },
  {
    weight: 1,
    arbitrary: fc
      .uint8Array({ minLength: 1, maxLength: 8 })
      .map((seed) => ({ kind: 'rewriteSameSize' as const, seed })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'touch' as const }) },
);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function apply(file: { bytes: Uint8Array; mtimeMs: number }, o: Op): void {
  switch (o.kind) {
    case 'append':
      file.bytes = concat(file.bytes, o.bytes);
      break;
    case 'truncate':
      file.bytes = file.bytes.slice(0, file.bytes.length === 0 ? 0 : o.keep % file.bytes.length);
      break;
    case 'rewriteSameSize':
      file.bytes = file.bytes.map((b, i) => b ^ o.seed[i % o.seed.length]!);
      break;
    case 'touch':
      break;
  }
  // Every write moves the mtime, as a real filesystem would at ms resolution.
  file.mtimeMs += 1;
}

describe('splitTranscriptLines — properties (QA-8)', () => {
  it('yields exactly the newline-terminated records and drops only the torn tail', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (content) => {
        const lines = splitTranscriptLines(content, true);
        const lastNl = content.lastIndexOf('\n');
        expect(lines.map((l) => `${l}\n`).join('')).toBe(content.slice(0, lastNl + 1));
        expect(lines.every((l) => !l.includes('\n'))).toBe(true);
      }),
    );
  });

  it('a growing file only ever extends the line list it yielded before', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.nat(), (content, cut) => {
        const prefix = content.slice(0, content.length === 0 ? 0 : cut % (content.length + 1));
        const before = splitTranscriptLines(prefix, true);
        const after = splitTranscriptLines(content, true);
        expect(after.slice(0, before.length)).toEqual(before);
      }),
    );
  });

  it('a sidecar (non-JSONL) keeps every segment, including an unterminated one', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (content) => {
        expect(splitTranscriptLines(content, false).join('\n')).toBe(content);
      }),
    );
  });
});

describe('tail-caching fs — cached read ≡ full read, at the byte level (QA-8)', () => {
  it('matches a fresh full decode after every append, truncate and same-size rewrite', () => {
    fc.assert(
      fc.property(
        fc.array(op, { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 16 }),
        (ops, overlapBytes) => {
          const { fs, file } = memoryFs();
          const cached = createTailCachingFs(fs, { overlapBytes });
          for (const o of ops) {
            apply(file, o);
            expect(cached.readFileConfined(PATH, CAP)).toBe(fs.readFileConfined(PATH, CAP));
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('a read between the two halves of a split multi-byte character never leaks a replacement char', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', minLength: 1, maxLength: 6 }),
        fc.nat(),
        (text, cut) => {
          const bytes = new TextEncoder().encode(`${text}\n`);
          const at = cut % bytes.length;
          const { fs, file } = memoryFs();
          const cached = createTailCachingFs(fs, { overlapBytes: 4 });
          apply(file, { kind: 'append', bytes: bytes.slice(0, at) });
          cached.readFileConfined(PATH, CAP);
          apply(file, { kind: 'append', bytes: bytes.slice(at) });
          expect(cached.readFileConfined(PATH, CAP)).toBe(`${text}\n`);
        },
      ),
    );
  });
});
