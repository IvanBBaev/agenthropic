/**
 * Review M-15 — tail-caching decorator tests. The harness is a byte-level
 * in-memory {@link CorpusFs} (NOT the TreeSpec fake): several scenarios hinge
 * on byte states a JS string cannot express — most importantly a transcript
 * torn mid-way through a multi-byte UTF-8 character. Ground truth for every
 * equivalence assertion is `TextDecoder.decode(<current file bytes>)`, which
 * is byte-for-byte what the bare adapter's full read would have returned; the
 * decorator's ONLY promise is to match that answer while fetching fewer bytes.
 */
import { describe, expect, it } from 'vitest';
import { OversizeError, type CorpusFs, type LstatInfo } from '../../src/corpus/fs-port';
import {
  MAX_CACHE_BYTES,
  MAX_CACHE_ENTRIES,
  OVERLAP_BYTES,
  createTailCachingFs,
} from '../../src/corpus/tail-cache';

const CAP = 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TailCall {
  readonly path: string;
  readonly fromByte: number;
}

interface ByteFsHarness {
  /** The inner fs handed to the decorator. */
  readonly fs: CorpusFs;
  /** Every readFileTailConfined call, in order — path plus requested offset. */
  readonly tailCalls: TailCall[];
  /** Every readDirNames call (delegation proof). */
  readonly dirCalls: string[];
  /** Replace a file's bytes wholesale (a rewrite / truncation). */
  set(path: string, content: string | Uint8Array): void;
  /** Append bytes — what a live transcript writer does between polls. */
  append(path: string, extra: string | Uint8Array): void;
  /** What the bare adapter would answer right now — the equivalence oracle. */
  truth(path: string): string;
  /** Total bytes served by tail reads so far — the cost meter. */
  served(): number;
  /** How many times the inner readFileConfined ran (non-.jsonl passthrough). */
  fullReads(): number;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : content;
}

function makeByteFs(initial: Record<string, string | Uint8Array>): ByteFsHarness {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, content]) => [path, toBytes(content)]),
  );
  const tailCalls: TailCall[] = [];
  const dirCalls: string[] = [];
  let served = 0;
  let fullReads = 0;

  /** Confined lookup shared by both reads: ENOENT when absent, oversize by TOTAL size. */
  function bytesOf(absPath: string, maxBytes: number): Uint8Array {
    const bytes = files.get(absPath);
    if (bytes === undefined) {
      throw Object.assign(new Error(`ENOENT: ${absPath}`), { code: 'ENOENT' });
    }
    if (bytes.length > maxBytes) {
      throw new OversizeError(absPath, bytes.length, maxBytes);
    }
    return bytes;
  }

  const fs: CorpusFs = {
    readDirNames(absDir: string): string[] {
      dirCalls.push(absDir);
      return ['from-inner'];
    },
    lstat(): LstatInfo {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, sizeBytes: 7, mtimeMs: 3 };
    },
    realpath(absPath: string): string {
      return `real:${absPath}`;
    },
    readFileConfined(absPath: string, maxBytes: number): string {
      fullReads += 1;
      return decoder.decode(bytesOf(absPath, maxBytes));
    },
    readFileTailConfined(absPath: string, fromByte: number, maxBytes: number) {
      tailCalls.push({ path: absPath, fromByte });
      const bytes = bytesOf(absPath, maxBytes);
      const data = bytes.slice(Math.min(fromByte, bytes.length));
      served += data.length;
      return { data, sizeBytes: bytes.length };
    },
  };

  return {
    fs,
    tailCalls,
    dirCalls,
    set(path: string, content: string | Uint8Array): void {
      files.set(path, toBytes(content));
    },
    append(path: string, extra: string | Uint8Array): void {
      const current = files.get(path) ?? new Uint8Array(0);
      const added = toBytes(extra);
      const next = new Uint8Array(current.length + added.length);
      next.set(current, 0);
      next.set(added, current.length);
      files.set(path, next);
    },
    truth(path: string): string {
      return decoder.decode(files.get(path));
    },
    served: () => served,
    fullReads: () => fullReads,
  };
}

describe('createTailCachingFs (review M-15)', () => {
  it('a cached re-read after an append equals the bare full read (all defaults)', () => {
    const PATH = '/corpus/slug/aaaa.jsonl';
    const h = makeByteFs({ [PATH]: '{"n":1}\n' });
    const fs = createTailCachingFs(h.fs);

    expect(fs.readFileConfined(PATH, CAP)).toBe(h.truth(PATH));
    h.append(PATH, '{"n":2}\n');
    expect(fs.readFileConfined(PATH, CAP)).toBe(h.truth(PATH));

    // Small file, huge default overlap: the whole cached region IS the overlap
    // window, so the incremental read still starts at byte 0 — and the inner
    // full-string read is never used for a .jsonl path at all.
    expect(h.tailCalls.map((call) => call.fromByte)).toEqual([0, 0]);
    expect(h.fullReads()).toBe(0);
  });

  it('an append costs only the overlap window plus the new bytes', () => {
    const PATH = '/corpus/slug/bbbb.jsonl';
    const lineA = '0123456789abcdef\n'; // 17 bytes
    const lineB = 'ghijklmnopqrs\n'; // 14 bytes
    const h = makeByteFs({ [PATH]: lineA });
    const fs = createTailCachingFs(h.fs, { overlapBytes: 8 });

    expect(fs.readFileConfined(PATH, CAP)).toBe(lineA);
    const afterFirst = h.served();
    h.append(PATH, lineB);
    expect(fs.readFileConfined(PATH, CAP)).toBe(lineA + lineB);

    // THE M-15 claim: 8 overlap bytes re-verified + 14 fresh — never the whole
    // 31-byte file again.
    expect(h.tailCalls).toEqual([
      { path: PATH, fromByte: 0 },
      { path: PATH, fromByte: 9 }, // 17-byte cached region minus the 8-byte overlap
    ]);
    expect(h.served() - afterFirst).toBe(8 + lineB.length);
  });

  it('an unchanged file costs only the overlap window to re-verify', () => {
    const PATH = '/corpus/slug/idle.jsonl';
    const content = '0123456789abcdef\nghijklmnopqrs\n'; // 31 bytes
    const h = makeByteFs({ [PATH]: content });
    const fs = createTailCachingFs(h.fs, { overlapBytes: 8 });

    expect(fs.readFileConfined(PATH, CAP)).toBe(content);
    const afterFirst = h.served();
    expect(fs.readFileConfined(PATH, CAP)).toBe(content);

    expect(h.served() - afterFirst).toBe(8);
    expect(h.tailCalls.map((call) => call.fromByte)).toEqual([0, 23]);
  });

  it('a torn multi-byte character decodes exactly like a full read, then heals', () => {
    const PATH = '/corpus/slug/torn.jsonl';
    const line = '{"line":1}\n';
    const h = makeByteFs({ [PATH]: line });
    const fs = createTailCachingFs(h.fs);
    expect(fs.readFileConfined(PATH, CAP)).toBe(line);

    // 'я' is 0xD1 0x8F in UTF-8; the writer has flushed only the first byte.
    h.append(PATH, new Uint8Array([0xd1]));
    const torn = fs.readFileConfined(PATH, CAP);
    expect(torn).toBe(h.truth(PATH)); // both sides show one replacement char
    expect(torn.endsWith('�')).toBe(true);

    // The torn byte was never cached, so once the writer completes the
    // character it decodes as 'я' — not as two stitched replacement chars.
    h.append(PATH, new Uint8Array([0x8f, 0x0a]));
    expect(fs.readFileConfined(PATH, CAP)).toBe(`${line}я\n`);
    expect(fs.readFileConfined(PATH, CAP)).toBe(h.truth(PATH));
  });

  it('a file that shrank below the cached region falls back to a full read', () => {
    const PATH = '/corpus/slug/shrunk.jsonl';
    const h = makeByteFs({ [PATH]: '{"long":"aaaaaaaa"}\n{"more":2}\n' }); // 31 bytes
    const fs = createTailCachingFs(h.fs, { overlapBytes: 8 });
    expect(fs.readFileConfined(PATH, CAP)).toBe(h.truth(PATH));

    h.set(PATH, '{"s":1}\n'); // truncated below the cached 31-byte region
    expect(fs.readFileConfined(PATH, CAP)).toBe('{"s":1}\n');

    // One probe at the old overlap offset, then a distrust-everything restart.
    expect(h.tailCalls.map((call) => call.fromByte)).toEqual([0, 23, 0]);
  });

  it('an in-place rewrite that keeps the size is caught by the overlap compare', () => {
    const PATH = '/corpus/slug/rewritten.jsonl';
    const original = 'AAAAAAAAAAAAAAA\n'; // 16 bytes
    const rewritten = 'BBBBBBBBBBBBBBB\n'; // same 16 bytes — size alone cannot tell
    const h = makeByteFs({ [PATH]: original });
    const fs = createTailCachingFs(h.fs, { overlapBytes: 8 });
    expect(fs.readFileConfined(PATH, CAP)).toBe(original);

    h.set(PATH, rewritten);
    expect(fs.readFileConfined(PATH, CAP)).toBe(rewritten);
    expect(h.tailCalls.map((call) => call.fromByte)).toEqual([0, 8, 0]);
  });

  it('the entry cap evicts the oldest file, which then needs a full read again', () => {
    const A = '/corpus/slug/first.jsonl';
    const B = '/corpus/slug/second.jsonl';
    const h = makeByteFs({ [A]: '{"a":1}\n', [B]: '{"b":1}\n' });
    const fs = createTailCachingFs(h.fs, { maxEntries: 1, overlapBytes: 4 });

    expect(fs.readFileConfined(A, CAP)).toBe(h.truth(A));
    expect(fs.readFileConfined(B, CAP)).toBe(h.truth(B)); // evicts A
    expect(fs.readFileConfined(A, CAP)).toBe(h.truth(A));

    // Were A still cached, its second read would start at byte 4 (offset 8
    // minus the 4-byte overlap); byte 0 proves the eviction.
    expect(h.tailCalls).toEqual([
      { path: A, fromByte: 0 },
      { path: B, fromByte: 0 },
      { path: A, fromByte: 0 },
    ]);
  });

  it('a single file over the byte budget is never cached at all', () => {
    const PATH = '/corpus/slug/huge.jsonl';
    const h = makeByteFs({ [PATH]: '{"k":"v"}\n' }); // 10 chars ×2 + 10 tail bytes > 16
    const fs = createTailCachingFs(h.fs, { maxTotalBytes: 16 });

    expect(fs.readFileConfined(PATH, CAP)).toBe(h.truth(PATH));
    expect(fs.readFileConfined(PATH, CAP)).toBe(h.truth(PATH));

    // The freshly stored entry evicted ITSELF, so no read is ever incremental —
    // the budget bounds RAM, correctness just costs full reads.
    expect(h.tailCalls.map((call) => call.fromByte)).toEqual([0, 0]);
  });

  it('an inner error is rethrown untouched and forgets the cache entry', () => {
    const PATH = '/corpus/slug/grown.jsonl';
    const h = makeByteFs({ [PATH]: '{"ok":1}\n' }); // 9 bytes
    const fs = createTailCachingFs(h.fs, { overlapBytes: 4 });
    expect(fs.readFileConfined(PATH, CAP)).toBe(h.truth(PATH));

    // The file grows past the cap: the inner OversizeError surfaces as-is.
    h.set(PATH, `${'x'.repeat(CAP)}\n`);
    expect(() => fs.readFileConfined(PATH, CAP)).toThrow(OversizeError);

    // And the entry is gone: the healed file is read from byte 0, not from the
    // stale offset 5 a kept entry would have probed.
    h.set(PATH, '{"ok":2}\n');
    expect(fs.readFileConfined(PATH, CAP)).toBe('{"ok":2}\n');
    expect(h.tailCalls.map((call) => call.fromByte)).toEqual([0, 5, 0]);
  });

  it('non-.jsonl reads pass straight through to the inner full read', () => {
    const META = '/corpus/slug/meta.json';
    const h = makeByteFs({ [META]: '{"meta":true}' });
    const fs = createTailCachingFs(h.fs);

    expect(fs.readFileConfined(META, CAP)).toBe('{"meta":true}');
    expect(h.fullReads()).toBe(1);
    expect(h.tailCalls).toEqual([]);
  });

  it('readDirNames, lstat, realpath and the tail primitive delegate untouched', () => {
    const PATH = '/corpus/slug/cccc.jsonl';
    const h = makeByteFs({ [PATH]: 'x\n' });
    const fs = createTailCachingFs(h.fs);

    expect(fs.readDirNames('/corpus')).toEqual(['from-inner']);
    expect(h.dirCalls).toEqual(['/corpus']);
    expect(fs.lstat(PATH)).toEqual({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      sizeBytes: 7,
      mtimeMs: 3,
    });
    expect(fs.realpath('/x')).toBe('real:/x');
    const tail = fs.readFileTailConfined(PATH, 1, CAP);
    expect(tail.sizeBytes).toBe(2);
    expect(tail.data).toEqual(encoder.encode('\n'));
  });

  it('a file with no newline caches nothing but still answers correctly', () => {
    const PATH = '/corpus/slug/headless.jsonl';
    const h = makeByteFs({ [PATH]: '{"torn":tru' });
    const fs = createTailCachingFs(h.fs);

    expect(fs.readFileConfined(PATH, CAP)).toBe('{"torn":tru');
    expect(fs.readFileConfined(PATH, CAP)).toBe('{"torn":tru');

    // The cached complete-line region is empty, so every read starts at byte 0
    // and the whole content stays torn remainder, re-decoded each time.
    expect(h.tailCalls.map((call) => call.fromByte)).toEqual([0, 0]);
  });

  it('exposes the PROVISIONAL defaults for the composition root', () => {
    expect(OVERLAP_BYTES).toBe(4096);
    expect(MAX_CACHE_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_CACHE_ENTRIES).toBe(512);
  });
});
