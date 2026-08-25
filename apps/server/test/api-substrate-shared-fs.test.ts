/**
 * M-18 residue — the cost-analysis substrate provider must read the corpus
 * through the WATCHER'S tail-caching {@link CorpusFs}, not a bare adapter of
 * its own.
 *
 * The tail cache (M-15) keys its byte offsets per DECORATOR INSTANCE, so a
 * provider holding its own instance shares nothing: every cost-analysis click
 * re-read the whole transcript (synchronously, up to the 64 MiB cap) even
 * though the watcher had just read the same bytes. That is invisible to any
 * black-box assertion — the ANSWER is identical either way — so this test
 * observes the composition instead: `createTailCachingFs` is intercepted and
 * its INNER fs is wrapped in a recorder, which makes every read that passes
 * through a decorator visible by path.
 *
 * The proof is binary. With one shared instance, the reads a cost-analysis
 * request performs appear at the recorder; with a second, private
 * `nodeCorpusFs()` inside the provider (the pre-fix shape) the recorder would
 * see nothing at all during the request, because that adapter is not wrapped.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFixture } from '@agenthropic/test-fixtures';
// vi.mock is hoisted above these imports, so `start` below already resolves
// the intercepted tail-cache module.
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { start } from '../src/index';
import { TEST_TOKEN } from './helpers';
import type { CorpusFs } from '../src/corpus/index';
import type { TailCacheOptions } from '../src/corpus/tail-cache';

/** Hoisted so the `vi.mock` factory (which runs before imports) can reach it. */
const recorder = vi.hoisted(() => ({
  /** How many tail-caching decorators the composition root built. */
  instances: 0,
  /** Every read that reached the fs UNDER a decorator, in order. */
  calls: [] as Array<{ readonly op: 'full' | 'tail'; readonly absPath: string }>,
}));

vi.mock('../src/corpus/tail-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/corpus/tail-cache')>();
  return {
    ...actual,
    createTailCachingFs(inner: CorpusFs, options?: TailCacheOptions): CorpusFs {
      recorder.instances += 1;
      const recording: CorpusFs = {
        readDirNames: (absDir) => inner.readDirNames(absDir),
        lstat: (absPath) => inner.lstat(absPath),
        realpath: (absPath) => inner.realpath(absPath),
        readFileConfined: (absPath, maxBytes) => {
          recorder.calls.push({ op: 'full', absPath });
          return inner.readFileConfined(absPath, maxBytes);
        },
        readFileTailConfined: (absPath, fromByte, maxBytes) => {
          recorder.calls.push({ op: 'tail', absPath });
          return inner.readFileTailConfined(absPath, fromByte, maxBytes);
        },
      };
      return actual.createTailCachingFs(recording, options);
    },
  };
});

const SLUG = '-Users-synthetic-shared-fs-project';
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

describe('substrate provider shares the watcher tail cache (M-18)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    recorder.instances = 0;
    recorder.calls.length = 0;
    vi.restoreAllMocks();
  });

  it('a cost-analysis request reads the transcript through the watcher instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-shared-fs-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    const dbPath = join(dir, 'agent.db');

    // Prices first: without them the boot replay halts the session and the
    // route would answer 422 instead of exercising the read path.
    const seed = openDatabase(dbPath);
    runMigrations(seed);
    const insertPrice = seed.prepare(
      'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, 1, ?)',
    );
    for (const bucket of BUCKETS) {
      insertPrice.run('synthetic-model-a', bucket, '2020-01-01T00:00:00.000Z');
      insertPrice.run('synthetic-model-b', bucket, '2020-01-01T00:00:00.000Z');
    }
    seed.close();

    const fixture = getFixture('flat-tool-use');
    const main = fixture.files.find((f) => !f.relativePath.includes('/'));
    if (main === undefined) {
      throw new Error('fixture layout changed; update this test');
    }
    const sessionId = main.relativePath.slice(0, -'.jsonl'.length);
    for (const f of fixture.files) {
      const rel = f.relativePath.includes('/')
        ? join(sessionId, ...f.relativePath.split('/'))
        : f.relativePath;
      const abs = join(corpusRoot, SLUG, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.lines.join('\n') + '\n');
    }

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = await start({
      DASHBOARD_TOKEN: TEST_TOKEN,
      DASHBOARD_PORT: '0',
      DASHBOARD_DB_PATH: dbPath,
      CLAUDE_PROJECTS_DIR: corpusRoot,
      DASHBOARD_POLL_INTERVAL_MS: '600000', // park the poll loop; the boot replay is the tick
    });
    try {
      // Matched by suffix: the corpus root is realpath'd during resolution, and
      // on macOS the temp dir resolves through /private.
      const mainSuffix = join(SLUG, `${sessionId}.jsonl`);
      const isMainTranscript = (call: { readonly absPath: string }): boolean =>
        call.absPath.endsWith(mainSuffix);
      // ONE decorator for the whole process: the watcher and the provider
      // cannot be holding different caches.
      expect(recorder.instances).toBe(1);
      // The boot replay already warmed that one cache with this transcript.
      expect(recorder.calls.some(isMainTranscript)).toBe(true);

      recorder.calls.length = 0;
      const response = await server.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/cost-analysis`,
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);

      // The load-bearing assertion: the request's transcript read passed
      // through the SAME decorator the watcher warmed. A provider with its own
      // unwrapped adapter would leave this list empty.
      expect(recorder.calls).not.toHaveLength(0);
      // ...and it arrived as a TAIL read. `readFileConfined` on the inner fs is
      // the decorator's non-jsonl passthrough (the `.meta.json` sidecars), so a
      // full read of a `.jsonl` here would mean the transcript bypassed the
      // cache path entirely.
      expect(recorder.calls.some((call) => call.op === 'tail' && isMainTranscript(call))).toBe(
        true,
      );
      expect(
        recorder.calls.filter((call) => call.op === 'full' && call.absPath.endsWith('.jsonl')),
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
