/**
 * A checkpoint may change ingest WORK, never ingest RESULTS. A session whose
 * build could not read one of its files (EIO, EACCES, EMFILE...) was ingested
 * without that file's content, yet its fingerprint - which lstat()s the file
 * and so already includes it - was checkpointed. A restart then trusted the
 * checkpoint and never re-read the file, although a restart WITHOUT the
 * checkpoint store would have recovered it. The same holds one probe earlier:
 * a file whose LSTAT fails (not ENOENT) during the build is unread, not gone.
 */
import type { SessionSubstrate } from '@agenthropic/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorpusFs, SkippedFile } from '../src/corpus/fs-port';
import type { IngestFn } from '../src/corpus/ingest-corpus';
import { createReplayCheckpointStore } from '../src/db/replay-checkpoints';
import { upsertSession } from '../src/db/sessions';
import { createCorpusWatcher, type CorpusWatcherDeps } from '../src/ingest/corpus-watcher';
import type { IngestOutcome } from '../src/ingest/ingest-session';
import { dir, file, makeFakeCorpusFs, type NodeSpec } from './corpus/fake-corpus-fs';
import { createMigratedTempDb, type TempDb } from './helpers';
import { HUGE_WATCHDOG_MS } from './p0/harness';

const ROOT = '/fake/corpus';
const SLUG = '-Users-synthetic-lane-e-project';
const SESSION = 'eeeeeeee-1111-4111-8111-111111111111';
const AGENT = 'subagents/agent-abc123.jsonl';

describe('replay checkpoint vs. a file the build could not read', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function tree(agentThrow?: string, agentLstatThrow?: string): Record<string, NodeSpec> {
    const agent = file('{"a":1}\n', {
      size: 8,
      mtimeMs: 5,
      ...(agentThrow === undefined ? {} : { throwCode: agentThrow }),
      ...(agentLstatThrow === undefined ? {} : { throwLstat: agentLstatThrow }),
    });
    return {
      [`${SESSION}.jsonl`]: file('{"main":true}\n', { size: 14, mtimeMs: 1 }),
      [SESSION]: dir({ subagents: dir({ 'agent-abc123.jsonl': agent }) }),
    };
  }

  /** Records every substrate it is handed and projects the session row. */
  function ingest(seen: string[][]): IngestFn {
    return (substrate: SessionSubstrate): IngestOutcome => {
      seen.push(substrate.files.map((f) => f.relativePath));
      upsertSession(temp.db, {
        id: SESSION,
        projectSlug: SLUG,
        startedAt: '2026-07-11T00:00:00Z',
        lastActivityAt: '2026-07-11T00:00:00Z',
        status: 'working',
      });
      return {
        ok: true,
        sessionId: SESSION,
        costUsd: 0,
        agentsUpserted: 0,
        edgesInserted: 0,
        usageRowsInserted: 0,
        statusReconciliations: [],
        crossSessionUsageCollisions: 0,
        error: null,
      };
    };
  }

  function deps(
    slugTree: Record<string, NodeSpec>,
    seen: string[][],
    extra: { fs?: CorpusFs; warnings?: SkippedFile[] } = {},
  ): CorpusWatcherDeps {
    return {
      db: temp.db,
      pricing: [],
      env: { CLAUDE_PROJECTS_DIR: ROOT },
      intervalMs: 1000,
      watchdogThresholdMs: HUGE_WATCHDOG_MS,
      fs: extra.fs ?? makeFakeCorpusFs(ROOT, { [SLUG]: dir(slugTree) }),
      nowMs: () => Date.parse('2026-07-12T00:00:00Z'),
      ingest: ingest(seen),
      checkpoints: createReplayCheckpointStore(temp.db, { now: () => '2026-07-12T00:00:00.000Z' }),
      onWarning: (skipped) => extra.warnings?.push(skipped),
    };
  }

  function checkpointedSessions(): string[] {
    return [...createReplayCheckpointStore(temp.db).load(ROOT).keys()];
  }

  it('does not checkpoint the session, so a restart re-reads the recovered file', () => {
    const first: string[][] = [];
    createCorpusWatcher(deps(tree('EIO'), first)).tick();
    expect(first).toEqual([[`${SESSION}.jsonl`]]); // the agent file was lost this pass

    // Restart, same bytes on disk (size and mtime unchanged), the read now works.
    const second: string[][] = [];
    createCorpusWatcher(deps(tree(), second)).tick();
    expect(second).toEqual([[`${SESSION}.jsonl`, AGENT]]);
  });

  // The same defect one probe earlier: an agent file whose LSTAT fails (the
  // parent lost its search bit, a bad inode) is not "gone", yet the build used
  // to treat every lstat error as a TOCTOU vanish — main-only ingest, nothing
  // in `skipped`, so the watcher checkpointed the session as complete.
  it('reports an agent whose lstat fails as unreadable and does not checkpoint the session', () => {
    const first: string[][] = [];
    const warnings: SkippedFile[] = [];
    createCorpusWatcher(deps(tree(undefined, 'EACCES'), first, { warnings })).tick();
    expect(first).toEqual([[`${SESSION}.jsonl`]]); // the agent file was lost this pass
    expect(warnings).toContainEqual({ relativePath: AGENT, reason: 'unreadable', code: 'EACCES' });
    expect(checkpointedSessions()).toEqual([]);

    // Restart, the probe now works: the file must be read, not trusted as done.
    const second: string[][] = [];
    createCorpusWatcher(deps(tree(), second)).tick();
    expect(second).toEqual([[`${SESSION}.jsonl`, AGENT]]);
  });

  // The strict mirror of the read-fault case above: the FINGERPRINT's probe
  // succeeds (so the fingerprint already includes the agent file and is
  // identical across both runs), only the BUILD's probe of the same path fails.
  // Whether the restart re-reads the file is then decided by the checkpoint
  // alone — exactly the seam this file guards.
  it('does not checkpoint a session whose build probe (not its fingerprint probe) failed', () => {
    const inner = makeFakeCorpusFs(ROOT, { [SLUG]: dir(tree()) });
    const agentAbs = `${ROOT}/${SLUG}/${SESSION}/${AGENT}`;
    let agentProbes = 0;
    const flaky: CorpusFs = {
      ...inner,
      lstat(absPath) {
        if (absPath === agentAbs && ++agentProbes === 2) {
          const err = new Error(`lstat failed: ${absPath}`) as Error & { code?: string };
          err.code = 'EACCES';
          throw err;
        }
        return inner.lstat(absPath);
      },
    };

    const first: string[][] = [];
    createCorpusWatcher(deps(tree(), first, { fs: flaky })).tick();
    expect(agentProbes).toBe(2); // one fingerprint probe, one build probe
    expect(first).toEqual([[`${SESSION}.jsonl`]]);
    expect(checkpointedSessions()).toEqual([]);

    const second: string[][] = [];
    createCorpusWatcher(deps(tree(), second)).tick();
    expect(second).toEqual([[`${SESSION}.jsonl`, AGENT]]);
  });

  it('still checkpoints a session whose only skip is not a read failure', () => {
    const withStray = { ...tree() };
    withStray[SESSION] = dir({
      subagents: dir({
        'agent-abc123.jsonl': file('{"a":1}\n', { size: 8, mtimeMs: 5 }),
        'notes.txt': file('x', { size: 1, mtimeMs: 5 }),
      }),
    });
    createCorpusWatcher(deps(withStray, [])).tick();

    const second: string[][] = [];
    createCorpusWatcher(deps(withStray, second)).tick();
    expect(second).toEqual([]);
  });

  it('still checkpoints a session whose build read every file', () => {
    createCorpusWatcher(deps(tree(), [])).tick();

    const second: string[][] = [];
    createCorpusWatcher(deps(tree(), second)).tick();
    expect(second).toEqual([]);
  });
});
