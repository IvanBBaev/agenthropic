/**
 * Review L-4 — the runner's pre-write session-identity cross-check.
 *
 * A transcript's session id exists twice on disk: in the FILE NAME the
 * enumerator keys its ref on, and in the RECORDS the writer keys every row on.
 * Copy or rename a transcript and those two disagree — the copy's records still
 * name the original session, so ingesting it upserts the original's agents from
 * a second file, re-fires its dispatch events, and does so again every tick.
 * M-14's `duplicate-session` guard does NOT cover this: it dedupes on the file
 * name, which a renamed copy has changed.
 *
 * Two layers, mirroring the main runner suite:
 *  - LAYER A drives the fold with an injected ingest stub, proving the mismatch
 *    is refused BEFORE the writer is called (an after-the-fact check on the
 *    outcome would be too late — the rows would already be fused) and that the
 *    failure is keyed on the ENUMERATED ref id, which is what the watcher's
 *    retry / quarantine bookkeeping matches failures against.
 *  - LAYER B runs the REAL ingestSession over a real migrated database with a
 *    genuine copy of a fixture transcript beside the original, and asserts the
 *    original's row counts are exactly what the original alone produces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PricingEntry, parseSession } from '@agenthropic/core';
import { getFixture } from '@agenthropic/test-fixtures';
import {
  runCorpusIngest,
  SESSION_ID_MISMATCH_REASON,
  type CorpusIngestDeps,
  type IngestFn,
} from '../../src/corpus/ingest-corpus';
import { loadPricing } from '../../src/db/pricing';
import type { IngestOutcome } from '../../src/ingest/ingest-session';
import { createMigratedTempDb, type TempDb } from '../helpers';
import { dir, file, makeFakeCorpusFs, type NodeSpec, type TreeSpec } from './fake-corpus-fs';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-project-alpha';
const ORIGINAL = 'aaaaaaaa-1111-4111-8111-111111111111';
const COPY = 'cccccccc-3333-4333-8333-333333333333';
const FIXED_NOW = '2026-07-11T00:00:00.000Z';
const JSONL_SUFFIX = '.jsonl';

const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

/** Prices for the fixture's synthetic models, effective before every timestamp. */
const SYNTHETIC_PRICING: readonly PricingEntry[] = [
  'synthetic-model-a',
  'synthetic-model-b',
].flatMap((model): PricingEntry[] =>
  BUCKETS.map((bucket) => ({ model, bucket, usdPerMtok: 1, effectiveFrom: '2020-01-01' })),
);

function count(temp: TempDb, sql: string, ...params: readonly string[]): number {
  const row = temp.db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

/** A one-line main transcript whose record DECLARES `sessionId`. */
function mainBody(sessionId: string): string {
  return (
    JSON.stringify({
      sessionId,
      type: 'user',
      timestamp: '2026-07-10T00:00:00.000Z',
      message: { role: 'user', content: 'go' },
    }) + '\n'
  );
}

/** An ok outcome with every counter zeroed — Layer A never reaches real rows. */
function okOutcome(sessionId: string): IngestOutcome {
  return {
    ok: true,
    sessionId,
    costUsd: 0,
    agentsUpserted: 0,
    edgesInserted: 0,
    usageRowsInserted: 0,
    statusReconciliations: [],
    crossSessionUsageCollisions: 0,
    error: null,
  };
}

/** Records the main transcript path of every substrate handed to the writer. */
function recorder(seen: string[]): IngestFn {
  return (substrate): IngestOutcome => {
    seen.push(substrate.files[0]?.relativePath ?? '<empty>');
    return okOutcome(ORIGINAL);
  };
}

describe('runCorpusIngest — session identity cross-check (review L-4)', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function makeDeps(overrides: Partial<CorpusIngestDeps> = {}): CorpusIngestDeps {
    return {
      db: temp.db,
      pricing: [],
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      now: () => FIXED_NOW,
      ...overrides,
    };
  }

  // --- Layer A: refused before the writer -----------------------------------

  it('refuses a renamed copy BEFORE calling ingest, and still ingests the original', () => {
    const fs = makeFakeCorpusFs(ROOT, {
      [SLUG]: dir({
        [`${ORIGINAL}${JSONL_SUFFIX}`]: file(mainBody(ORIGINAL)),
        // The renamed copy: a different file name, the SAME records.
        [`${COPY}${JSONL_SUFFIX}`]: file(mainBody(ORIGINAL)),
      }),
    });
    const seen: string[] = [];

    const summary = runCorpusIngest(makeDeps({ fs, ingest: recorder(seen) }));

    expect(summary.sessionsDiscovered).toBe(2);
    expect(summary.sessionsOk).toBe(1);
    expect(summary.sessionsFailed).toBe(1);
    expect(summary.sessionsSkipped).toBe(0);
    // The writer saw the original ONLY — the refusal is upstream of ingest.
    expect(seen).toEqual([`${ORIGINAL}${JSONL_SUFFIX}`]);

    expect(summary.failures).toHaveLength(1);
    const failure = summary.failures[0]!;
    // Keyed on the ENUMERATED id (the file name), which is what the watcher
    // matches failures against when it settles retry budgets.
    expect(failure.sessionId).toBe(COPY);
    expect(failure.projectSlug).toBe(SLUG);
    expect(failure.error).toContain(SESSION_ID_MISMATCH_REASON);
    expect(failure.error).toContain(`"${COPY}${JSONL_SUFFIX}"`);
    expect(failure.error).toContain(`"${ORIGINAL}"`);
  });

  it('ingests a session whose records agree with its file name', () => {
    const fs = makeFakeCorpusFs(ROOT, {
      [SLUG]: dir({ [`${ORIGINAL}${JSONL_SUFFIX}`]: file(mainBody(ORIGINAL)) }),
    });
    const seen: string[] = [];

    const summary = runCorpusIngest(makeDeps({ fs, ingest: recorder(seen) }));

    expect(summary.sessionsOk).toBe(1);
    expect(summary.sessionsFailed).toBe(0);
    expect(summary.failures).toEqual([]);
    expect(seen).toEqual([`${ORIGINAL}${JSONL_SUFFIX}`]);
  });

  it('abstains (ingests exactly as before) when no record declares a sessionId', () => {
    // A substrate that declares nothing is not a DISAGREEMENT. The parser is the
    // component that judges such a transcript, loudly and on its own terms; the
    // pre-flight check must not pre-empt it with a second, cheaper verdict.
    const fs = makeFakeCorpusFs(ROOT, {
      [SLUG]: dir({ [`${ORIGINAL}${JSONL_SUFFIX}`]: file('{"type":"user"}\nnot json {\n') }),
    });
    const seen: string[] = [];

    const summary = runCorpusIngest(makeDeps({ fs, ingest: recorder(seen) }));

    expect(summary.sessionsOk).toBe(1);
    expect(summary.sessionsFailed).toBe(0);
    expect(seen).toEqual([`${ORIGINAL}${JSONL_SUFFIX}`]);
  });

  // --- Layer B: no rows fuse, over the real ingestSession --------------------

  describe('end-to-end over the real ingestSession', () => {
    type MutableTree = Record<string, NodeSpec>;

    /** Insert one file at `segments` (creating intermediate `dir` nodes) into `tree`. */
    function addFile(tree: MutableTree, segments: readonly string[], content: string): void {
      const head = segments[0]!;
      if (segments.length === 1) {
        tree[head] = file(content);
        return;
      }
      let node = tree[head];
      if (node === undefined || node.type !== 'dir') {
        node = dir({});
        tree[head] = node;
      }
      addFile(node.children as MutableTree, segments.slice(1), content);
    }

    it('keeps a copied transcript out of the original session rows', () => {
      const fixture = getFixture('flat-tool-use');
      const main = fixture.files.find((f) => !f.relativePath.includes('/'))!;
      const sessionId = main.relativePath.slice(0, -JSONL_SUFFIX.length);
      const expected = parseSession(fixture);
      expect(sessionId).toBe(expected.sessionId);

      // Lay the fixture out the way Claude Code does, then drop a byte-identical
      // copy of the main transcript beside it under a fresh uuid.
      const slug: MutableTree = {};
      for (const f of fixture.files) {
        const segments = f.relativePath.includes('/')
          ? [sessionId, ...f.relativePath.split('/')]
          : [f.relativePath];
        addFile(slug, segments, f.lines.join('\n') + '\n');
      }
      addFile(slug, [`${COPY}${JSONL_SUFFIX}`], main.lines.join('\n') + '\n');
      const tree: TreeSpec = { [SLUG]: dir(slug) };

      const summary = runCorpusIngest({
        db: temp.db,
        pricing: [...loadPricing(temp.db), ...SYNTHETIC_PRICING],
        env: { CLAUDE_PROJECTS_DIR: ROOT },
        fs: makeFakeCorpusFs(ROOT, tree),
        now: () => FIXED_NOW,
      });

      expect(summary.sessionsDiscovered).toBe(2);
      expect(summary.sessionsOk).toBe(1);
      expect(summary.sessionsFailed).toBe(1);
      expect(summary.failures[0]?.sessionId).toBe(COPY);
      expect(summary.failures[0]?.error).toContain(SESSION_ID_MISMATCH_REASON);

      // Exactly one session row, and the original's counts are what the original
      // alone produces: the copy fused nothing onto it.
      expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1);
      expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions WHERE id = ?', sessionId)).toBe(1);
      expect(count(temp, 'SELECT COUNT(*) AS n FROM agents WHERE session_id = ?', sessionId)).toBe(
        expected.agents.length,
      );
      expect(
        count(temp, 'SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ?', sessionId),
      ).toBe(expected.usage.length * 5);
      expect(count(temp, 'SELECT COUNT(*) AS n FROM sessions WHERE id = ?', COPY)).toBe(0);
    });
  });
});
