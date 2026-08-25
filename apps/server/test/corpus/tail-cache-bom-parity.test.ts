/**
 * Regression guard for the ONE promise {@link createTailCachingFs} makes: a
 * cached read must equal the read the bare adapter would have returned.
 *
 * Why this file exists next to `tail-cache.test.ts` instead of inside it: that
 * suite's equivalence oracle is `new TextDecoder().decode(bytes)` — the exact
 * call the decorator itself used. An oracle built from the implementation under
 * test cannot fail when the implementation is wrong, and it did not: the
 * decorator decoded with the default `ignoreBOM: false`, which DELETES a leading
 * U+FEFF, while the production port reads with `readFileSync(fd, 'utf8')`, which
 * keeps it. Both sides of that assertion dropped the BOM and agreed.
 *
 * So the oracle here is the real {@link nodeCorpusFs} against a real file. That
 * is the whole point — this is the only way to observe the divergence, and the
 * divergence was not cosmetic: the watcher reads through the cache and ingests a
 * BOM-led transcript fine, while every `/api/*` route builds its own bare
 * `nodeCorpusFs()` and threw a `SubstrateError` on the same bytes, 500-ing that
 * session's reads permanently. A one-character disagreement, one seam apart.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeCorpusFs } from '../../src/corpus/node-corpus-fs';
import { createTailCachingFs } from '../../src/corpus/tail-cache';

const CAP = 64 * 1024;
const BOM = '﻿';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agenthropic-tail-bom-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes `content` verbatim — no BOM handling of any kind on the way in. */
function write(name: string, content: string): string {
  const abs = join(root, name);
  writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('tail cache / bare adapter parity on a leading BOM', () => {
  it('preserves a BOM exactly as the bare adapter does, on the cold read', () => {
    const abs = write('session.jsonl', `${BOM}{"type":"user"}\n`);
    const bare = nodeCorpusFs();
    const cached = createTailCachingFs(nodeCorpusFs());

    const truth = bare.readFileConfined(abs, CAP);

    // The premise: the port really does hand the BOM through. If this ever
    // stops being true the decorator should follow it, not this test.
    expect(truth.startsWith(BOM)).toBe(true);
    expect(cached.readFileConfined(abs, CAP)).toBe(truth);
  });

  it('still matches after an append, when the read is served incrementally', () => {
    const abs = write('session.jsonl', `${BOM}{"type":"user"}\n`);
    const bare = nodeCorpusFs();
    const cached = createTailCachingFs(nodeCorpusFs());

    // Prime the cache, then grow the file the way a live transcript writer does.
    cached.readFileConfined(abs, CAP);
    writeFileSync(abs, `${BOM}{"type":"user"}\n{"type":"assistant"}\n`, 'utf8');

    const truth = bare.readFileConfined(abs, CAP);
    expect(truth.startsWith(BOM)).toBe(true);
    // The tail path stitches cached head + fresh tail; the BOM lives in the head,
    // so a decoder that ate it on the cold read would still be missing it here.
    expect(cached.readFileConfined(abs, CAP)).toBe(truth);
  });

  it('leaves a BOM-less file byte-identical too (no BOM is ever added)', () => {
    const abs = write('plain.jsonl', '{"type":"user"}\n');
    const bare = nodeCorpusFs();
    const cached = createTailCachingFs(nodeCorpusFs());

    const truth = bare.readFileConfined(abs, CAP);
    expect(truth.startsWith(BOM)).toBe(false);
    expect(cached.readFileConfined(abs, CAP)).toBe(truth);
  });

  it('matches on a non-.jsonl sidecar, which passes straight through', () => {
    const abs = write('agent-abc.meta.json', `${BOM}{"toolUseId":"t1"}`);
    const bare = nodeCorpusFs();
    const cached = createTailCachingFs(nodeCorpusFs());

    expect(cached.readFileConfined(abs, CAP)).toBe(bare.readFileConfined(abs, CAP));
  });
});
