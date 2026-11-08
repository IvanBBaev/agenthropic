/**
 * R14 / DAT-3 — the per-file corpus read cap is configuration.
 *
 * The first real-corpus boot skipped five main transcripts of 79-170 MB under
 * the old hard-coded 64 MiB cap. The default is now 256 MiB and
 * `DASHBOARD_MAX_FILE_MIB` overrides it. Two things must hold:
 *  - the variable parses strictly, with a ceiling under V8's string limit;
 *  - the composition root hands the SAME cap to both corpus readers (the
 *    watcher and the cost-analysis provider). A reader left on the default
 *    would read a session the other one reports as partial.
 * The second is proven by recording the `maxBytes` every read carries below
 * the shared tail-caching decorator. All data is synthetic.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFixture } from '@agenthropic/test-fixtures';
import { loadConfig, MAX_FILE_MIB_CEILING } from '../src/config';
import { DEFAULT_MAX_FILE_BYTES } from '../src/corpus/fs-port';
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { start } from '../src/index';
import { TEST_TOKEN } from './helpers';
import type { CorpusFs } from '../src/corpus/index';
import type { TailCacheOptions } from '../src/corpus/tail-cache';

const MIB = 1024 * 1024;

/** Hoisted so the `vi.mock` factory (which runs before imports) can reach it. */
const recorder = vi.hoisted(() => ({
  reads: [] as Array<{ readonly absPath: string; readonly maxBytes: number }>,
}));

vi.mock('../src/corpus/tail-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/corpus/tail-cache')>();
  return {
    ...actual,
    createTailCachingFs(inner: CorpusFs, options?: TailCacheOptions): CorpusFs {
      const recording: CorpusFs = {
        readDirNames: (absDir) => inner.readDirNames(absDir),
        lstat: (absPath) => inner.lstat(absPath),
        realpath: (absPath) => inner.realpath(absPath),
        readFileConfined: (absPath, maxBytes) => {
          recorder.reads.push({ absPath, maxBytes });
          return inner.readFileConfined(absPath, maxBytes);
        },
        readFileTailConfined: (absPath, fromByte, maxBytes) => {
          recorder.reads.push({ absPath, maxBytes });
          return inner.readFileTailConfined(absPath, fromByte, maxBytes);
        },
      };
      return actual.createTailCachingFs(recording, options);
    },
  };
});

describe('DASHBOARD_MAX_FILE_MIB', () => {
  const load = (raw: string | undefined): number =>
    loadConfig({ DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_MAX_FILE_MIB: raw }).maxFileBytes;

  it('defaults to 256 MiB when unset or empty', () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(256 * MIB);
    expect(load(undefined)).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(load('')).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it('takes whole MiB up to the ceiling', () => {
    expect(load('1')).toBe(MIB);
    expect(load('64')).toBe(64 * MIB);
    expect(load(String(MAX_FILE_MIB_CEILING))).toBe(MAX_FILE_MIB_CEILING * MIB);
  });

  it('keeps the ceiling under the V8 string limit (2^29 - 24 chars)', () => {
    expect(MAX_FILE_MIB_CEILING * MIB).toBeLessThanOrEqual(2 ** 29 - 24);
  });

  it.each(['0', '-1', '1.5', '0x10', ' 8', 'big', String(MAX_FILE_MIB_CEILING + 1)])(
    'refuses %j',
    (raw) => {
      expect(() => load(raw)).toThrow(/Invalid DASHBOARD_MAX_FILE_MIB/);
    },
  );
});

describe('both corpus readers get the configured cap', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    recorder.reads.length = 0;
    vi.restoreAllMocks();
  });

  it('the boot replay and a cost-analysis request read with DASHBOARD_MAX_FILE_MIB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-max-file-'));
    dirs.push(dir);
    const corpusRoot = join(dir, 'projects');
    const dbPath = join(dir, 'agent.db');
    const slug = '-Users-synthetic-max-file-project';

    // Prices first, so the replay ingests the session and the route answers 200.
    const seed = openDatabase(dbPath);
    runMigrations(seed);
    const insertPrice = seed.prepare(
      'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, 1, ?)',
    );
    for (const bucket of ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h']) {
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
      const abs = join(corpusRoot, slug, rel);
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
      DASHBOARD_MAX_FILE_MIB: '3',
    });
    try {
      const mainSuffix = join(slug, `${sessionId}.jsonl`);
      // The watcher's boot replay read the transcript with the configured cap.
      const bootReads = recorder.reads.filter((r) => r.absPath.endsWith(mainSuffix));
      expect(bootReads).not.toHaveLength(0);

      recorder.reads.length = 0;
      const response = await server.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/cost-analysis`,
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      // ...and so did the provider, on the request path.
      const requestReads = recorder.reads.filter((r) => r.absPath.endsWith(mainSuffix));
      expect(requestReads).not.toHaveLength(0);

      for (const read of [...bootReads, ...requestReads]) {
        expect(read.maxBytes).toBe(3 * MIB);
      }
    } finally {
      await server.close();
    }
  });
});
